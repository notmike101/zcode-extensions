import type {
  ExtensionCapability,
  ExtensionDisposable,
  ExtensionHostCapabilities,
  ExtensionManifest,
  ExtensionZCodeApi,
  ModelCallSource,
  ModelRequestEvent,
  ModelRequestHistory,
  ModelRequestRecord,
  ModelTokenUsage,
  ZCodeMessage,
  ZCodeSessionEvent,
  ZCodeStreamEnvelope,
  ZCodeSubscriptionTarget,
} from "../../sdk/index.ts";
import {KNOWN_ZCODE_SESSION_EVENTS, UI_CONTRIBUTION_SLOTS} from "../../sdk/index.ts";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import path from "node:path";
import type {TaskService} from "./task-service.ts";
import type {ZCodeGateway} from "./zcode-gateway.ts";

const LEGACY_CAPABILITIES: ExtensionCapability[] = [
  "zcode.workspaces.read",
  "zcode.tasks.run",
  "ui.pages",
];

type ExtensionServiceOptions = {
  gateway: ZCodeGateway;
  taskService: TaskService;
  hostVersion: string;
  zcodeVersion: string;
  resolveSessionTarget?: (sessionId: string) => {workspacePath: string; workspaceIdentity?: string; sessionId: string} | undefined;
};

type Track = <T extends ExtensionDisposable>(disposable: T) => T;

export class ExtensionZCodeService {
  readonly #options: ExtensionServiceOptions;

  constructor(options: ExtensionServiceOptions) {
    this.#options = options;
  }

  capabilities(manifest: ExtensionManifest): ExtensionHostCapabilities {
    const declared = manifest.capabilities ?? [];
    return {
      apiVersion: 1,
      hostVersion: this.#options.hostVersion,
      zcodeVersion: this.#options.zcodeVersion,
      declared,
      granted: manifest.capabilities ? [...declared] : [...LEGACY_CAPABILITIES],
      legacyDefaults: manifest.capabilities === undefined,
      uiSlots: [...UI_CONTRIBUTION_SLOTS],
      experimental: declared.some((capability) => capability.startsWith("experimental.")),
    };
  }

  has(manifest: ExtensionManifest, capability: ExtensionCapability): boolean {
    return this.capabilities(manifest).granted.includes(capability);
  }

  require(manifest: ExtensionManifest, capability: ExtensionCapability): void {
    if (!this.has(manifest, capability)) {
      throw new Error(`Extension ${manifest.id} must declare capability ${capability}`);
    }
  }

  createApi(manifest: ExtensionManifest, track: Track): ExtensionZCodeApi {
    const invoke = <T = unknown>(operation: string, payload?: unknown) => this.invoke<T>(manifest, operation, payload);
    const subscribe = <T>(stream: string, payload: unknown, listener: (value: T) => void) =>
      track(this.subscribe(manifest, stream, payload, listener));
    return {
      capabilities: () => Promise.resolve(this.capabilities(manifest)),
      readWorkspaceState: (workspacePath) => invoke("workspaces.readState", {workspacePath}),
      workspaces: {
        readState: (workspacePath) => invoke("workspaces.readState", {workspacePath}),
        readProviderRegistry: (payload) => invoke("workspaces.readProviderRegistry", payload),
        readDefaults: (payload) => invoke("workspaces.readDefaults", payload),
        subscribe: (payload, listener) => subscribe("workspaces.events", payload, listener),
      },
      sessions: {
        resolveTarget: (sessionId) => invoke("sessions.resolveTarget", {sessionId}),
        list: (payload) => invoke("sessions.list", payload),
        read: (payload) => invoke("sessions.read", payload),
        readMessages: (payload) => invoke("sessions.readMessages", payload),
        readEvents: (payload) => invoke("sessions.readEvents", payload),
        subscribe: (target, listener) => subscribe("sessions.events", target, listener),
        create: (payload) => invoke("sessions.create", payload),
        resume: (payload) => invoke("sessions.resume", payload),
        send: (payload) => invoke("sessions.send", payload),
        steer: (payload) => invoke("sessions.steer", payload),
        stop: (payload) => invoke("sessions.stop", payload),
        fork: (payload) => invoke("sessions.fork", payload),
        rewind: (payload) => invoke("sessions.rewind", payload),
        compact: (payload) => invoke("sessions.compact", payload),
        setGoal: (payload) => invoke("sessions.setGoal", payload),
        close: (payload) => invoke("sessions.close", payload),
        setModel: (payload) => invoke("sessions.setModel", payload),
        setThoughtLevel: (payload) => invoke("sessions.setThoughtLevel", payload),
        setMode: (payload) => invoke("sessions.setMode", payload),
        respondPermission: (payload) => invoke("sessions.respondPermission", payload),
        respondUserInput: (payload) => invoke("sessions.respondUserInput", payload),
        respondProviderHeaders: (payload) => invoke("sessions.respondProviderHeaders", payload),
      },
      tasks: {
        run: async (spec) => {
          this.require(manifest, "zcode.tasks.run");
          return this.#options.taskService.run(spec);
        },
        ensureVisible: async (spec) => {
          this.require(manifest, "zcode.tasks.run");
          return this.#options.taskService.ensureVisible(spec);
        },
        list: (payload) => invoke("tasks.list", payload),
        getMeta: (payload) => invoke("tasks.getMeta", payload),
        getSnapshot: (payload) => invoke("tasks.getSnapshot", payload),
        getSnapshotBody: (payload) => invoke("tasks.getSnapshotBody", payload),
        getSnapshotToolCalls: (payload) => invoke("tasks.getSnapshotToolCalls", payload),
        getConfigOptions: (payload) => invoke("tasks.getConfigOptions", payload),
        getTokenUsage: (payload) => invoke("tasks.getTokenUsage", payload),
        subscribe: (payload, listener) => subscribe("tasks.events", payload, listener),
        archive: (payload) => invoke("tasks.archive", payload),
        unarchive: (payload) => invoke("tasks.unarchive", payload),
        pin: (payload) => invoke("tasks.pin", payload),
        rename: (payload) => invoke("tasks.rename", payload),
        remove: (payload) => invoke("tasks.remove", payload),
        branch: (payload) => invoke("tasks.branch", payload),
        rewindTurn: (payload) => invoke("tasks.rewindTurn", payload),
        setUnread: (payload) => invoke("tasks.setUnread", payload),
      },
      models: {
        listProviders: (payload) => invoke("models.listProviders", payload),
        readDefaults: (payload) => invoke("models.readDefaults", payload),
        generateText: (payload) => invoke("models.generateText", payload),
      },
      mcp: {list: (payload) => invoke("mcp.list", payload)},
      usage: {
        listModelRequests: (payload) => invoke("usage.listModelRequests", payload),
        subscribeModelRequests: (target, listener) => subscribe("usage.modelRequests", target, listener),
      },
      broadcast: {
        send: (channel, payload) => invoke("broadcast.send", {channel, payload}),
        listen: (channel, listener) => subscribe("broadcast.events", {channel}, listener),
      },
      experimental: {
        channel: (name) => ({
          call: (command, payload) => invoke("experimental.call", {channel: name, command, payload}),
          listen: (event, payload, listener) => subscribe("experimental.listen", {channel: name, event, payload}, listener),
        }),
      },
    };
  }

  async invoke<T = unknown>(manifest: ExtensionManifest, operation: string, payload?: unknown): Promise<T> {
    switch (operation) {
      case "capabilities": return this.capabilities(manifest) as T;
      case "workspaces.readState": {
        this.require(manifest, "zcode.workspaces.read");
        return this.#options.taskService.readWorkspaceState(requiredString(payload, "workspacePath")) as Promise<T>;
      }
      case "workspaces.readProviderRegistry": return this.#workspaceProjection(manifest, payload, "providers") as Promise<T>;
      case "workspaces.readDefaults": return this.#workspaceProjection(manifest, payload, "defaults") as Promise<T>;
      case "sessions.resolveTarget": {
        this.require(manifest, "zcode.sessions.read");
        const sessionId = requiredString(payload, "sessionId");
        return (this.#options.resolveSessionTarget
          ? this.#options.resolveSessionTarget(sessionId)
          : this.#resolveSessionTarget(sessionId)) as T;
      }
      case "sessions.list": return this.#serviceCall(manifest, "zcode.sessions.read", "zcode-session", "listSessions", payload);
      case "sessions.read": return this.#serviceCall(manifest, "zcode.sessions.read", "zcode-session", "readSession", payload);
      case "sessions.readMessages": return this.#readSessionMessages(manifest, payload) as Promise<T>;
      case "sessions.readEvents": return this.#serviceCall(manifest, "zcode.sessions.read", "zcode-session", "readSessionEvents", payload);
      case "sessions.create": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "createSession", payload);
      case "sessions.resume": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "resumeSession", payload);
      case "sessions.send": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "sendPrompt", payload);
      case "sessions.steer": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "steerSession", payload);
      case "sessions.stop": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "stopSession", payload);
      case "sessions.fork": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "forkSession", payload);
      case "sessions.rewind": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "rewindSession", payload);
      case "sessions.compact": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "compactSession", payload);
      case "sessions.setGoal": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "goalSession", payload);
      case "sessions.close": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "closeSession", payload);
      case "sessions.setModel": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "setModel", payload);
      case "sessions.setThoughtLevel": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "setThoughtLevel", payload);
      case "sessions.setMode": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "setMode", payload);
      case "sessions.respondPermission": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "respondPermission", payload);
      case "sessions.respondUserInput": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "respondUserInput", payload);
      case "sessions.respondProviderHeaders": return this.#serviceCall(manifest, "zcode.sessions.write", "zcode-session", "respondProviderRuntimeHeaders", payload);
      case "tasks.ensureVisible": {
        this.require(manifest, "zcode.tasks.run");
        const value = requiredRecord(payload);
        return this.#options.taskService.ensureVisible({
          sessionId: requiredString(value, "sessionId"),
          workspacePath: requiredString(value, "workspacePath"),
          ...(typeof value.title === "string" ? {title: value.title} : {}),
        }) as Promise<T>;
      }
      case "tasks.list": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "listTasks", payload);
      case "tasks.getMeta": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "getTaskMeta", payload);
      case "tasks.getSnapshot": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "getTaskSnapshot", payload);
      case "tasks.getSnapshotBody": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "getTaskSnapshotBody", payload);
      case "tasks.getSnapshotToolCalls": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "getTaskSnapshotToolCallsSlice", payload);
      case "tasks.getConfigOptions": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "getTaskConfigOptions", payload);
      case "tasks.getTokenUsage": return this.#serviceCall(manifest, "zcode.tasks.read", "zcode-task", "getTaskTokenUsage", payload);
      case "tasks.archive": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "archiveTask", payload);
      case "tasks.unarchive": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "unarchiveTask", payload);
      case "tasks.pin": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "setTaskPinned", withDefault(payload, "pinned", true));
      case "tasks.rename": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "renameTask", payload);
      case "tasks.remove": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "deleteTask", payload);
      case "tasks.branch": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "branchTaskFromPrompt", payload);
      case "tasks.rewindTurn": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "rewindTurn", payload);
      case "tasks.setUnread": return this.#serviceCall(manifest, "zcode.tasks.write", "zcode-task", "setTaskUnread", payload);
      case "models.listProviders": return this.#workspaceProjection(manifest, payload, "providers", "zcode.models.read") as Promise<T>;
      case "models.readDefaults": return this.#workspaceProjection(manifest, payload, "defaults", "zcode.models.read") as Promise<T>;
      case "models.generateText": return this.#serviceCall(manifest, "zcode.models.generate", "zcode-session", "generateWorkspaceText", payload);
      case "mcp.list": return this.#serviceCall(manifest, "zcode.models.read", "zcode-session", "listMcpServerStatuses", payload);
      case "usage.listModelRequests": {
        this.require(manifest, "zcode.usage.read");
        const value = requiredRecord(payload);
        return this.#modelRequestHistory(requiredString(value, "sessionId"), optionalPositiveInteger(value.limit)) as Promise<T>;
      }
      case "broadcast.send": {
        this.require(manifest, "zcode.broadcast");
        const value = requiredRecord(payload);
        return this.#options.gateway.call("broadcast", "send", {channel: requiredString(value, "channel"), payload: value.payload}) as Promise<T>;
      }
      case "experimental.call": {
        this.require(manifest, "experimental.zcode.rpc");
        const value = requiredRecord(payload);
        return this.#options.gateway.call(requiredString(value, "channel"), requiredString(value, "command"), value.payload) as Promise<T>;
      }
      default: throw new Error(`Unknown ZCode extension operation: ${operation}`);
    }
  }

  subscribe<T>(manifest: ExtensionManifest, stream: string, payload: unknown, listener: (value: T) => void): ExtensionDisposable {
    if (stream === "sessions.events" || stream === "usage.modelRequests") {
      this.require(manifest, stream === "sessions.events" ? "zcode.sessions.events" : "zcode.usage.read");
      const target = sessionTarget(payload);
      return this.#options.gateway.subscribe("zcode-session", "onDynamicSessionEvent", {
        ...target,
        deliveryKind: target.deliveryKind ?? "desktop-continuous",
        includeSnapshot: target.includeSnapshot ?? true,
      }, (raw) => {
        const event = normalizeSessionEvent(raw, target.sessionId);
        if (!event) return;
        if (stream === "sessions.events") listener(event as T);
        else {
          const modelEvent = normalizeModelRequestEvent(event);
          if (modelEvent) listener(modelEvent as T);
        }
      });
    }
    if (stream === "tasks.events") {
      this.require(manifest, "zcode.tasks.read");
      return this.#options.gateway.subscribe("zcode-task", "onDynamicTaskEvent", payload, (raw) =>
        listener(normalizeStreamEnvelope("task", raw) as T));
    }
    if (stream === "workspaces.events") {
      this.require(manifest, "zcode.workspaces.read");
      return this.#options.gateway.subscribe("zcode-task", "onDynamicWorkspaceEvent", payload, (raw) =>
        listener(normalizeStreamEnvelope("workspace", raw) as T));
    }
    if (stream === "broadcast.events") {
      this.require(manifest, "zcode.broadcast");
      return this.#options.gateway.subscribe("broadcast", "onMessage", payload, (raw) =>
        listener(normalizeStreamEnvelope("broadcast", raw) as T));
    }
    if (stream === "experimental.listen") {
      this.require(manifest, "experimental.zcode.rpc");
      const value = requiredRecord(payload);
      return this.#options.gateway.subscribe(
        requiredString(value, "channel"),
        requiredString(value, "event"),
        value.payload,
        listener,
      );
    }
    throw new Error(`Unknown ZCode extension stream: ${stream}`);
  }

  async #serviceCall<T>(
    manifest: ExtensionManifest,
    capability: ExtensionCapability,
    channel: string,
    method: string,
    payload: unknown,
  ): Promise<T> {
    this.require(manifest, capability);
    const service = await this.#options.gateway.service<Record<string, unknown>>(channel);
    const callable = service[method];
    if (typeof callable !== "function") throw new Error(`ZCode ${channel} does not support ${method}`);
    return callable(payload ?? {}) as Promise<T>;
  }

  async #workspaceProjection(
    manifest: ExtensionManifest,
    payload: unknown,
    projection: "providers" | "defaults",
    capability: ExtensionCapability = "zcode.workspaces.read",
  ): Promise<unknown> {
    const state = requiredRecord(await this.#serviceCall(manifest, capability, "zcode-session", "readWorkspaceState", payload));
    if (projection === "providers") {
      const catalog = record(state.modelCatalog);
      return {
        providers: Array.isArray(catalog.providers) ? catalog.providers : [],
        registry: state.providerRegistry ?? state.modelCatalog ?? null,
      };
    }
    return {settings: record(state.settings), defaults: state.defaults ?? null};
  }

  async #modelRequestHistory(sessionId: string, limit?: number): Promise<ModelRequestHistory> {
    const service = await this.#options.gateway.service<Record<string, unknown>>("zcode-task");
    const callable = service.getModelTrajectory;
    if (typeof callable !== "function") return {sessionId, available: false, records: [], truncated: false};
    const raw = requiredRecord(await (callable as (payload: unknown) => Promise<unknown>)({taskId: sessionId, limit: limit ?? 500}));
    const records = Array.isArray(raw.records)
      ? raw.records.map((record) => sanitizeModelRequest(sessionId, record)).filter((record): record is ModelRequestRecord => Boolean(record))
      : [];
    return {
      sessionId,
      available: raw.available !== false,
      records,
      truncated: raw.truncated === true,
    };
  }

  async #readSessionMessages(manifest: ExtensionManifest, payload: unknown): Promise<ZCodeMessage[]> {
    const value = requiredRecord(payload);
    const workspacePath = requiredString(value, "workspacePath");
    const sessionId = requiredString(value, "sessionId");
    const workspaceIdentity = string(value.workspaceIdentity);
    const limit = optionalPositiveInteger(value.limit);
    const snapshot = requiredRecord(await this.#serviceCall(manifest, "zcode.sessions.read", "zcode-session", "readSession", {
      workspacePath,
      ...(workspaceIdentity ? {workspaceIdentity} : {}),
      sessionId,
      ...(limit ? {messageLimit: limit} : {}),
    }));
    const messages = (Array.isArray(snapshot.messages) ? snapshot.messages : [])
      .map(normalizeZCodeMessage)
      .filter((message): message is ZCodeMessage => Boolean(message));
    const afterMessageId = string(value.afterMessageId);
    if (afterMessageId) {
      const index = messages.findIndex((message) => message.messageId === afterMessageId || message.id === afterMessageId);
      const remaining = index >= 0 ? messages.slice(index + 1) : messages;
      return limit ? remaining.slice(0, limit) : remaining;
    }
    return limit ? messages.slice(-limit) : messages;
  }

  #resolveSessionTarget(sessionId: string): {workspacePath: string; workspaceIdentity?: string; sessionId: string} | undefined {
    const dataRoot = process.env.ZCODE_DATA_BASE_DIR?.trim() || process.env.HOME?.trim() || homedir();
    const databasePath = path.join(dataRoot, ".zcode", "v2", "tasks-index.sqlite");
    let database: {prepare(sql: string): {all(...values: unknown[]): unknown[]}; close(): void} | undefined;
    try {
      const {DatabaseSync} = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (filename: string, options: {readOnly: boolean}) => NonNullable<typeof database>;
      };
      database = new DatabaseSync(databasePath, {readOnly: true});
      const rows = database.prepare(`
        SELECT workspace_path, workspace_identity
        FROM tasks
        WHERE task_id = ? AND deleted = 0
        ORDER BY updated_at DESC
      `).all(sessionId) as Array<{workspace_path: string; workspace_identity: string | null}>;
      const distinct = new Map(rows.map((row) => [`${row.workspace_path}\0${row.workspace_identity ?? ""}`, row]));
      if (distinct.size !== 1) return undefined;
      const row = distinct.values().next().value!;
      return {
        workspacePath: row.workspace_path,
        ...(row.workspace_identity ? {workspaceIdentity: row.workspace_identity} : {}),
        sessionId,
      };
    } catch {
      return undefined;
    } finally {
      database?.close();
    }
  }
}

export function normalizeSessionEvent(raw: unknown, fallbackSessionId = ""): ZCodeSessionEvent | undefined {
  const envelope = record(raw);
  const envelopeType = string(envelope.type);
  if (!envelopeType) return undefined;
  const source = envelopeType === "session.event" ? record(envelope.event) : envelope;
  const sourceType = envelopeType === "session.event" ? string(source.type) : envelopeType;
  const type = sourceType === "snapshot" ? "session.snapshot"
    : sourceType === "permission.request" ? "permission.requested"
      : sourceType === "userInput.request" ? "userInput.requested"
        : sourceType === "providerRuntimeHeaders.request" ? "providerRuntimeHeaders.requested"
          : sourceType;
  if (!type) return undefined;
  const payload = envelopeType === "session.event"
    ? record(source.payload)
    : record(envelope.payload ?? envelope.request ?? envelope.snapshot ?? envelope);
  const sessionId = string(source.sessionId) ?? string(envelope.sessionId) ?? string(envelope.taskId) ?? fallbackSessionId;
  const base = {
    eventId: string(source.eventId),
    sessionId,
    turnId: string(source.turnId) ?? string(payload.turnId),
    seq: number(source.seq),
    traceId: string(source.traceId),
    timestamp: string(source.timestamp) ?? number(source.timestamp),
    deliveryKind: string(source.deliveryKind),
    type,
    payload,
    raw,
  };
  return (KNOWN_ZCODE_SESSION_EVENTS as readonly string[]).includes(type)
    ? {...base, known: true} as ZCodeSessionEvent
    : {...base, known: false} as ZCodeSessionEvent;
}

export function normalizeModelRequestEvent(event: ZCodeSessionEvent): ModelRequestEvent | undefined {
  if (event.type !== "session.updated") return undefined;
  const payload = event.payload;
  const sourceType = string(payload.type);
  const type = sourceType === "model_request_started" ? "started"
    : sourceType === "model_request_completed" ? "completed"
      : sourceType === "model_request_failed" ? "failed"
        : sourceType === "model_retry_scheduled" ? "retry_scheduled"
          : sourceType === "model_stream_stalled" ? "stream_stalled"
            : undefined;
  if (!type) return undefined;
  const querySource = string(payload.querySource);
  return {
    type,
    eventKey: string(payload.eventKey) ?? event.eventId,
    requestId: string(payload.requestId),
    sessionId: event.sessionId,
    turnId: event.turnId ?? string(payload.turnId),
    inputId: string(payload.inputId),
    queryId: string(payload.queryId),
    querySource,
    callSource: normalizeCallSource(payload.callSource, querySource),
    providerId: string(payload.providerId),
    modelId: string(payload.modelId),
    providerKind: string(payload.providerKind),
    transport: string(payload.transport),
    attempt: number(payload.attempt),
    durationMs: number(payload.durationMs),
    usage: tokenUsage(payload.usage),
    timestamp: event.timestamp,
  };
}

function sanitizeModelRequest(sessionId: string, value: unknown): ModelRequestRecord | undefined {
  const source = record(value);
  const requestId = string(source.requestId);
  if (!requestId) return undefined;
  const response = record(source.response);
  const error = record(source.error);
  const model = record(source.model);
  const explicitStatus = string(source.status);
  const status = explicitStatus === "completed" || explicitStatus === "failed" || explicitStatus === "incomplete"
    ? explicitStatus
    : Object.keys(error).length > 0 ? "failed" : Object.keys(response).length > 0 ? "completed" : "incomplete";
  const querySource = string(record(source.callSource).querySource) ?? string(source.querySource);
  return {
    requestId,
    attempt: number(source.attempt) ?? 1,
    sessionId,
    turnId: string(source.turnId),
    traceId: string(source.traceId),
    startedAt: string(source.startedAt),
    completedAt: string(source.completedAt),
    durationMs: number(source.durationMs) ?? number(response.durationMs),
    status,
    callSource: normalizeCallSource(source.callSource, querySource),
    model: {
      modelId: string(model.modelId),
      providerId: string(model.providerId),
      role: string(model.role),
      source: string(model.source),
      variant: string(model.variant),
    },
    usage: tokenUsage(response.usage ?? source.usage),
    finishReason: string(response.finishReason) ?? string(source.finishReason),
    ...(status === "failed" ? {error: {name: string(error.name)}} : {}),
  };
}

export function normalizeZCodeMessage(value: unknown): ZCodeMessage | undefined {
  const source = record(value);
  const info = record(source.info);
  const time = record(info.time ?? source.time);
  const messageId = string(source.messageId ?? source.id ?? info.messageId ?? info.id);
  if (!messageId) return undefined;
  const sessionId = string(source.sessionId ?? info.sessionId ?? info.sessionID);
  const role = string(source.role ?? info.role);
  const turnId = string(source.turnId ?? info.turnId);
  const parentMessageId = string(source.parentMessageId ?? info.parentMessageId ?? info.parentID);
  const createdAt = string(source.createdAt ?? time.created) ?? number(source.createdAt ?? time.created);
  const completedAt = string(source.completedAt ?? time.completed) ?? number(source.completedAt ?? time.completed);
  return {
    ...source,
    info,
    messageId,
    id: messageId,
    sessionId,
    role,
    turnId,
    parentMessageId,
    createdAt,
    completedAt,
  };
}

function normalizeCallSource(value: unknown, fallbackQuerySource?: string): ModelCallSource {
  const source = record(value);
  const querySource = string(source.querySource) ?? fallbackQuerySource;
  const explicit = string(source.kind);
  const inferred = querySource === "main_turn" ? "main"
    : querySource === "subagent" ? "subagent"
      : querySource === "compact" ? "compact"
        : querySource ? "sidecar" : "main";
  return {kind: (explicit ?? inferred) as ModelCallSource["kind"], querySource};
}

function tokenUsage(value: unknown): ModelTokenUsage | undefined {
  const usage = record(value);
  if (Object.keys(usage).length === 0) return undefined;
  return {
    inputTokens: number(usage.inputTokens ?? usage.input),
    outputTokens: number(usage.outputTokens ?? usage.output),
    totalTokens: number(usage.totalTokens ?? usage.total),
    cacheReadTokens: number(usage.cacheReadTokens ?? usage.cachedReadTokens),
    reasoningTokens: number(usage.reasoningTokens),
  };
}

function normalizeStreamEnvelope(source: ZCodeStreamEnvelope["source"], raw: unknown): ZCodeStreamEnvelope {
  const value = record(raw);
  return {
    source,
    name: string(value.type) ?? "unknown",
    sessionId: string(value.sessionId),
    taskId: string(value.taskId),
    workspacePath: string(value.workspacePath),
    timestamp: string(value.timestamp) ?? number(value.timestamp),
    payload: value.payload ?? raw,
    raw,
  };
}

function sessionTarget(value: unknown): ZCodeSubscriptionTarget {
  const target = requiredRecord(value);
  return {
    workspacePath: requiredString(target, "workspacePath"),
    workspaceIdentity: string(target.workspaceIdentity),
    sessionId: requiredString(target, "sessionId"),
    deliveryKind: string(target.deliveryKind),
    includeSnapshot: typeof target.includeSnapshot === "boolean" ? target.includeSnapshot : undefined,
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object payload");
  return value as Record<string, unknown>;
}

function withDefault(value: unknown, key: string, fallback: unknown): Record<string, unknown> {
  const payload = requiredRecord(value);
  return payload[key] === undefined ? {...payload, [key]: fallback} : payload;
}

function requiredString(value: unknown, key: string): string {
  const result = requiredRecord(value)[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`Expected ${key}`);
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

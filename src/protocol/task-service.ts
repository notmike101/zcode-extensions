import {EventEmitter} from "node:events";
import path from "node:path";
import type {JsonLogger} from "../shared/logger.ts";
import {modelRefSchema, taskSpecSchema, type TaskSpec} from "../shared/schemas.ts";
import {ZCodeProtocolClient} from "./client.ts";
import {resolveDesktopRuntimeModel, type RuntimeModelConfig} from "./desktop-model.ts";

export type TaskResultStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "lost" | "needs_attention";

export type TaskResult = {
  sessionId: string;
  status: TaskResultStatus;
  error?: string;
};

export type TaskRunHandle = {
  sessionId: string;
  completion: Promise<TaskResult>;
  stop: () => Promise<void>;
};

type TaskServiceOptions = {
  executable: string;
  zcodeRoot: string;
  resourcesPath: string;
  logger: JsonLogger;
  onHealth?: (status: "idle" | "starting" | "ready" | "error", error?: string) => void;
};

type SessionSnapshot = {
  protocol?: {name?: string; version?: number};
  session?: {sessionId?: string; status?: string};
  runtime?: {mainActive?: boolean; activeTurnId?: string};
  settings?: {model?: {current?: {providerId: string; modelId: string; variant?: string}}};
};

export class TaskService extends EventEmitter {
  readonly #options: TaskServiceOptions;
  #client?: ZCodeProtocolClient;
  #starting?: Promise<ZCodeProtocolClient>;
  #runs = new Map<string, {finish: (result: TaskResult) => void; interactionBlocked: boolean}>();

  constructor(options: TaskServiceOptions) {
    super();
    this.#options = options;
  }

  async readWorkspaceState(workspacePath: string): Promise<unknown> {
    const client = await this.#ensureClient();
    const desktop = resolveDesktopRuntimeModel(workspacePath);
    return client.request("workspace/readState", {
      workspace: workspaceRef(workspacePath),
      ...(desktop?.runtimeModel ? {runtimeModel: desktop.runtimeModel} : {}),
    });
  }

  async run(input: TaskSpec): Promise<TaskRunHandle> {
    const spec = taskSpecSchema.parse(input);
    const client = await this.#ensureClient();
    const workspace = workspaceRef(spec.workspacePath);
    const desktop = resolveDesktopRuntimeModel(spec.workspacePath, spec.model);
    let selectedModel = desktop?.model ?? spec.model;
    let runtimeModel: RuntimeModelConfig | undefined = desktop?.runtimeModel;
    if (desktop && !spec.model) {
      await this.#options.logger.info("Inherited ZCode desktop model selection", {
        workspacePath: spec.workspacePath,
        source: desktop.source,
        model: desktop.model,
        hasRuntimeModel: Boolean(desktop.runtimeModel),
      });
    }
    if (!selectedModel) {
      try {
        const state = await client.request<{settings?: {model?: {current?: unknown}}}>("workspace/readState", {
          workspace,
          ...(runtimeModel ? {runtimeModel} : {}),
        });
        const current = modelRefSchema.safeParse(state.settings?.model?.current);
        if (current.success) {
          const resolved = resolveDesktopRuntimeModel(spec.workspacePath, current.data);
          selectedModel = resolved?.model ?? current.data;
          runtimeModel = resolved?.runtimeModel;
        }
      } catch (error) {
        await this.#options.logger.warn("Could not read the workspace model selection", {workspacePath: spec.workspacePath, error});
      }
    }
    if (!selectedModel) throw new Error("No ZCode model is available. Run a desktop task first or pin a provider and model on this scheduled job.");
    if (!runtimeModel) {
      await this.#options.logger.warn("ZCode desktop runtime model config was unavailable", {
        workspacePath: spec.workspacePath,
        model: selectedModel,
      });
    }
    const snapshot = await client.request<SessionSnapshot>("session/create", {
      workspace,
      mode: spec.mode,
      persistence: "immediate",
      model: selectedModel,
      ...(runtimeModel ? {runtimeModel} : {}),
      ...(spec.thoughtLevel ? {thoughtLevel: spec.thoughtLevel} : {}),
      ...(spec.toolAllowlist ? {toolAllowlist: spec.toolAllowlist} : {}),
      ...(spec.toolDenylist ? {toolDenylist: spec.toolDenylist} : {}),
    }, 90_000);
    if (snapshot.protocol?.name !== "ZCode Protocol" || snapshot.protocol.version !== 1) {
      throw new Error(`Unsupported ZCode Protocol: ${snapshot.protocol?.name ?? "unknown"} v${snapshot.protocol?.version ?? "unknown"}`);
    }
    const sessionId = snapshot.session?.sessionId;
    if (!sessionId) throw new Error("ZCode did not return a session ID");
    await client.request("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: true,
    });

    let resolveCompletion!: (result: TaskResult) => void;
    const completion = new Promise<TaskResult>((resolve) => { resolveCompletion = resolve; });
    let settled = false;
    const finish = (result: TaskResult) => {
      if (settled) return;
      settled = true;
      this.#runs.delete(sessionId);
      resolveCompletion(result);
      void client.request("session/close", {sessionId, expectedPersistence: "immediate"}).catch(() => undefined);
      this.emit("task-finished", result);
    };
    this.#runs.set(sessionId, {finish, interactionBlocked: false});

    await client.request("session/send", {
      sessionId,
      content: spec.prompt,
      ...(runtimeModel ? {runtimeModel} : {}),
    }, 90_000);
    this.emit("task-started", {sessionId, spec});

    let timeout: NodeJS.Timeout | undefined;
    if (spec.timeoutMs) {
      timeout = setTimeout(() => {
        void client.request("session/stop", {sessionId}).catch(() => undefined);
        finish({sessionId, status: "timed_out", error: `Task exceeded ${spec.timeoutMs} ms`});
      }, spec.timeoutMs);
    }
    completion.finally(() => timeout && clearTimeout(timeout));
    void this.#pollUntilFinished(sessionId, finish);

    return {
      sessionId,
      completion,
      stop: async () => {
        if (settled) return;
        await client.request("session/stop", {sessionId}).catch(() => undefined);
        finish({sessionId, status: "cancelled"});
      },
    };
  }

  async shutdown(graceMs = 10_000): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const active = [...this.#runs.keys()];
    await Promise.all(active.map((sessionId) => client.request("session/stop", {sessionId}).catch(() => undefined)));
    if (active.length) await new Promise((resolve) => setTimeout(resolve, Math.min(graceMs, 10_000)));
    for (const [sessionId, run] of this.#runs) run.finish({sessionId, status: "cancelled"});
    await client.stop(2_000);
    this.#client = undefined;
    this.#options.onHealth?.("idle");
  }

  async #ensureClient(): Promise<ZCodeProtocolClient> {
    if (this.#client?.running) return this.#client;
    if (this.#starting) return this.#starting;
    this.#options.onHealth?.("starting");
    this.#starting = (async () => {
      const cli = path.join(this.#options.resourcesPath, "glm", "zcode.cjs");
      const client = new ZCodeProtocolClient({
        executable: this.#options.executable,
        args: [cli, "app-server"],
        cwd: this.#options.zcodeRoot,
        env: {ELECTRON_RUN_AS_NODE: "1", ZDP_APP_SERVER: "1"},
        logger: this.#options.logger.child("app-server"),
        requestHandler: (method, params) => this.#handleInteraction(method, params),
      });
      client.on("notification", (method, params) => this.#onNotification(method, params));
      client.on("exit", (error: Error) => {
        if (this.#client === client) this.#client = undefined;
        for (const [sessionId, run] of this.#runs) run.finish({sessionId, status: "lost", error: error.message});
        this.#options.onHealth?.("error", error.message);
      });
      await client.start();
      this.#client = client;
      this.#options.onHealth?.("ready");
      return client;
    })().catch((error) => {
      this.#options.onHealth?.("error", error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #handleInteraction(method: string, params: unknown): Promise<unknown> {
    const sessionId = typeof params === "object" && params && "sessionId" in params ? String((params as {sessionId: unknown}).sessionId) : undefined;
    if (sessionId) {
      const run = this.#runs.get(sessionId);
      if (run) run.interactionBlocked = true;
    }
    if (method === "interaction/requestPermission") {
      return {decision: "deny", reason: "Scheduled ZCode tasks cannot approve interactive permission requests."};
    }
    if (method === "interaction/requestUserInput") {
      return {action: "cancel", reason: "Scheduled ZCode tasks cannot answer interactive questions."};
    }
    if (method === "interaction/requestProviderRuntimeHeaders") {
      return {headersApplied: false, errorMessage: "Provider requires interactive runtime credentials."};
    }
    throw new Error(`Unsupported ZCode interaction request: ${method}`);
  }

  #onNotification(method: string, params: unknown): void {
    if (method !== "session/event" || typeof params !== "object" || !params) return;
    const envelope = params as {sessionId?: string; events?: Array<{type?: string; sessionId?: string; error?: unknown}>};
    for (const event of envelope.events ?? []) {
      const sessionId = event.sessionId ?? envelope.sessionId;
      if (!sessionId) continue;
      const run = this.#runs.get(sessionId);
      if (!run) continue;
      if (event.type === "turn.completed") {
        run.finish({sessionId, status: run.interactionBlocked ? "needs_attention" : "succeeded"});
      } else if (event.type === "turn.failed") {
        run.finish({sessionId, status: run.interactionBlocked ? "needs_attention" : "failed", error: stringifyUnknown(event.error)});
      }
    }
  }

  async #pollUntilFinished(sessionId: string, finish: (result: TaskResult) => void): Promise<void> {
    let seenActive = false;
    while (this.#runs.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (!this.#runs.has(sessionId)) return;
      try {
        const snapshot = await this.#client?.request<SessionSnapshot>("session/read", {sessionId, messageLimit: 5});
        if (!snapshot) continue;
        if (snapshot.runtime?.mainActive || snapshot.runtime?.activeTurnId) seenActive = true;
        if (snapshot.session?.status === "error") {
          finish({sessionId, status: "failed", error: "ZCode reported a session error"});
        } else if (seenActive && !snapshot.runtime?.mainActive && !snapshot.runtime?.activeTurnId) {
          const blocked = this.#runs.get(sessionId)?.interactionBlocked;
          finish({sessionId, status: blocked ? "needs_attention" : "succeeded"});
        }
      } catch (error) {
        await this.#options.logger.warn("Failed to poll task", {sessionId, error});
      }
    }
  }
}

function workspaceRef(workspacePath: string) {
  const resolved = path.resolve(workspacePath);
  return {workspacePath: resolved, workspaceKey: resolved};
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

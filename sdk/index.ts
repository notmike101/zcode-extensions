/**
 * Public contract and authoring helpers for ZCode Desktop Extensions API v1.
 *
 * Host 0.3 adds capabilities, native event access, renderer contributions, and
 * an experimental raw RPC escape hatch without changing the v1 wire version.
 * Legacy plugin-named identifiers remain stable for compatibility.
 */

export const ZCODE_EXTENSION_API_VERSION = 1 as const;

export type ExtensionDisposable = {
  dispose: () => unknown | Promise<unknown>;
};

export type ExtensionLogger = {
  child: (scope: string) => ExtensionLogger;
  debug: (message: string, data?: unknown) => Promise<void>;
  info: (message: string, data?: unknown) => Promise<void>;
  warn: (message: string, data?: unknown) => Promise<void>;
  error: (message: string, data?: unknown) => Promise<void>;
};

export const EXTENSION_CAPABILITIES = [
  "zcode.workspaces.read",
  "zcode.sessions.read",
  "zcode.sessions.events",
  "zcode.sessions.write",
  "zcode.tasks.read",
  "zcode.tasks.run",
  "zcode.tasks.write",
  "zcode.models.read",
  "zcode.models.generate",
  "zcode.usage.read",
  "zcode.broadcast",
  "ui.pages",
  "ui.navigation",
  "ui.workspace",
  "ui.tasks",
  "ui.chat",
  "ui.overlays",
  "experimental.zcode.rpc",
  "experimental.ui.dom",
] as const;

export type ExtensionCapability = typeof EXTENSION_CAPABILITIES[number];

export type ExtensionModelRef = {
  providerId: string;
  modelId: string;
  variant?: string;
};

export type ExtensionTaskSpec = {
  workspacePath: string;
  prompt: string;
  title?: string;
  mode: "plan" | "build" | "edit" | "yolo";
  model?: ExtensionModelRef;
  thoughtLevel?: string;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  timeoutMs?: number;
};

export type ExtensionTaskResultStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost"
  | "needs_attention";

export type ExtensionTaskResult = {
  sessionId: string;
  status: ExtensionTaskResultStatus;
  error?: string;
};

export type ExtensionTaskRunHandle = {
  sessionId: string;
  completion: Promise<ExtensionTaskResult>;
  stop: () => Promise<void>;
};

export type ExtensionManifest = {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  entrypoints: {
    main?: string;
    renderer?: string;
  };
  engines: {
    host: string;
    zcode: string;
  };
  pages: Array<{
    id: string;
    title: string;
  }>;
  capabilities?: ExtensionCapability[];
};

export type ManifestValidationIssue = {
  path: string;
  message: string;
};

export type ManifestValidationResult =
  | {success: true; manifest: ExtensionManifest}
  | {success: false; issues: ManifestValidationIssue[]};

const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

/** Validate and normalize an API v1 manifest without pulling a Node-only dependency into renderer bundles. */
export function validateExtensionManifest(input: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];
  if (!isRecord(input)) return {success: false, issues: [{path: "$", message: "Manifest must be an object"}]};

  const allowedRoot = new Set(["apiVersion", "id", "name", "version", "description", "entrypoints", "engines", "pages", "capabilities"]);
  for (const key of Object.keys(input)) if (!allowedRoot.has(key)) issues.push({path: `$.${key}`, message: "Unknown manifest field"});
  if (input.apiVersion !== ZCODE_EXTENSION_API_VERSION) issues.push({path: "$.apiVersion", message: "apiVersion must be 1"});
  checkString(input.id, "$.id", issues, {pattern: EXTENSION_ID_PATTERN, label: "extension identifier"});
  checkString(input.name, "$.name", issues, {min: 1, max: 80});
  checkString(input.version, "$.version", issues, {min: 1});
  if (input.description !== undefined) checkString(input.description, "$.description", issues, {max: 500});

  if (!isRecord(input.entrypoints)) {
    issues.push({path: "$.entrypoints", message: "entrypoints must be an object"});
  } else {
    for (const key of Object.keys(input.entrypoints)) if (key !== "main" && key !== "renderer") issues.push({path: `$.entrypoints.${key}`, message: "Unknown entrypoint"});
    for (const key of ["main", "renderer"] as const) {
      const value = input.entrypoints[key];
      if (value !== undefined) {
        checkString(value, `$.entrypoints.${key}`, issues, {min: 1});
        if (typeof value === "string" && (value.includes("..") || /^[\\/]/.test(value))) {
          issues.push({path: `$.entrypoints.${key}`, message: "Entrypoints must be relative paths contained by the extension"});
        }
      }
    }
    if (!input.entrypoints.main && !input.entrypoints.renderer) issues.push({path: "$.entrypoints", message: "At least one entrypoint is required"});
  }

  if (input.engines !== undefined && !isRecord(input.engines)) {
    issues.push({path: "$.engines", message: "engines must be an object"});
  } else if (isRecord(input.engines)) {
    for (const key of Object.keys(input.engines)) if (key !== "host" && key !== "zcode") issues.push({path: `$.engines.${key}`, message: "Unknown engine"});
    if (input.engines.host !== undefined) checkString(input.engines.host, "$.engines.host", issues, {min: 1});
    if (input.engines.zcode !== undefined) checkString(input.engines.zcode, "$.engines.zcode", issues, {min: 1});
  }

  if (input.pages !== undefined && !Array.isArray(input.pages)) {
    issues.push({path: "$.pages", message: "pages must be an array"});
  } else if (Array.isArray(input.pages)) {
    input.pages.forEach((page, index) => {
      const path = `$.pages[${index}]`;
      if (!isRecord(page)) return issues.push({path, message: "Page must be an object"});
      for (const key of Object.keys(page)) if (key !== "id" && key !== "title") issues.push({path: `${path}.${key}`, message: "Unknown page field"});
      checkString(page.id, `${path}.id`, issues, {pattern: EXTENSION_ID_PATTERN, label: "page identifier"});
      checkString(page.title, `${path}.title`, issues, {min: 1, max: 40});
    });
  }

  if (input.capabilities !== undefined && !Array.isArray(input.capabilities)) {
    issues.push({path: "$.capabilities", message: "capabilities must be an array"});
  } else if (Array.isArray(input.capabilities)) {
    const seen = new Set<unknown>();
    input.capabilities.forEach((capability, index) => {
      if (!EXTENSION_CAPABILITIES.includes(capability as ExtensionCapability)) issues.push({path: `$.capabilities[${index}]`, message: "Unknown capability"});
      if (seen.has(capability)) issues.push({path: `$.capabilities[${index}]`, message: "Capability must be unique"});
      seen.add(capability);
    });
  }

  if (issues.length > 0) return {success: false, issues};
  const engines = isRecord(input.engines) ? input.engines : {};
  const entrypoints = input.entrypoints as Record<string, unknown>;
  return {
    success: true,
    manifest: {
      apiVersion: 1,
      id: input.id as string,
      name: input.name as string,
      version: input.version as string,
      ...(typeof input.description === "string" ? {description: input.description} : {}),
      entrypoints: {
        ...(typeof entrypoints.main === "string" ? {main: entrypoints.main} : {}),
        ...(typeof entrypoints.renderer === "string" ? {renderer: entrypoints.renderer} : {}),
      },
      engines: {
        host: typeof engines.host === "string" ? engines.host : ">=0.1.0",
        zcode: typeof engines.zcode === "string" ? engines.zcode : ">=3.3.6",
      },
      pages: (input.pages ?? []) as ExtensionManifest["pages"],
      ...(Array.isArray(input.capabilities) ? {capabilities: input.capabilities as ExtensionCapability[]} : {}),
    },
  };
}

export function assertExtensionManifest(input: unknown): ExtensionManifest {
  const result = validateExtensionManifest(input);
  if (result.success) return result.manifest;
  throw new TypeError(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(
  value: unknown,
  path: string,
  issues: ManifestValidationIssue[],
  options: {min?: number; max?: number; pattern?: RegExp; label?: string},
): void {
  if (typeof value !== "string") return void issues.push({path, message: "Expected a string"});
  if (options.min !== undefined && value.length < options.min) issues.push({path, message: `Must contain at least ${options.min} character(s)`});
  if (options.max !== undefined && value.length > options.max) issues.push({path, message: `Must contain at most ${options.max} character(s)`});
  if (options.pattern && !options.pattern.test(value)) issues.push({path, message: `Invalid ${options.label ?? "value"}`});
}

export type ExtensionHostCapabilities = {
  apiVersion: 1;
  hostVersion: string;
  zcodeVersion: string;
  declared: ExtensionCapability[];
  granted: ExtensionCapability[];
  legacyDefaults: boolean;
  uiSlots: UiContributionSlot[];
  experimental: boolean;
};

export const KNOWN_ZCODE_SESSION_EVENTS = [
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "session.snapshot",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "elicitation.requested",
  "elicitation.resolved",
  "userInput.requested",
  "userInput.resolved",
  "providerRuntimeHeaders.requested",
  "providerRuntimeHeaders.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
] as const;

export type KnownZCodeSessionEventName = typeof KNOWN_ZCODE_SESSION_EVENTS[number];

export type SessionEventPayload = Record<string, unknown>;
export type SessionLifecyclePayload = SessionEventPayload & {title?: string; status?: string};
export type TurnEventPayload = SessionEventPayload & {turnId?: string; status?: string; error?: unknown};
export type MessageEventPayload = SessionEventPayload & {messageId?: string; assistantMessageId?: string; role?: string; message?: unknown};
export type PartEventPayload = SessionEventPayload & {partId?: string; messageId?: string; assistantMessageId?: string; kind?: string; text?: string; delta?: string; bytes?: number};
export type ModelStreamingPayload = SessionEventPayload & {requestId?: string; turnId?: string; assistantMessageId?: string; modelId?: string; providerId?: string; text?: string; delta?: string; bytes?: number};
export type ToolEventPayload = SessionEventPayload & {toolCallId?: string; turnId?: string; name?: string; status?: string; input?: unknown; output?: unknown};
export type InteractionEventPayload = SessionEventPayload & {requestId?: string; resolved?: boolean; response?: unknown};
export type CheckpointEventPayload = SessionEventPayload & {checkpointId?: string; turnId?: string};
export type RecoveryEventPayload = SessionEventPayload & {status?: string; attempt?: number; error?: unknown};

export type KnownZCodeSessionEventPayloads = {
  "session.created": SessionLifecyclePayload;
  "session.resumed": SessionLifecyclePayload;
  "session.updated": SessionLifecyclePayload;
  "session.titleUpdated": SessionLifecyclePayload;
  "session.closed": SessionLifecyclePayload;
  "session.snapshot": SessionLifecyclePayload;
  "turn.started": TurnEventPayload;
  "turn.steerQueued": TurnEventPayload;
  "turn.steerDrained": TurnEventPayload;
  "turn.completed": TurnEventPayload;
  "turn.failed": TurnEventPayload;
  "message.upserted": MessageEventPayload;
  "message.removed": MessageEventPayload;
  "part.started": PartEventPayload;
  "part.delta": PartEventPayload;
  "part.upserted": PartEventPayload;
  "part.removed": PartEventPayload;
  "model.streaming": ModelStreamingPayload;
  "tool.updated": ToolEventPayload;
  "permission.requested": InteractionEventPayload;
  "permission.resolved": InteractionEventPayload;
  "elicitation.requested": InteractionEventPayload;
  "elicitation.resolved": InteractionEventPayload;
  "userInput.requested": InteractionEventPayload;
  "userInput.resolved": InteractionEventPayload;
  "providerRuntimeHeaders.requested": InteractionEventPayload;
  "providerRuntimeHeaders.resolved": InteractionEventPayload;
  "checkpoint.created": CheckpointEventPayload;
  "rewind.triggered": CheckpointEventPayload;
  "streamRecovery.updated": RecoveryEventPayload;
};

type ZCodeSessionEventBase = {
  eventId?: string;
  sessionId: string;
  turnId?: string;
  seq?: number;
  traceId?: string;
  timestamp?: string | number;
  deliveryKind?: string;
  raw: unknown;
};

export type KnownZCodeSessionEvent = {
  [Name in KnownZCodeSessionEventName]: ZCodeSessionEventBase & {
    type: Name;
    payload: KnownZCodeSessionEventPayloads[Name];
    known: true;
  }
}[KnownZCodeSessionEventName];

export type UnknownZCodeSessionEvent = ZCodeSessionEventBase & {
  type: string & {};
  payload: SessionEventPayload;
  known: false;
};

export type ZCodeSessionEvent = KnownZCodeSessionEvent | UnknownZCodeSessionEvent;

export type ZCodeStreamEnvelope = {
  source: "session" | "task" | "workspace" | "broadcast" | "unknown";
  name: string;
  sessionId?: string;
  taskId?: string;
  workspacePath?: string;
  timestamp?: string | number;
  payload: unknown;
  raw: unknown;
};

export type ModelTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
};

export type ModelCallSource = {
  kind: "main" | "subagent" | "compact" | "sidecar" | (string & {});
  querySource?: string;
};

export type ModelRequestRecord = {
  requestId: string;
  attempt: number;
  sessionId: string;
  turnId?: string;
  traceId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: "completed" | "failed" | "incomplete";
  callSource: ModelCallSource;
  model: {
    modelId?: string;
    providerId?: string;
    role?: string;
    source?: string;
    variant?: string;
  };
  usage?: ModelTokenUsage;
  finishReason?: string;
  error?: {name?: string};
};

export type ModelRequestHistory = {
  sessionId: string;
  available: boolean;
  records: ModelRequestRecord[];
  truncated: boolean;
};

export type ModelRequestEvent = {
  type: "started" | "completed" | "failed" | "retry_scheduled" | "stream_stalled";
  eventKey?: string;
  requestId?: string;
  sessionId: string;
  turnId?: string;
  inputId?: string;
  queryId?: string;
  querySource?: string;
  callSource: ModelCallSource;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: string;
  attempt?: number;
  durationMs?: number;
  usage?: ModelTokenUsage;
  timestamp?: string | number;
};

export type ZCodeSubscriptionTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  deliveryKind?: string;
  includeSnapshot?: boolean;
};

export type ZCodeWorkspaceTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
};

export type ZCodeSessionTarget = ZCodeWorkspaceTarget & {
  sessionId: string;
};

export type ZCodeSessionSummary = Record<string, unknown> & {
  sessionId: string;
  title?: string;
  updatedAt?: string | number;
  archived?: boolean;
  traceId?: string;
};

export type ZCodeMessage = Record<string, unknown> & {
  messageId?: string;
  id?: string;
  sessionId?: string;
  role?: string;
  turnId?: string;
  createdAt?: string | number;
  completedAt?: string | number;
  parentMessageId?: string;
  info?: Record<string, unknown>;
  parts?: unknown[];
};

export type ZCodeTaskSummary = Record<string, unknown> & {
  taskId: string;
  sessionId?: string;
  title?: string;
  workspacePath?: string;
  updatedAt?: string | number;
};

export type ZCodeTaskListResult = ZCodeTaskSummary[] | (Record<string, unknown> & {tasks?: ZCodeTaskSummary[]});

export type ZCodeProviderDescriptor = Record<string, unknown> & {
  id?: string;
  providerId?: string;
  name?: string;
  models?: unknown[];
};

export type ZCodeProviderRegistry = {
  providers: ZCodeProviderDescriptor[];
  registry: unknown;
};

export type ZCodeWorkspaceDefaults = {
  settings: Record<string, unknown>;
  defaults: unknown;
};

export type ZCodeModelGenerationResult = Record<string, unknown> & {
  text?: string;
  providerId?: string;
  modelId?: string;
  usage?: ModelTokenUsage;
};

export type ZCodeMcpServerStatus = Record<string, unknown> & {
  id?: string;
  name?: string;
  status?: string;
};

export type ZCodeRawChannel = {
  call<T = unknown>(command: string, payload?: unknown): Promise<T>;
  listen<T = unknown>(event: string, payload: unknown, listener: (value: T) => void): ExtensionDisposable;
};

export type ExtensionZCodeApi = {
  capabilities: () => Promise<ExtensionHostCapabilities>;
  /** @deprecated Prefer workspaces.readState. */
  readWorkspaceState: (workspacePath: string) => Promise<unknown>;
  workspaces: {
    readState: (workspacePath: string) => Promise<Record<string, unknown>>;
    readProviderRegistry: (payload: ZCodeWorkspaceTarget) => Promise<ZCodeProviderRegistry>;
    readDefaults: (payload: ZCodeWorkspaceTarget) => Promise<ZCodeWorkspaceDefaults>;
    subscribe: (payload: ZCodeWorkspaceTarget & Record<string, unknown>, listener: (event: ZCodeStreamEnvelope) => void) => ExtensionDisposable;
  };
  sessions: {
    resolveTarget: (sessionId: string) => Promise<ZCodeSessionTarget | undefined>;
    list: (payload: ZCodeWorkspaceTarget & {includeArchived?: boolean; limit?: number}) => Promise<ZCodeSessionSummary[]>;
    read: (payload: ZCodeSessionTarget & {deliveryKind?: string; messageLimit?: number; afterSeq?: number}) => Promise<Record<string, unknown>>;
    readMessages: (payload: ZCodeSessionTarget & {afterMessageId?: string; limit?: number}) => Promise<ZCodeMessage[]>;
    readEvents: (payload: ZCodeSessionTarget & {afterSeq?: number; limit?: number}) => Promise<unknown[]>;
    subscribe: (target: ZCodeSubscriptionTarget, listener: (event: ZCodeSessionEvent) => void) => ExtensionDisposable;
    create: (payload: ZCodeWorkspaceTarget & Record<string, unknown>) => Promise<Record<string, unknown>>;
    resume: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<Record<string, unknown>>;
    send: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    steer: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    stop: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    fork: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    rewind: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    compact: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    setGoal: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    close: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    setModel: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    setThoughtLevel: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    setMode: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    respondPermission: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    respondUserInput: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
    respondProviderHeaders: (payload: ZCodeSessionTarget & Record<string, unknown>) => Promise<unknown>;
  };
  tasks: {
    run: (spec: ExtensionTaskSpec) => Promise<ExtensionTaskRunHandle>;
    ensureVisible: (spec: {sessionId: string; workspacePath: string; title?: string}) => Promise<void>;
    list: (payload: ZCodeWorkspaceTarget & Record<string, unknown>) => Promise<ZCodeTaskListResult>;
    getMeta: (payload: ZCodeWorkspaceTarget & {taskId: string}) => Promise<ZCodeTaskSummary | undefined>;
    getSnapshot: (payload: Record<string, unknown>) => Promise<unknown>;
    getSnapshotBody: (payload: Record<string, unknown>) => Promise<unknown>;
    getSnapshotToolCalls: (payload: Record<string, unknown>) => Promise<unknown>;
    getConfigOptions: (payload: Record<string, unknown>) => Promise<unknown>;
    getTokenUsage: (payload: Record<string, unknown>) => Promise<unknown>;
    subscribe: (payload: Record<string, unknown>, listener: (event: ZCodeStreamEnvelope) => void) => ExtensionDisposable;
    archive: (payload: Record<string, unknown>) => Promise<unknown>;
    unarchive: (payload: Record<string, unknown>) => Promise<unknown>;
    pin: (payload: Record<string, unknown>) => Promise<unknown>;
    rename: (payload: Record<string, unknown>) => Promise<unknown>;
    remove: (payload: Record<string, unknown>) => Promise<unknown>;
    branch: (payload: Record<string, unknown>) => Promise<unknown>;
    rewindTurn: (payload: Record<string, unknown>) => Promise<unknown>;
    setUnread: (payload: Record<string, unknown>) => Promise<unknown>;
  };
  models: {
    listProviders: (payload: ZCodeWorkspaceTarget) => Promise<ZCodeProviderRegistry>;
    readDefaults: (payload: ZCodeWorkspaceTarget) => Promise<ZCodeWorkspaceDefaults>;
    generateText: (payload: ZCodeWorkspaceTarget & Record<string, unknown>) => Promise<ZCodeModelGenerationResult>;
  };
  mcp: {
    list: (payload: ZCodeWorkspaceTarget & Record<string, unknown>) => Promise<ZCodeMcpServerStatus[] | Record<string, unknown>>;
  };
  usage: {
    listModelRequests: (payload: {sessionId: string; limit?: number}) => Promise<ModelRequestHistory>;
    subscribeModelRequests: (target: ZCodeSubscriptionTarget, listener: (event: ModelRequestEvent) => void) => ExtensionDisposable;
  };
  broadcast: {
    send: (channel: string, payload: unknown) => Promise<unknown>;
    listen: (channel: string, listener: (event: ZCodeStreamEnvelope) => void) => ExtensionDisposable;
  };
  experimental: {
    channel: (name: string) => ZCodeRawChannel;
  };
};

export type ExtensionContext = {
  manifest: ExtensionManifest;
  dataDir: string;
  logger: ExtensionLogger;
  ipc: {
    handle: (
      method: string,
      handler: (payload: unknown) => unknown | Promise<unknown>,
    ) => ExtensionDisposable;
    emit: (event: string, payload?: unknown) => void;
  };
  lifecycle: {
    onResume: (handler: () => void) => ExtensionDisposable;
  };
  zcode: ExtensionZCodeApi;
};

export type ExtensionActivationResult =
  | void
  | ExtensionDisposable
  | (() => unknown | Promise<unknown>);

export type ExtensionModule = {
  activate?: (
    context: ExtensionContext,
  ) => ExtensionActivationResult | Promise<ExtensionActivationResult>;
  deactivate?: () => unknown | Promise<unknown>;
};

export type ExtensionBridge = {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
  on(listener: (event: string, payload: unknown) => void): () => void;
};

export const UI_CONTRIBUTION_SLOTS = [
  "sidebar.navigation",
  "workspace.header.actions",
  "task.row.trailing",
  "chat.header.actions",
  "chat.overlay",
  "chat.composer.leading",
  "chat.composer.trailing",
  "chat.turn.after",
  "chat.message.before",
  "chat.message.after",
  "chat.message.footer",
  "chat.message.overlay",
] as const;

export type UiContributionSlot = typeof UI_CONTRIBUTION_SLOTS[number];

export type ActiveUiContext = {
  workspacePath?: string;
  workspaceIdentity?: string;
  taskId?: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  role?: string;
  runtimeStatus?: string;
  toolCallId?: string;
};

export type UiContributionMount = (
  container: HTMLElement,
  context: ActiveUiContext,
) => void | (() => void) | ExtensionDisposable;

export type RendererExtensionContext = {
  manifest: ExtensionManifest;
  capabilities: ExtensionHostCapabilities;
  ipc: {
    invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
    on(event: string, listener: (payload: unknown) => void): ExtensionDisposable;
  };
  storage: {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
  };
  zcode: ExtensionZCodeApi;
  ui: {
    activeContext: {
      current(): ActiveUiContext;
      onDidChange(listener: (context: ActiveUiContext) => void): ExtensionDisposable;
    };
    contribute(
      slot: UiContributionSlot,
      mount: UiContributionMount,
      options?: {order?: number; when?: (context: ActiveUiContext) => boolean},
    ): ExtensionDisposable;
    showToast(message: string, options?: {kind?: "info" | "success" | "warning" | "error"; timeoutMs?: number}): ExtensionDisposable;
    showDialog(options: {title: string; message: string; confirmLabel?: string; cancelLabel?: string}): Promise<boolean>;
    experimental: {
      anchor(options: {
        selector: string;
        placement: "before" | "after" | "prepend" | "append" | "overlay";
        mount: UiContributionMount;
        order?: number;
      }): ExtensionDisposable;
    };
  };
  subscriptions: {
    add<T extends ExtensionDisposable>(disposable: T): T;
  };
};

export type RendererExtension = {
  id: string;
  activate?: (context: RendererExtensionContext) => ExtensionActivationResult | Promise<ExtensionActivationResult>;
  mountPage?: (
    pageId: string,
    container: HTMLElement,
    context: RendererExtensionContext,
  ) => void | (() => void) | ExtensionDisposable;
  /** Legacy API v1 page lifecycle. */
  mount?: (
    container: HTMLElement,
    bridge: ExtensionBridge,
  ) => void | (() => void);
  deactivate?: () => unknown | Promise<unknown>;
};

export function defineMainExtension(extension: ExtensionModule): ExtensionModule {
  return extension;
}

export function defineRendererExtension(extension: RendererExtension): RendererExtension {
  return extension;
}

declare global {
  interface Window {
    zcodeDesktopPlugins?: ExtensionBridge;
    ZDP_REGISTER_PLUGIN_RENDERER?: (extension: RendererExtension) => void;
  }
}

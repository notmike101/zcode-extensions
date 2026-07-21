import type {PluginStatus} from "../shared/schemas.ts";
import type {
  ActiveUiContext,
  ExtensionDisposable,
  ExtensionHostCapabilities,
  ExtensionManifest,
  ExtensionZCodeApi,
  ModelRequestEvent,
  RendererExtension,
  RendererExtensionContext,
  UiContributionMount,
  UiContributionSlot,
  ZCodeSessionEvent,
  ZCodeStreamEnvelope,
  ZCodeSubscriptionTarget,
} from "../../sdk/index.ts";
import type {ZdpBridge} from "./globals.d.ts";

type RuntimeRecord = {
  plugin?: RendererExtension;
  status?: PluginStatus;
  context?: RendererExtensionContext;
  disposables?: DisposableStore;
  activationCleanup?: ExtensionDisposable;
  activating?: Promise<void>;
  operation?: Promise<void>;
};

export class RendererExtensionRuntime {
  readonly #bridge: ZdpBridge;
  readonly #ui: UiContributionRegistry;
  readonly #records = new Map<string, RuntimeRecord>();

  constructor(bridge: ZdpBridge) {
    this.#bridge = bridge;
    this.#ui = new UiContributionRegistry();
    window.addEventListener("beforeunload", () => { void this.dispose(); }, {once: true});
  }

  register(plugin: RendererExtension): void {
    const record = this.#records.get(plugin.id) ?? {};
    this.#records.set(plugin.id, record);
    this.#queue(plugin.id, record, async () => {
      if (record.plugin && record.plugin !== plugin) await this.#deactivate(plugin.id, record);
      record.plugin = plugin;
      if (record.status?.enabled) await this.#activate(plugin.id, record);
    });
  }

  sync(plugins: PluginStatus[]): void {
    const active = new Set(plugins.map((plugin) => plugin.manifest.id));
    for (const status of plugins) {
      const record = this.#records.get(status.manifest.id) ?? {};
      this.#records.set(status.manifest.id, record);
      this.#queue(status.manifest.id, record, async () => {
        const generationChanged = record.status && record.status.generation !== status.generation;
        const disabled = record.status?.enabled && !status.enabled;
        if (generationChanged || disabled) await this.#deactivate(status.manifest.id, record);
        record.status = status;
        if (status.enabled && record.plugin) await this.#activate(status.manifest.id, record);
      });
    }
    for (const [pluginId, record] of this.#records) {
      if (!active.has(pluginId)) {
        this.#queue(pluginId, record, async () => {
          await this.#deactivate(pluginId, record);
          record.status = undefined;
        });
      }
    }
  }

  refreshUi(): void {
    this.#ui.refresh();
  }

  async dispose(): Promise<void> {
    for (const [pluginId, record] of this.#records) {
      await record.operation?.catch(() => undefined);
      await this.#deactivate(pluginId, record);
    }
    this.#records.clear();
    this.#ui.dispose();
  }

  async mountPage(pluginId: string, pageId: string, container: HTMLElement): Promise<() => void> {
    const record = this.#records.get(pluginId);
    await record?.operation;
    if (!record?.plugin) return () => undefined;
    await this.#activate(pluginId, record);
    const plugin = record.plugin;
    if (plugin.mountPage && record.context) {
      requireUiCapability(record.context.capabilities, "ui.pages");
      const pageHost = document.createElement("div");
      pageHost.dataset.zdpExtensionPage = pluginId;
      const shadow = pageHost.attachShadow({mode: "open"});
      const mount = document.createElement("div");
      shadow.append(mount);
      container.replaceChildren(pageHost);
      const result = await plugin.mountPage(pageId, mount, record.context);
      const cleanup = cleanupFunction(result, () => container.replaceChildren());
      record.disposables?.add({dispose: cleanup});
      return cleanup;
    }
    if (plugin.mount) {
      if (!record.status?.manifest.capabilities?.includes("ui.pages") && record.status?.manifest.capabilities !== undefined) {
        throw new Error("Extension must declare capability ui.pages");
      }
      const result = plugin.mount(container, this.#bridge);
      const cleanup = cleanupFunction(result, () => container.replaceChildren());
      record.disposables?.add({dispose: cleanup});
      return cleanup;
    }
    container.textContent = "This extension does not provide a page renderer.";
    return () => container.replaceChildren();
  }

  #queue(pluginId: string, record: RuntimeRecord, operation: () => Promise<void>): void {
    record.operation = (record.operation ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    void record.operation.catch((error) => {
      console.error(`ZCode extension renderer ${pluginId} lifecycle failed`, error);
    });
  }

  async #activate(pluginId: string, record: RuntimeRecord): Promise<void> {
    if (record.context || record.activating || !record.plugin || !record.status?.enabled) return record.activating;
    record.activating = (async () => {
      const capabilities = await this.#bridge.invoke<ExtensionHostCapabilities>("plugin:capabilities", {pluginId});
      const disposables = new DisposableStore();
      const context = createRendererContext(
        pluginId,
        record.status!.manifest,
        capabilities,
        this.#bridge,
        this.#ui,
        disposables,
      );
      record.disposables = disposables;
      record.context = context;
      if (record.plugin?.activate) {
        const result = await record.plugin.activate(context);
        record.activationCleanup = disposableFrom(result);
      }
    })().catch((error) => {
      record.context = undefined;
      record.disposables?.dispose();
      record.disposables = undefined;
      throw error;
    }).finally(() => { record.activating = undefined; });
    return record.activating;
  }

  async #deactivate(pluginId: string, record: RuntimeRecord): Promise<void> {
    const plugin = record.plugin;
    await record.activating?.catch(() => undefined);
    try { await record.activationCleanup?.dispose(); } catch { /* isolated extension cleanup */ }
    try { await plugin?.deactivate?.(); } catch { /* isolated extension cleanup */ }
    record.disposables?.dispose();
    this.#ui.disposePlugin(pluginId);
    record.activationCleanup = undefined;
    record.disposables = undefined;
    record.context = undefined;
  }
}

function createRendererContext(
  pluginId: string,
  manifest: ExtensionManifest,
  capabilities: ExtensionHostCapabilities,
  bridge: ZdpBridge,
  ui: UiContributionRegistry,
  disposables: DisposableStore,
): RendererExtensionContext {
  const invokePlugin = <T>(method: string, payload?: unknown) => bridge.invoke<T>("plugin:invoke", {pluginId, method, payload});
  const invokeZCode = <T>(operation: string, payload?: unknown) => bridge.invoke<T>("plugin:zcode:invoke", {pluginId, operation, payload});
  const subscribe = <T>(stream: string, payload: unknown, listener: (value: T) => void): ExtensionDisposable => {
    const capability = streamCapability(stream);
    if (capability && !capabilities.granted.includes(capability as never)) {
      throw new Error(`Extension must declare capability ${capability}`);
    }
    let active = true;
    let subscriptionId: string | undefined;
    let remove: (() => void) | undefined;
    void bridge.invoke<string>("plugin:zcode:subscribe", {pluginId, stream, payload}).then((id) => {
      subscriptionId = id;
      if (!active) return bridge.invoke("plugin:zcode:unsubscribe", {pluginId, subscriptionId: id});
      remove = bridge.on((event, value) => {
        if (event === `plugin:${pluginId}:zcode:${id}`) listener(value as T);
      });
    }).catch((error) => {
      if (active) ui.showRuntimeError(pluginId, error);
    });
    return disposables.add({dispose: () => {
      if (!active) return;
      active = false;
      remove?.();
      if (subscriptionId) void bridge.invoke("plugin:zcode:unsubscribe", {pluginId, subscriptionId});
    }});
  };
  const zcode = createRendererZCodeApi(capabilities, invokeZCode, subscribe);
  return {
    manifest,
    capabilities,
    ipc: {
      invoke: invokePlugin,
      on: (event, listener) => {
        const remove = bridge.on((name, payload) => {
          if (name === `plugin:${pluginId}:${event}`) listener(payload);
        });
        return disposables.add({dispose: remove});
      },
    },
    storage: {
      get(key, fallback) {
        try {
          const value = window.localStorage.getItem(storageKey(pluginId, key));
          return value === null ? fallback : JSON.parse(value) as typeof fallback;
        } catch { return fallback; }
      },
      set(key, value) { window.localStorage.setItem(storageKey(pluginId, key), JSON.stringify(value)); },
      delete(key) { window.localStorage.removeItem(storageKey(pluginId, key)); },
    },
    zcode,
    ui: {
      activeContext: {
        current: () => ui.activeContext(),
        onDidChange: (listener) => disposables.add(ui.onActiveContextChanged(listener)),
      },
      contribute: (slot, mount, options) => disposables.add(ui.contribute(pluginId, capabilities, slot, mount, options)),
      showToast: (message, options) => disposables.add(ui.showToast(pluginId, capabilities, message, options)),
      showDialog: (options) => ui.showDialog(capabilities, options),
      experimental: {
        anchor: (options) => disposables.add(ui.anchor(pluginId, capabilities, options)),
      },
    },
    subscriptions: {add: (disposable) => disposables.add(disposable)},
  };
}

function createRendererZCodeApi(
  capabilities: ExtensionHostCapabilities,
  invoke: <T>(operation: string, payload?: unknown) => Promise<T>,
  subscribe: <T>(stream: string, payload: unknown, listener: (value: T) => void) => ExtensionDisposable,
): ExtensionZCodeApi {
  return {
    capabilities: () => Promise.resolve(capabilities),
    readWorkspaceState: (workspacePath) => invoke("workspaces.readState", {workspacePath}),
    workspaces: {
      readState: (workspacePath) => invoke("workspaces.readState", {workspacePath}),
      readProviderRegistry: (payload) => invoke("workspaces.readProviderRegistry", payload),
      readDefaults: (payload) => invoke("workspaces.readDefaults", payload),
      subscribe: (payload, listener) => subscribe<ZCodeStreamEnvelope>("workspaces.events", payload, listener),
    },
    sessions: {
      resolveTarget: (sessionId) => invoke("sessions.resolveTarget", {sessionId}),
      list: (payload) => invoke("sessions.list", payload), read: (payload) => invoke("sessions.read", payload),
      readMessages: (payload) => invoke("sessions.readMessages", payload), readEvents: (payload) => invoke("sessions.readEvents", payload),
      subscribe: (payload, listener) => subscribe<ZCodeSessionEvent>("sessions.events", payload, listener),
      create: (payload) => invoke("sessions.create", payload), resume: (payload) => invoke("sessions.resume", payload),
      send: (payload) => invoke("sessions.send", payload), steer: (payload) => invoke("sessions.steer", payload),
      stop: (payload) => invoke("sessions.stop", payload), fork: (payload) => invoke("sessions.fork", payload),
      rewind: (payload) => invoke("sessions.rewind", payload), compact: (payload) => invoke("sessions.compact", payload),
      setGoal: (payload) => invoke("sessions.setGoal", payload), close: (payload) => invoke("sessions.close", payload),
      setModel: (payload) => invoke("sessions.setModel", payload), setThoughtLevel: (payload) => invoke("sessions.setThoughtLevel", payload),
      setMode: (payload) => invoke("sessions.setMode", payload), respondPermission: (payload) => invoke("sessions.respondPermission", payload),
      respondUserInput: (payload) => invoke("sessions.respondUserInput", payload),
      respondProviderHeaders: (payload) => invoke("sessions.respondProviderHeaders", payload),
    },
    tasks: {
      run: () => Promise.reject(new Error("Renderer task runs must be delegated to the extension main entrypoint")),
      ensureVisible: (payload) => invoke("tasks.ensureVisible", payload),
      list: (payload) => invoke("tasks.list", payload), getMeta: (payload) => invoke("tasks.getMeta", payload),
      getSnapshot: (payload) => invoke("tasks.getSnapshot", payload),
      getSnapshotBody: (payload) => invoke("tasks.getSnapshotBody", payload),
      getSnapshotToolCalls: (payload) => invoke("tasks.getSnapshotToolCalls", payload),
      getConfigOptions: (payload) => invoke("tasks.getConfigOptions", payload),
      getTokenUsage: (payload) => invoke("tasks.getTokenUsage", payload),
      subscribe: (payload, listener) => subscribe<ZCodeStreamEnvelope>("tasks.events", payload, listener),
      archive: (payload) => invoke("tasks.archive", payload), unarchive: (payload) => invoke("tasks.unarchive", payload),
      pin: (payload) => invoke("tasks.pin", payload),
      rename: (payload) => invoke("tasks.rename", payload), remove: (payload) => invoke("tasks.remove", payload),
      branch: (payload) => invoke("tasks.branch", payload),
      rewindTurn: (payload) => invoke("tasks.rewindTurn", payload), setUnread: (payload) => invoke("tasks.setUnread", payload),
    },
    models: {
      listProviders: (payload) => invoke("models.listProviders", payload), readDefaults: (payload) => invoke("models.readDefaults", payload),
      generateText: (payload) => invoke("models.generateText", payload),
    },
    mcp: {list: (payload) => invoke("mcp.list", payload)},
    usage: {
      listModelRequests: (payload) => invoke("usage.listModelRequests", payload),
      subscribeModelRequests: (payload, listener) => subscribe<ModelRequestEvent>("usage.modelRequests", payload, listener),
    },
    broadcast: {
      send: (channel, payload) => invoke("broadcast.send", {channel, payload}),
      listen: (channel, listener) => subscribe("broadcast.events", {channel}, listener),
    },
    experimental: {channel: (channel) => ({
      call: (command, payload) => invoke("experimental.call", {channel, command, payload}),
      listen: (event, payload, listener) => subscribe("experimental.listen", {channel, event, payload}, listener),
    })},
  };
}

type Contribution = {
  id: string;
  pluginId: string;
  selector: string;
  placement: "before" | "after" | "prepend" | "append" | "overlay";
  mount: UiContributionMount;
  order: number;
  when?: (context: ActiveUiContext) => boolean;
  instances: Map<Element, {host: HTMLElement; cleanup: () => void}>;
};

class UiContributionRegistry {
  readonly #contributions = new Map<string, Contribution>();
  readonly #activeListeners = new Set<(context: ActiveUiContext) => void>();
  readonly #observer: MutationObserver;
  #frame?: number;
  #lastActive = "";

  constructor() {
    this.#observer = new MutationObserver(() => this.#schedule());
    this.#observer.observe(document.getElementById("root") ?? document.body, {childList: true, subtree: true, attributes: true});
  }

  contribute(
    pluginId: string,
    capabilities: ExtensionHostCapabilities,
    slot: UiContributionSlot,
    mount: UiContributionMount,
    options: {order?: number; when?: (context: ActiveUiContext) => boolean} = {},
  ): ExtensionDisposable {
    requireUiCapability(capabilities, slotCapability(slot));
    const config = slotConfig(slot);
    return this.#add({pluginId, mount, order: options.order ?? 0, when: options.when, ...config});
  }

  anchor(
    pluginId: string,
    capabilities: ExtensionHostCapabilities,
    options: {selector: string; placement: Contribution["placement"]; mount: UiContributionMount; order?: number},
  ): ExtensionDisposable {
    requireUiCapability(capabilities, "experimental.ui.dom");
    document.querySelector(options.selector); // validate selector before registration
    return this.#add({pluginId, selector: options.selector, placement: options.placement, mount: options.mount, order: options.order ?? 0});
  }

  activeContext(): ActiveUiContext {
    const chat = document.querySelector<HTMLElement>('[data-testid="chat-view"]');
    return contextFrom(chat ?? document.body);
  }

  onActiveContextChanged(listener: (context: ActiveUiContext) => void): ExtensionDisposable {
    this.#activeListeners.add(listener);
    listener(this.activeContext());
    return {dispose: () => this.#activeListeners.delete(listener)};
  }

  refresh(): void {
    this.#schedule();
  }

  showToast(
    pluginId: string,
    capabilities: ExtensionHostCapabilities,
    message: string,
    options: {kind?: "info" | "success" | "warning" | "error"; timeoutMs?: number} = {},
  ): ExtensionDisposable {
    requireUiCapability(capabilities, "ui.overlays");
    const host = document.createElement("div");
    host.dataset.zdpToast = pluginId;
    Object.assign(host.style, {position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483646"});
    const shadow = host.attachShadow({mode: "open"});
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.setAttribute("role", options.kind === "error" ? "alert" : "status");
    Object.assign(toast.style, {
      maxWidth: "420px", padding: "10px 14px", borderRadius: "10px", color: "white",
      background: options.kind === "error" ? "#b42318" : options.kind === "warning" ? "#a15c00" : options.kind === "success" ? "#18794e" : "#30333a",
      boxShadow: "0 10px 30px rgba(0,0,0,.28)", font: "13px system-ui",
    });
    shadow.append(toast);
    document.documentElement.append(host);
    const timer = window.setTimeout(() => host.remove(), options.timeoutMs ?? 4_000);
    return {dispose: () => { window.clearTimeout(timer); host.remove(); }};
  }

  showRuntimeError(pluginId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.showToast(pluginId, {
      apiVersion: 1,
      hostVersion: "unknown",
      zcodeVersion: "unknown",
      declared: [],
      granted: ["ui.overlays"],
      legacyDefaults: false,
      uiSlots: [],
      experimental: false,
    }, `Extension error: ${message}`, {kind: "error", timeoutMs: 8_000});
  }

  showDialog(
    capabilities: ExtensionHostCapabilities,
    options: {title: string; message: string; confirmLabel?: string; cancelLabel?: string},
  ): Promise<boolean> {
    requireUiCapability(capabilities, "ui.overlays");
    return Promise.resolve(window.confirm(`${options.title}\n\n${options.message}`));
  }

  disposePlugin(pluginId: string): void {
    for (const contribution of [...this.#contributions.values()]) {
      if (contribution.pluginId === pluginId) this.#remove(contribution);
    }
  }

  dispose(): void {
    this.#observer.disconnect();
    if (this.#frame !== undefined) window.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    for (const contribution of [...this.#contributions.values()]) this.#remove(contribution);
    this.#activeListeners.clear();
  }

  #add(input: Omit<Contribution, "id" | "instances">): ExtensionDisposable {
    const contribution: Contribution = {...input, id: crypto.randomUUID(), instances: new Map()};
    this.#contributions.set(contribution.id, contribution);
    this.#schedule();
    return {dispose: () => this.#remove(contribution)};
  }

  #remove(contribution: Contribution): void {
    if (!this.#contributions.delete(contribution.id)) return;
    for (const instance of contribution.instances.values()) {
      instance.cleanup();
      instance.host.remove();
    }
    contribution.instances.clear();
  }

  #schedule(): void {
    if (this.#frame !== undefined) return;
    this.#frame = window.requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#sync();
    });
  }

  #sync(): void {
    for (const contribution of this.#contributions.values()) {
      const targets = new Set(document.querySelectorAll(contribution.selector));
      for (const [target, instance] of contribution.instances) {
        if (!targets.has(target) || !target.isConnected || (contribution.when && !contribution.when(contextFrom(target)))) {
          instance.cleanup();
          instance.host.remove();
          contribution.instances.delete(target);
        }
      }
      for (const target of targets) {
        if (contribution.instances.has(target)) continue;
        const context = contextFrom(target);
        if (contribution.when && !contribution.when(context)) continue;
        const host = document.createElement("span");
        host.dataset.zdpContribution = contribution.pluginId;
        host.dataset.zdpOrder = String(contribution.order);
        if (contribution.placement === "overlay") Object.assign(host.style, {position: "absolute", inset: "0", pointerEvents: "none"});
        insertContribution(target, host, contribution.placement);
        const shadow = host.attachShadow({mode: "open"});
        const container = document.createElement("span");
        if (contribution.placement === "overlay") container.style.pointerEvents = "auto";
        shadow.append(container);
        const result = contribution.mount(container, context);
        contribution.instances.set(target, {host, cleanup: cleanupFunction(result)});
        this.#orderInstances(target, contribution.placement);
      }
    }
    const active = this.activeContext();
    const serialized = JSON.stringify(active);
    if (serialized !== this.#lastActive) {
      this.#lastActive = serialized;
      for (const listener of [...this.#activeListeners]) listener(active);
    }
  }

  #orderInstances(target: Element, placement: Contribution["placement"]): void {
    const hosts = [...this.#contributions.values()]
      .filter((contribution) => contribution.placement === placement && contribution.instances.has(target))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((contribution) => contribution.instances.get(target)!.host);
    if (placement === "before") target.before(...hosts);
    else if (placement === "after") target.after(...hosts);
    else if (placement === "prepend") target.prepend(...hosts);
    else target.append(...hosts);
  }
}

class DisposableStore implements ExtensionDisposable {
  readonly #items = new Set<ExtensionDisposable>();
  #disposed = false;
  add<T extends ExtensionDisposable>(disposable: T): T {
    if (this.#disposed) void disposable.dispose();
    else this.#items.add(disposable);
    return disposable;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const item of [...this.#items].reverse()) void item.dispose();
    this.#items.clear();
  }
}

function slotConfig(slot: UiContributionSlot): Pick<Contribution, "selector" | "placement"> {
  switch (slot) {
    case "sidebar.navigation": return {selector: "button[data-zdp-navigation-item]", placement: "append"};
    case "workspace.header.actions": return {selector: "[data-workspace-header-branch]", placement: "after"};
    case "task.row.trailing": return {selector: "[data-task-item-key]", placement: "append"};
    case "chat.header.actions": return {selector: '[data-testid="chat-view"]', placement: "prepend"};
    case "chat.overlay": return {selector: '[data-testid="chat-view"]', placement: "overlay"};
    case "chat.composer.leading": return {selector: '[data-chat-composer-region], [data-testid="chat-input"]', placement: "prepend"};
    case "chat.composer.trailing": return {selector: '[data-chat-composer-region], [data-testid="chat-input"]', placement: "append"};
    case "chat.turn.after": return {selector: "[data-chat-turn-group-shell]", placement: "after"};
    case "chat.message.before": return {selector: "[data-message-id][data-role]", placement: "before"};
    case "chat.message.after": return {selector: "[data-message-id][data-role]", placement: "after"};
    case "chat.message.footer": return {selector: "[data-message-id][data-role]", placement: "append"};
    case "chat.message.overlay": return {selector: "[data-message-id][data-role]", placement: "overlay"};
  }
}

function slotCapability(slot: UiContributionSlot): "ui.navigation" | "ui.workspace" | "ui.tasks" | "ui.chat" {
  if (slot.startsWith("sidebar.")) return "ui.navigation";
  if (slot.startsWith("workspace.")) return "ui.workspace";
  if (slot.startsWith("task.")) return "ui.tasks";
  return "ui.chat";
}

function streamCapability(stream: string): string | undefined {
  if (stream === "sessions.events") return "zcode.sessions.events";
  if (stream === "usage.modelRequests") return "zcode.usage.read";
  if (stream === "tasks.events") return "zcode.tasks.read";
  if (stream === "workspaces.events") return "zcode.workspaces.read";
  if (stream === "broadcast.events") return "zcode.broadcast";
  if (stream === "experimental.listen") return "experimental.zcode.rpc";
  return undefined;
}

function requireUiCapability(capabilities: ExtensionHostCapabilities, capability: string): void {
  if (!capabilities.granted.includes(capability as never)) throw new Error(`Extension must declare capability ${capability}`);
}

function insertContribution(target: Element, host: HTMLElement, placement: Contribution["placement"]): void {
  if (placement === "before") target.insertAdjacentElement("beforebegin", host);
  else if (placement === "after") target.insertAdjacentElement("afterend", host);
  else if (placement === "prepend") target.prepend(host);
  else target.append(host);
}

function contextFrom(target: Element): ActiveUiContext {
  const nearest = (attribute: string) => target.closest<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute) ?? undefined;
  const closest = (attribute: string) => nearest(attribute)
    ?? document.querySelector<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute)
    ?? undefined;
  const messageElement = target.matches("[data-message-id][data-role]")
    ? target as HTMLElement
    : target.matches("[data-chat-turn-group-shell]")
      ? target.querySelector<HTMLElement>('[data-message-id][data-role="assistant"]')
        ?? target.querySelector<HTMLElement>("[data-message-id][data-role]")
      : undefined;
  const taskItemKey = closest("data-task-item-key");
  const taskItemId = taskItemKey && taskItemKey.includes(":")
    ? taskItemKey.slice(taskItemKey.lastIndexOf(":") + 1)
    : undefined;
  return {
    workspacePath: closest("data-workspace-path"),
    workspaceIdentity: closest("data-workspace-identity"),
    taskId: closest("data-task-id") ?? taskItemId,
    sessionId: closest("data-session-id"),
    turnId: nearest("data-anchor-turn-id") ?? nearest("data-turn-id")
      ?? messageElement?.getAttribute("data-anchor-turn-id") ?? messageElement?.getAttribute("data-turn-id")
      ?? closest("data-anchor-turn-id") ?? closest("data-turn-id"),
    messageId: nearest("data-anchor-assistant-message-id")
      ?? messageElement?.getAttribute("data-message-id")
      ?? closest("data-message-id") ?? closest("data-anchor-assistant-message-id"),
    role: messageElement?.getAttribute("data-role") ?? closest("data-role"),
    runtimeStatus: closest("data-runtime-status"),
    toolCallId: closest("data-tool-call-id"),
  };
}

function cleanupFunction(value: unknown, after: () => void = () => undefined): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (typeof value === "function") value();
      else if (value && typeof value === "object" && "dispose" in value && typeof value.dispose === "function") value.dispose();
    } finally { after(); }
  };
}

function disposableFrom(value: unknown): ExtensionDisposable | undefined {
  if (typeof value === "function") return {dispose: value as () => unknown};
  if (value && typeof value === "object" && "dispose" in value && typeof value.dispose === "function") return value as ExtensionDisposable;
  return undefined;
}

function storageKey(pluginId: string, key: string): string {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(key)) throw new Error("Invalid extension storage key");
  return `zdp:${pluginId}:${key}`;
}

import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from "electron";
import type {JsonLogger} from "../shared/logger.ts";

export type DesktopServicePort = {
  port: MessagePortMain;
  process: UtilityProcess;
};

type PortListener = (entry: DesktopServicePort | undefined) => void;

/**
 * Captures an additional service port from ZCode's existing local host process.
 * The vendor process already supports attach-service-port; the wrapper only
 * observes its normal init-local handshake and requests another port.
 */
export class DesktopServicePortBroker {
  readonly #logger: JsonLogger;
  readonly #entries = new Map<UtilityProcess, DesktopServicePort>();
  readonly #listeners = new Set<PortListener>();
  readonly #originalFork = utilityProcess.fork.bind(utilityProcess);
  #active?: DesktopServicePort;
  #installed = false;

  constructor(logger: JsonLogger) {
    this.#logger = logger;
  }

  install(): void {
    if (this.#installed) return;
    this.#installed = true;
    const broker = this;
    const mutableUtilityProcess = utilityProcess as unknown as {fork: typeof utilityProcess.fork};
    mutableUtilityProcess.fork = function (...args: Parameters<typeof utilityProcess.fork>) {
      const child = broker.#originalFork(...args);
      broker.#observe(child);
      return child;
    } as typeof utilityProcess.fork;
  }

  current(): DesktopServicePort | undefined {
    return this.#active;
  }

  onChange(listener: PortListener): {dispose: () => void} {
    this.#listeners.add(listener);
    return {dispose: () => this.#listeners.delete(listener)};
  }

  waitForPort(timeoutMs = 60_000): Promise<DesktopServicePort> {
    if (this.#active) return Promise.resolve(this.#active);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        reject(new Error("Timed out waiting for the ZCode desktop service port"));
      }, timeoutMs);
      const disposable = this.onChange((entry) => {
        if (!entry) return;
        clearTimeout(timer);
        disposable.dispose();
        resolve(entry);
      });
    });
  }

  dispose(): void {
    if (this.#installed) {
      const mutableUtilityProcess = utilityProcess as unknown as {fork: typeof utilityProcess.fork};
      mutableUtilityProcess.fork = this.#originalFork as typeof utilityProcess.fork;
      this.#installed = false;
    }
    for (const entry of this.#entries.values()) closePort(entry.port);
    this.#entries.clear();
    this.#active = undefined;
    this.#emit(undefined);
    this.#listeners.clear();
  }

  #observe(child: UtilityProcess): void {
    const originalPostMessage = child.postMessage.bind(child);
    let attached = false;
    child.postMessage = ((message: unknown, transfer?: MessagePortMain[]) => {
      originalPostMessage(message, transfer);
      if (attached || !isInitLocal(message)) return;
      attached = true;
      queueMicrotask(() => {
        const {port1, port2} = new MessageChannelMain();
        try {
          originalPostMessage({type: "attach-service-port"}, [port2]);
          this.#attach({port: port1, process: child});
        } catch (error) {
          closePort(port1);
          closePort(port2);
          void this.#logger.warn("Could not attach to the ZCode desktop service port", {error});
        }
      });
    }) as UtilityProcess["postMessage"];

    child.once("exit", () => this.#remove(child));
  }

  #attach(entry: DesktopServicePort): void {
    this.#entries.set(entry.process, entry);
    if (this.#active) return;
    this.#active = entry;
    void this.#logger.info("Attached to the ZCode desktop service host", {pid: entry.process.pid});
    this.#emit(entry);
  }

  #remove(child: UtilityProcess): void {
    const entry = this.#entries.get(child);
    if (!entry) return;
    this.#entries.delete(child);
    closePort(entry.port);
    if (this.#active?.process !== child) return;
    this.#active = this.#entries.values().next().value as DesktopServicePort | undefined;
    this.#emit(this.#active);
  }

  #emit(entry: DesktopServicePort | undefined): void {
    for (const listener of [...this.#listeners]) listener(entry);
  }
}

export type Disposable = {dispose: () => unknown};

type RpcChannel = {
  call: (command: string, argument?: unknown) => Promise<unknown>;
  listen: (event: string, argument?: unknown) => (listener: (value: unknown) => void) => Disposable;
};

type RpcProtocol = {disconnect?: () => void};
type RpcClient = {
  getChannel: (name: string) => RpcChannel;
  dispose: () => void;
};

type RpcRuntime = {
  MessagePortProtocol: new (port: MessagePortLike) => RpcProtocol;
  ChannelClient: new (protocol: RpcProtocol) => RpcClient;
  ProxyChannel: {
    toService: <T>(channel: RpcChannel) => T;
  };
};

type MessagePortLike = {
  addEventListener: (type: string, listener: (event: {data?: unknown}) => void) => void;
  removeEventListener: (type: string, listener: (event: {data?: unknown}) => void) => void;
  postMessage: (message: unknown) => void;
  start: () => void;
  close: () => void;
};

export type DesktopServiceConnection = {
  broadcast: Record<string, unknown>;
  session: Record<string, unknown>;
  task: Record<string, unknown>;
  dispose: () => void;
};

let cachedRuntime: Promise<RpcRuntime> | undefined;

export async function connectDesktopServices(port: MessagePortMain, vendorAsar: string): Promise<DesktopServiceConnection> {
  const runtime = await (cachedRuntime ??= loadRpcRuntime(vendorAsar));
  const protocol = new runtime.MessagePortProtocol(toMessagePortLike(port));
  const client = new runtime.ChannelClient(protocol);
  return {
    broadcast: runtime.ProxyChannel.toService(client.getChannel("broadcast")),
    session: runtime.ProxyChannel.toService(client.getChannel("zcode-session")),
    task: runtime.ProxyChannel.toService(client.getChannel("zcode-task")),
    dispose: () => {
      client.dispose();
      protocol.disconnect?.();
    },
  };
}

export async function loadRpcRuntime(vendorAsar: string): Promise<RpcRuntime> {
  const hostDirectory = path.join(vendorAsar, "out", "host");
  const entries = await readdir(hostDirectory, {withFileTypes: true});
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const candidate = path.join(hostDirectory, entry.name);
    const source = await readFile(candidate, "utf8");
    if (!source.includes("MessagePortProtocol") || !source.includes("ChannelClient")) continue;
    const loaded = await import(pathToFileURL(candidate).href) as Record<string, unknown>;
    const values = Object.values(loaded);
    const MessagePortProtocol = values.find((value): value is RpcRuntime["MessagePortProtocol"] =>
      typeof value === "function" && value.name === "MessagePortProtocol",
    );
    const ChannelClient = values.find((value): value is RpcRuntime["ChannelClient"] =>
      typeof value === "function" && value.name === "ChannelClient",
    );
    const ProxyChannel = values.find((value): value is RpcRuntime["ProxyChannel"] =>
      Boolean(value && typeof value === "object" && "toService" in value && typeof value.toService === "function"),
    );
    if (MessagePortProtocol && ChannelClient && ProxyChannel) return {MessagePortProtocol, ChannelClient, ProxyChannel};
  }
  throw new Error("The installed ZCode build does not expose a compatible desktop RPC runtime");
}

function toMessagePortLike(port: MessagePortMain): MessagePortLike {
  const listeners = new Map<(event: {data?: unknown}) => void, (event: Electron.MessageEvent) => void>();
  return {
    addEventListener(_type, listener) {
      const wrapped = (event: Electron.MessageEvent) => listener(event);
      listeners.set(listener, wrapped);
      port.on("message", wrapped);
    },
    removeEventListener(_type, listener) {
      const wrapped = listeners.get(listener);
      if (wrapped) port.off("message", wrapped);
      listeners.delete(listener);
    },
    postMessage: (message) => port.postMessage(message),
    start: () => port.start(),
    close: () => port.close(),
  };
}

function isInitLocal(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "init-local");
}

function closePort(port: MessagePortMain): void {
  try { port.close(); } catch { /* already closed */ }
}

import {EventEmitter} from "node:events";
import type {JsonLogger} from "../shared/logger.ts";
import type {
  DesktopServiceConnection,
  DesktopServicePort,
  DesktopServicePortBroker,
  Disposable,
} from "./desktop-service.ts";

type GatewayOptions = {
  vendorAsar: string;
  portBroker: Pick<DesktopServicePortBroker, "current" | "onChange" | "waitForPort" | "dispose">;
  logger: JsonLogger;
  onHealth?: (status: "idle" | "starting" | "ready" | "error", error?: string) => void;
  connect?: (port: DesktopServicePort["port"], vendorAsar: string) => Promise<DesktopServiceConnection>;
};

type SubscriptionHub = {
  channel: string;
  event: string;
  argument: unknown;
  listeners: Set<(value: unknown) => void>;
  remote?: Disposable;
  lastSeq?: number;
  attachGeneration: number;
};

/** Shared reconnecting owner for every ZCode desktop service channel. */
export class ZCodeGateway extends EventEmitter {
  readonly #options: GatewayOptions;
  readonly #portSubscription: Disposable;
  readonly #subscriptions = new Map<string, SubscriptionHub>();
  #connection?: DesktopServiceConnection;
  #connecting?: Promise<DesktopServiceConnection>;
  #port?: DesktopServicePort;
  #disposed = false;
  #connectionGeneration = 0;

  constructor(options: GatewayOptions) {
    super();
    this.#options = options;
    this.#port = options.portBroker.current();
    this.#portSubscription = options.portBroker.onChange((entry) => this.#onPortChanged(entry));
  }

  async service<T extends Record<string, unknown> = Record<string, unknown>>(name: string): Promise<T> {
    const connection = await this.#ensureConnection();
    if (typeof connection.service === "function") return connection.service<T>(name);
    if (name === "broadcast") return connection.broadcast as T;
    if (name === "zcode-session") return connection.session as T;
    if (name === "zcode-task") return connection.task as T;
    throw new Error(`The ZCode desktop service connection does not expose ${name}`);
  }

  async call<T = unknown>(channel: string, command: string, argument?: unknown): Promise<T> {
    const connection = await this.#ensureConnection();
    return connection.channel(channel).call(command, argument) as Promise<T>;
  }

  subscribe<T = unknown>(
    channel: string,
    event: string,
    argument: unknown,
    listener: (value: T) => void,
  ): Disposable {
    if (this.#disposed) throw new Error("The ZCode service gateway is shut down");
    const key = subscriptionKey(channel, event, argument);
    let hub = this.#subscriptions.get(key);
    let created = false;
    if (!hub) {
      hub = {channel, event, argument, listeners: new Set(), attachGeneration: 0};
      this.#subscriptions.set(key, hub);
      created = true;
    }
    const callback = listener as (value: unknown) => void;
    hub.listeners.add(callback);
    if (created) void this.#attach(hub);
    let active = true;
    return {dispose: () => {
      if (!active) return;
      active = false;
      const current = this.#subscriptions.get(key);
      current?.listeners.delete(callback);
      if (current && current.listeners.size === 0) {
        current.remote?.dispose();
        this.#subscriptions.delete(key);
      }
    }};
  }

  async shutdown(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#portSubscription.dispose();
    for (const hub of this.#subscriptions.values()) hub.remote?.dispose();
    this.#subscriptions.clear();
    this.#connection?.dispose();
    this.#connection = undefined;
    this.#options.portBroker.dispose();
    this.#options.onHealth?.("idle");
  }

  async #ensureConnection(): Promise<DesktopServiceConnection> {
    if (this.#disposed) throw new Error("The ZCode service gateway is shut down");
    if (this.#connection) return this.#connection;
    if (this.#connecting) return this.#connecting;
    this.#options.onHealth?.("starting");
    const generation = this.#connectionGeneration;
    const connecting = (async () => {
      const entry = this.#port ?? await this.#options.portBroker.waitForPort();
      this.#port = entry;
      const connection = await (this.#options.connect ?? connectDesktopServices)(entry.port, this.#options.vendorAsar);
      if (generation !== this.#connectionGeneration) {
        connection.dispose();
        return this.#ensureConnection();
      }
      this.#connection = connection;
      this.#options.onHealth?.("ready");
      this.emit("connected");
      return connection;
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.onHealth?.("error", message);
      throw error;
    }).finally(() => {
      if (this.#connecting === connecting) this.#connecting = undefined;
    });
    this.#connecting = connecting;
    return connecting;
  }

  async #attach(hub: SubscriptionHub): Promise<void> {
    const attachGeneration = ++hub.attachGeneration;
    hub.remote?.dispose();
    hub.remote = undefined;
    if (hub.listeners.size === 0 || this.#disposed) return;
    try {
      const connection = await this.#ensureConnection();
      if (attachGeneration !== hub.attachGeneration || hub.listeners.size === 0 || this.#disposed) return;
      const argument = replayArgument(hub.argument, hub.lastSeq);
      const remote = connection.channel(hub.channel).listen(hub.event, argument)((value) => {
        const seq = eventSequence(value);
        if (seq !== undefined) {
          if (hub.lastSeq !== undefined && seq <= hub.lastSeq) return;
          hub.lastSeq = seq;
        }
        for (const listener of [...hub.listeners]) listener(value);
      });
      if (attachGeneration !== hub.attachGeneration || hub.listeners.size === 0 || this.#disposed) remote.dispose();
      else hub.remote = remote;
    } catch (error) {
      await this.#options.logger.warn("Could not attach a ZCode service subscription", {
        channel: hub.channel,
        event: hub.event,
        error,
      });
    }
  }

  #onPortChanged(entry: DesktopServicePort | undefined): void {
    if (entry?.process === this.#port?.process) return;
    this.#port = entry;
    this.#connectionGeneration += 1;
    for (const hub of this.#subscriptions.values()) {
      hub.attachGeneration += 1;
      hub.remote?.dispose();
      hub.remote = undefined;
    }
    this.#connection?.dispose();
    this.#connection = undefined;
    this.#connecting = undefined;
    if (!entry) {
      this.#options.onHealth?.("error", "The ZCode desktop service host is unavailable");
      this.emit("disconnected");
      return;
    }
    this.#options.onHealth?.("starting");
    void this.#ensureConnection().then(() => {
      for (const hub of this.#subscriptions.values()) void this.#attach(hub);
    });
  }
}

async function connectDesktopServices(
  port: DesktopServicePort["port"],
  vendorAsar: string,
): Promise<DesktopServiceConnection> {
  const desktop = await import("./desktop-service.ts");
  return desktop.connectDesktopServices(port, vendorAsar);
}

function subscriptionKey(channel: string, event: string, argument: unknown): string {
  return `${channel}\0${event}\0${stableJson(argument)}`;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function replayArgument(argument: unknown, lastSeq: number | undefined): unknown {
  if (lastSeq === undefined || !argument || typeof argument !== "object" || Array.isArray(argument)) return argument;
  return {...argument as Record<string, unknown>, afterSeq: lastSeq, includeSnapshot: true};
}

function eventSequence(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const event = record.event && typeof record.event === "object" ? record.event as Record<string, unknown> : record;
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : undefined;
}

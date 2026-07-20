import {EventEmitter} from "node:events";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import readline from "node:readline";
import type {JsonLogger} from "../shared/logger.ts";

type ProtocolMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {code: number; message: string; data?: unknown};
};

export type ProtocolRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export type ProtocolClientOptions = {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger: JsonLogger;
  requestHandler: ProtocolRequestHandler;
};

export class ProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
}

export class ZCodeProtocolClient extends EventEmitter {
  readonly #options: ProtocolClientOptions;
  #child?: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(options: ProtocolClientOptions) {
    super();
    this.#options = options;
  }

  get running(): boolean {
    return Boolean(this.#child && this.#child.exitCode === null && !this.#child.killed);
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const child = spawn(this.#options.executable, this.#options.args, {
      cwd: this.#options.cwd,
      env: {...process.env, ...this.#options.env},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const lineReader = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
    lineReader.on("line", (line) => void this.#onLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) void this.#options.logger.debug("app-server stderr", {text: text.slice(-4000)});
    });
    child.once("error", (error) => this.#onExit(error));
    child.once("exit", (code, signal) => this.#onExit(new Error(`ZCode app-server exited (${code ?? signal ?? "unknown"})`)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await this.#options.logger.info("ZCode app-server started", {pid: child.pid});
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.running || !this.#child) return Promise.reject(new Error("ZCode app-server is not running"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`ZCode Protocol request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {resolve: resolve as (value: unknown) => void, reject, timer});
      this.#send({id, method, ...(params === undefined ? {} : {params})});
    });
  }

  async stop(forceAfterMs = 2_000): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const forced = new Promise<void>((resolve) => setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
      resolve();
    }, forceAfterMs));
    await Promise.race([exited, forced]);
  }

  async #onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: ProtocolMessage;
    try {
      message = JSON.parse(line) as ProtocolMessage;
    } catch (error) {
      await this.#options.logger.warn("Ignored malformed app-server output", {line: line.slice(0, 1000), error});
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.#pending.get(numericId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(numericId);
      if (message.error) pending.reject(new ProtocolError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }

    if (message.method && message.id !== undefined) {
      try {
        const result = await this.#options.requestHandler(message.method, message.params);
        this.#send({id: message.id, result});
      } catch (error) {
        this.#send({
          id: message.id,
          error: {code: -32000, message: error instanceof Error ? error.message : String(error)},
        });
      }
      return;
    }

    if (message.method) this.emit("notification", message.method, message.params);
  }

  #send(message: ProtocolMessage): void {
    if (!this.#child?.stdin.writable) throw new Error("ZCode app-server stdin is closed");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onExit(error: Error): void {
    if (this.#child === undefined) return;
    this.#child = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("exit", error);
    void this.#options.logger.warn("ZCode app-server stopped", {error});
  }
}

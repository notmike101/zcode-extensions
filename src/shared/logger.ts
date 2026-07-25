import {appendFile, mkdir, readFile, stat, rename, rm} from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export class JsonLogger {
  readonly #filePath: string;
  readonly #scope: string;

  constructor(filePath: string, scope: string) {
    this.#filePath = filePath;
    this.#scope = scope;
  }

  child(scope: string): JsonLogger {
    return new JsonLogger(this.#filePath, `${this.#scope}:${scope}`);
  }

  debug(message: string, data?: unknown) { return this.#write("debug", message, data); }
  info(message: string, data?: unknown) { return this.#write("info", message, data); }
  warn(message: string, data?: unknown) { return this.#write("warn", message, data); }
  error(message: string, data?: unknown) { return this.#write("error", message, data); }

  async tail(lines = 100): Promise<string[]> {
    try {
      const content = await readFile(this.#filePath, "utf8");
      return content.trim().split(/\r?\n/).slice(-lines);
    } catch {
      return [];
    }
  }

  async #write(level: LogLevel, message: string, data?: unknown): Promise<void> {
    await mkdir(path.dirname(this.#filePath), {recursive: true});
    try {
      const file = await stat(this.#filePath).catch(() => null);
      if (file && file.size > 10 * 1024 * 1024) {
        await rm(`${this.#filePath}.5`, {force: true});
        for (let index = 4; index >= 1; index -= 1) {
          await rename(`${this.#filePath}.${index}`, `${this.#filePath}.${index + 1}`).catch(() => undefined);
        }
        await rename(this.#filePath, `${this.#filePath}.1`).catch(() => undefined);
      }
    } catch {
      // Logging must never prevent ZCode from starting.
    }
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope: this.#scope,
      message,
      ...(data === undefined ? {} : {data: serializeError(data)}),
    };
    await appendFile(this.#filePath, `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
  }
}

function serializeError(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Object.keys(value)) {
      serialized[key] = serializeError((value as unknown as Record<string, unknown>)[key], seen);
    }
    if (value.cause !== undefined) serialized.cause = serializeError(value.cause, seen);
    return serialized;
  }
  if (Array.isArray(value)) return value.map((item) => serializeError(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeError(item, seen)]));
}

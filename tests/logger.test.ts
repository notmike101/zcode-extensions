import {afterEach, describe, expect, test} from "bun:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {JsonLogger} from "../src/shared/logger.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe("JSON logging", () => {
  test("serializes nested errors with their messages and filesystem details", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zdp-logger-"));
    directories.push(directory);
    const file = path.join(directory, "host.jsonl");
    const error = Object.assign(new Error("incompatible extension"), {
      code: "EPERM",
      path: "old",
      dest: "new",
    });

    await new JsonLogger(file, "test").error("install failed", {root: "example", error});

    const entry = JSON.parse(await readFile(file, "utf8"));
    expect(entry.data.error).toMatchObject({
      name: "Error",
      message: "incompatible extension",
      code: "EPERM",
      path: "old",
      dest: "new",
    });
  });

  test("does not fail when diagnostic data contains a cycle", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zdp-logger-"));
    directories.push(directory);
    const file = path.join(directory, "host.jsonl");
    const data: {self?: unknown} = {};
    data.self = data;

    await new JsonLogger(file, "test").error("cyclic data", data);

    const entry = JSON.parse(await readFile(file, "utf8"));
    expect(entry.data.self).toBe("[Circular]");
  });
});

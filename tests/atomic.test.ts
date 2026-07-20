import {afterEach, describe, expect, test} from "bun:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {writeJsonAtomic} from "../src/shared/atomic.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true}))); });

describe("atomic JSON persistence", () => {
  test("replaces a file without leaving temporary files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zdp-atomic-"));
    directories.push(directory);
    const file = path.join(directory, "state.json");
    await writeJsonAtomic(file, {version: 1});
    await writeJsonAtomic(file, {version: 2});
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({version: 2});
  });
});

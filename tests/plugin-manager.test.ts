import {afterEach, describe, expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {installStagedExtension} from "../src/host/plugin-manager.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

describe("extension installation", () => {
  test("replaces an untracked destination while preserving it in trash", async () => {
    const root = await temporaryRoot();
    const staging = path.join(root, "staging");
    const destination = path.join(root, "plugins", "example");
    const trash = path.join(root, "trash");
    await mkdir(staging, {recursive: true});
    await mkdir(destination, {recursive: true});
    await writeFile(path.join(staging, "version.txt"), "new");
    await writeFile(path.join(destination, "version.txt"), "old");

    const displaced = await installStagedExtension(staging, destination, trash);

    expect(displaced).toBeString();
    expect(await readFile(path.join(destination, "version.txt"), "utf8")).toBe("new");
    expect(await readFile(path.join(displaced!, "version.txt"), "utf8")).toBe("old");
  });

  test("restores an untracked destination when installing the replacement fails", async () => {
    const root = await temporaryRoot();
    const staging = path.join(root, "staging");
    const destination = path.join(root, "plugins", "example");
    const trash = path.join(root, "trash");
    await mkdir(staging, {recursive: true});
    await mkdir(destination, {recursive: true});
    await writeFile(path.join(staging, "version.txt"), "new");
    await writeFile(path.join(destination, "version.txt"), "old");
    const failingRename: typeof rename = async (source, target) => {
      if (source === staging && target === destination) {
        throw Object.assign(new Error("simulated install failure"), {code: "EIO"});
      }
      await rename(source, target);
    };

    await expect(installStagedExtension(staging, destination, trash, failingRename)).rejects.toThrow(
      "simulated install failure",
    );

    expect(await readFile(path.join(destination, "version.txt"), "utf8")).toBe("old");
    expect(await readFile(path.join(staging, "version.txt"), "utf8")).toBe("new");
  });

  test("copies over a locked untracked destination and keeps a backup", async () => {
    const root = await temporaryRoot();
    const staging = path.join(root, "staging");
    const destination = path.join(root, "plugins", "example");
    const trash = path.join(root, "trash");
    await mkdir(staging, {recursive: true});
    await mkdir(destination, {recursive: true});
    await writeFile(path.join(staging, "version.txt"), "new");
    await writeFile(path.join(destination, "version.txt"), "old");
    const lockedRename: typeof rename = async () => {
      throw Object.assign(new Error("directory is locked"), {code: "EPERM"});
    };

    const displaced = await installStagedExtension(staging, destination, trash, lockedRename, 1, 0);

    expect(await readFile(path.join(destination, "version.txt"), "utf8")).toBe("new");
    expect(await readFile(path.join(displaced!, "version.txt"), "utf8")).toBe("old");
  });
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zdp-plugin-manager-"));
  directories.push(directory);
  return directory;
}

import {createHash} from "node:crypto";
import {afterEach, describe, expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {applyHostUpdate} from "../src/cli/host-update-apply.ts";
import type {ReleaseManifest} from "../src/host/host-updater.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))));

describe("host update apply transaction", () => {
  test("replaces only managed files, preserves data and unknown files, and records runtime fallback", async () => {
    const fixture = await fixtureRoot();
    let launched: string | undefined;
    let repairedVersion: string | undefined;
    await applyHostUpdate(42, fixture.root, {
      processAlive: () => false, zcodeRunning: () => false,
      repair: async (_zcode, options) => { repairedVersion = options?.loaderVersion; return {} as never; },
      launch: (executable) => { launched = executable; },
    });
    expect(await readFile(path.join(fixture.root, "bin", "zdp.exe"), "utf8")).toBe("new");
    expect(await exists(path.join(fixture.root, "obsolete.txt"))).toBe(false);
    expect(await readFile(path.join(fixture.root, "new.txt"), "utf8")).toBe("added");
    expect(await readFile(path.join(fixture.root, "data", "keep.txt"), "utf8")).toBe("private");
    expect(await readFile(path.join(fixture.root, "unknown.txt"), "utf8")).toBe("unknown");
    expect(JSON.parse(await readFile(path.join(fixture.root, "runtime", "current.json"), "utf8"))).toEqual({version: "0.3.7", previousVersion: "0.3.6"});
    expect(repairedVersion).toBe("0.3.7");
    expect(launched).toBe(path.join(fixture.zcodeRoot, "ZCode.exe"));
    expect(await exists(path.join(fixture.root, "data", "host-update.json"))).toBe(false);
    expect(await readFile(path.join(fixture.root, "data", ".host-update", "backup", "0.3.6", "bin", "zdp.exe"), "utf8")).toBe("old");
  });

  test("rolls managed files back and records failure when repair rejects the new host", async () => {
    const fixture = await fixtureRoot();
    let repairs = 0;
    await applyHostUpdate(42, fixture.root, {
      processAlive: () => false, zcodeRunning: () => false,
      repair: async () => { repairs += 1; if (repairs === 1) throw new Error("repair rejected new host"); return {} as never; },
      launch() {},
    });
    expect(await readFile(path.join(fixture.root, "bin", "zdp.exe"), "utf8")).toBe("old");
    expect(await readFile(path.join(fixture.root, "obsolete.txt"), "utf8")).toBe("old-only");
    expect(await exists(path.join(fixture.root, "new.txt"))).toBe(false);
    expect(JSON.parse(await readFile(path.join(fixture.root, "runtime", "current.json"), "utf8"))).toEqual({version: "0.3.6"});
    const state = JSON.parse(await readFile(path.join(fixture.root, "data", "host-update.json"), "utf8")) as {phase: string; error: string};
    expect(state).toMatchObject({phase: "failed", error: "repair rejected new host"});
    expect(repairs).toBe(2);
  });
});

async function fixtureRoot(): Promise<{root: string; zcodeRoot: string}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zdp-host-apply-"));
  roots.push(root);
  const zcodeRoot = path.join(root, "fake-zcode");
  const currentFiles = new Map([
    ["bin/zdp.exe", "old"], ["obsolete.txt", "old-only"], ["runtime/current.json", `${JSON.stringify({version: "0.3.6"}, null, 2)}\n`],
  ]);
  await writeRelease(root, "0.3.6", currentFiles);
  await mkdir(path.join(root, "data"), {recursive: true});
  await writeFile(path.join(root, "data", "keep.txt"), "private");
  await writeFile(path.join(root, "unknown.txt"), "unknown");

  const stagingRoot = path.join(root, "data", ".host-update", "transaction", "extracted", "zcode-extensions");
  const incomingFiles = new Map([
    ["bin/zdp.exe", "new"], ["new.txt", "added"], ["runtime/current.json", `${JSON.stringify({version: "0.3.7"}, null, 2)}\n`],
  ]);
  await writeRelease(stagingRoot, "0.3.7", incomingFiles);
  await writeFile(path.join(root, "data", "host-update.json"), JSON.stringify({
    schemaVersion: 1, phase: "ready", currentVersion: "0.3.6", targetVersion: "0.3.7",
    stagingRoot, zcodeRoot, releaseUrl: "https://example.com/releases/0.3.7",
  }));
  return {root, zcodeRoot};
}

async function writeRelease(root: string, version: string, files: Map<string, string>): Promise<void> {
  const manifest: ReleaseManifest = {schemaVersion: 1, version, files: []};
  for (const [relative, contents] of files) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, contents);
    const bytes = Buffer.from(contents);
    manifest.files.push({path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length});
  }
  await writeFile(path.join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
async function exists(value: string): Promise<boolean> { return stat(value).then(() => true).catch(() => false); }

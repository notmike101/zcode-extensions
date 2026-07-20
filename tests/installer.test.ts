import {afterEach, describe, expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {link, mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {doctor, installOrRepair, uninstall} from "../src/cli/installer.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true}))); });

describe("Windows loader installer", () => {
  test("installs, repairs idempotently, and restores the exact vendor ASAR", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "zdp-installer-"));
    temporaryDirectories.push(fixture);
    const zcodeRoot = path.join(fixture, "ZCode");
    const resources = path.join(zcodeRoot, "resources");
    const zdpRoot = path.join(fixture, "zdp");
    await mkdir(resources, {recursive: true});
    await mkdir(path.join(zdpRoot, "runtime"), {recursive: true});
    await link("C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\ZCode.exe", path.join(zcodeRoot, "ZCode.exe"));
    const liveResources = "C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\resources";
    const liveAsar = await exists(path.join(liveResources, "app.asar")) ? path.join(liveResources, "app.asar") : path.join(liveResources, "zcode.original.asar");
    await link(liveAsar, path.join(resources, "app.asar"));
    await writeFile(path.join(zdpRoot, "runtime", "bootstrap.mjs"), "export {};\n");
    await writeFile(path.join(zdpRoot, "runtime", "current.json"), '{"version":"test"}\n');
    const originalHash = await sha256(path.join(resources, "app.asar"));

    const installed = await installOrRepair(zcodeRoot, {skipProcessCheck: true, manageShortcut: false, stateRoot: zdpRoot});
    expect(installed.installed).toBe(true);
    expect(await exists(path.join(resources, "app.asar"))).toBe(false);
    expect(await exists(path.join(resources, "zcode.original.asar"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(resources, "app", "package.json"), "utf8")).zdpLoader).toBe(true);
    expect(await sha256(path.join(resources, "zcode.original.asar"))).toBe(originalHash);

    const repaired = await installOrRepair(zcodeRoot, {skipProcessCheck: true, manageShortcut: false, stateRoot: zdpRoot});
    expect(repaired.vendorAsarSha256).toBe(originalHash);
    expect((await doctor(zcodeRoot, zdpRoot)).ok).toBe(true);

    await uninstall(zcodeRoot, false, {skipProcessCheck: true, manageShortcut: false, stateRoot: zdpRoot});
    expect(await exists(path.join(resources, "app"))).toBe(false);
    expect(await exists(path.join(resources, "zcode.original.asar"))).toBe(false);
    expect(await sha256(path.join(resources, "app.asar"))).toBe(originalHash);
  }, 60_000);
});

async function exists(filePath: string): Promise<boolean> { return stat(filePath).then(() => true).catch(() => false); }
async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

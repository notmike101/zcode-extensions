import {afterEach, describe, expect, test} from "bun:test";
import {createPackage} from "@electron/asar";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {doctor, installOrRepair, uninstall} from "../src/cli/installer.ts";

const temporaryDirectories: string[] = [];
const ELECTRON_FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
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
    await writeFile(path.join(zcodeRoot, "ZCode.exe"), electronFuseFixture());
    const vendorApp = path.join(fixture, "vendor-app");
    await mkdir(path.join(vendorApp, "out", "main"), {recursive: true});
    await writeFile(path.join(vendorApp, "package.json"), JSON.stringify({
      name: "@zcode/desktop",
      productName: "ZCode",
      version: "3.3.6",
      main: "out/main/index.js",
    }));
    await writeFile(path.join(vendorApp, "out", "main", "index.js"), "export {};\n");
    await createPackage(vendorApp, path.join(resources, "app.asar"));
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

function electronFuseFixture(): Buffer {
  return Buffer.concat([
    Buffer.from("MZ"),
    Buffer.from(ELECTRON_FUSE_SENTINEL),
    Buffer.from([1, 9, ...Array<number>(9).fill(48)]),
  ]);
}

async function exists(filePath: string): Promise<boolean> { return stat(filePath).then(() => true).catch(() => false); }
async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

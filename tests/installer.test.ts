import {afterEach, describe, expect, test} from "bun:test";
import {createPackage} from "@electron/asar";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {doctor, installOrRepair, uninstall} from "../src/cli/installer.ts";
import {DEFAULT_ZCODE_ROOT, ZDP_EXECUTABLE, ZDP_LAUNCHER_EXECUTABLE, getZCodeLayout} from "../src/shared/constants.ts";

const temporaryDirectories: string[] = [];
const ELECTRON_FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true}))); });

describe("loader installer", () => {
  test("keeps platform-specific executable names and layout", () => {
    const layout = getZCodeLayout("/zcode-root");
    if (process.platform === "win32") {
      expect(DEFAULT_ZCODE_ROOT).toContain("Programs");
      expect(ZDP_EXECUTABLE).toBe("zdp.exe");
      expect(ZDP_LAUNCHER_EXECUTABLE).toBe("zdp-launcher.exe");
      expect(layout.electronExecutable).toEndWith("ZCode.exe");
      expect(layout.launchArgs).toEqual([]);
    } else {
      expect(ZDP_EXECUTABLE).toBe("zdp");
      expect(ZDP_LAUNCHER_EXECUTABLE).toBe("zdp-launcher");
      expect(layout.electronExecutable).toEndWith("zcode");
      expect(layout.launchArgs).toEqual(["--no-sandbox"]);
    }
  });

  test("installs, repairs idempotently, and restores the exact vendor ASAR", async () => {
    const fixture = await installFixture();
    const {zcodeRoot, zdpRoot, resources} = fixture;
    const originalHash = await sha256(path.join(resources, "app.asar"));

    const installed = await installOrRepair(zcodeRoot, {skipProcessCheck: true, manageShortcut: false, stateRoot: zdpRoot});
    expect(installed.installed).toBe(true);
    expect(await exists(path.join(resources, "app.asar"))).toBe(false);
    expect(await exists(path.join(resources, "zcode.original.asar"))).toBe(true);
    expect(await readFile(path.join(resources, "zcode.original.asar.unpacked", "native.node"), "utf8")).toBe("native");
    expect(JSON.parse(await readFile(path.join(resources, "app", "package.json"), "utf8")).zdpLoader).toBe(true);
    expect(await sha256(path.join(resources, "zcode.original.asar"))).toBe(originalHash);

    const repaired = await installOrRepair(zcodeRoot, {skipProcessCheck: true, manageShortcut: false, stateRoot: zdpRoot});
    expect(repaired.vendorAsarSha256).toBe(originalHash);
    expect((await doctor(zcodeRoot, zdpRoot)).ok).toBe(true);

    await uninstall(zcodeRoot, false, {skipProcessCheck: true, manageShortcut: false, stateRoot: zdpRoot});
    expect(await exists(path.join(resources, "app"))).toBe(false);
    expect(await exists(path.join(resources, "zcode.original.asar"))).toBe(false);
    expect(await readFile(path.join(resources, "app.asar.unpacked", "native.node"), "utf8")).toBe("native");
    expect(await sha256(path.join(resources, "app.asar"))).toBe(originalHash);
  }, 60_000);

  test("removes a desktop entry it generated when no original shortcut existed", async () => {
    const fixture = await installFixture();
    const shortcutPath = path.join(fixture.dataHome, "applications", process.platform === "win32" ? "ZCode.lnk" : "zcode.desktop");
    const previousDataHome = process.env.XDG_DATA_HOME;
    const previousAppData = process.env.APPDATA;
    process.env.XDG_DATA_HOME = fixture.dataHome;
    process.env.APPDATA = fixture.dataHome;
    try {
      await installOrRepair(fixture.zcodeRoot, {skipProcessCheck: true, stateRoot: fixture.zdpRoot});
      const state = JSON.parse(await readFile(path.join(fixture.zdpRoot, "data", "install-state.json"), "utf8")) as {shortcut?: {path: string; created?: boolean}};
      expect(state.shortcut?.path).toBe(shortcutPath);
      expect(state.shortcut?.created).toBe(true);
      expect(await exists(shortcutPath)).toBe(true);

      await uninstall(fixture.zcodeRoot, false, {skipProcessCheck: true, stateRoot: fixture.zdpRoot});
      expect(await exists(shortcutPath)).toBe(false);
    } finally {
      restoreEnv("XDG_DATA_HOME", previousDataHome);
      restoreEnv("APPDATA", previousAppData);
    }
  }, 60_000);

  test("removes a generated desktop entry left by installs that recorded no shortcut state", async () => {
    const fixture = await installFixture();
    const shortcutPath = path.join(fixture.dataHome, "applications", "zcode.desktop");
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = fixture.dataHome;
    try {
      await installOrRepair(fixture.zcodeRoot, {skipProcessCheck: true, stateRoot: fixture.zdpRoot});
      const stateFile = path.join(fixture.zdpRoot, "data", "install-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {shortcut?: unknown};
      delete state.shortcut;
      await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
      expect(await exists(shortcutPath)).toBe(true);

      await uninstall(fixture.zcodeRoot, false, {skipProcessCheck: true, stateRoot: fixture.zdpRoot});
      expect(await exists(shortcutPath)).toBe(false);
    } finally {
      restoreEnv("XDG_DATA_HOME", previousDataHome);
    }
  }, 60_000);

  test("restores the previous desktop entry on uninstall", async () => {
    const fixture = await installFixture();
    const shortcutPath = path.join(fixture.dataHome, "applications", "zcode.desktop");
    const original = "[Desktop Entry]\nName=ZCode\nExec=\"/opt/zcode.AppImage\" %U\nType=Application\n";
    await mkdir(path.dirname(shortcutPath), {recursive: true});
    await writeFile(shortcutPath, original, "utf8");
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = fixture.dataHome;
    try {
      await installOrRepair(fixture.zcodeRoot, {skipProcessCheck: true, stateRoot: fixture.zdpRoot});
      const state = JSON.parse(await readFile(path.join(fixture.zdpRoot, "data", "install-state.json"), "utf8")) as {shortcut?: {created?: boolean}};
      expect(state.shortcut?.created).toBe(false);
      if (process.platform !== "win32") expect(await readFile(shortcutPath, "utf8")).toContain(path.join(fixture.zdpRoot, "bin", ZDP_LAUNCHER_EXECUTABLE));

      await uninstall(fixture.zcodeRoot, false, {skipProcessCheck: true, stateRoot: fixture.zdpRoot});
      if (process.platform !== "win32") {
        expect(await readFile(shortcutPath, "utf8")).toBe(original);
        expect((await doctor(fixture.zcodeRoot, fixture.zdpRoot)).shortcutManaged).toBe(false);
      }
    } finally {
      restoreEnv("XDG_DATA_HOME", previousDataHome);
    }
  }, 60_000);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function installFixture(): Promise<{zcodeRoot: string; zdpRoot: string; resources: string; dataHome: string}> {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "zdp-installer-"));
  temporaryDirectories.push(fixture);
  const zcodeRoot = path.join(fixture, "ZCode");
  const resources = path.join(zcodeRoot, "resources");
  const zdpRoot = path.join(fixture, "zdp");
  const dataHome = path.join(fixture, "data-home");
  await mkdir(resources, {recursive: true});
  await mkdir(path.join(zdpRoot, "runtime"), {recursive: true});
  await mkdir(path.join(zdpRoot, "bin"), {recursive: true});
  await writeFile(path.join(zdpRoot, "bin", ZDP_LAUNCHER_EXECUTABLE), "launcher");
  await writeFile(getZCodeLayout(zcodeRoot).electronExecutable, electronFuseFixture());
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
  await mkdir(path.join(resources, "app.asar.unpacked"), {recursive: true});
  await writeFile(path.join(resources, "app.asar.unpacked", "native.node"), "native");
  await writeFile(path.join(zdpRoot, "runtime", "bootstrap.mjs"), "export {};\n");
  await writeFile(path.join(zdpRoot, "runtime", "current.json"), '{"version":"test"}\n');
  return {zcodeRoot, zdpRoot, resources, dataHome};
}

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

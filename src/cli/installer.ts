import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {extractFile} from "@electron/asar";
import {FuseState, FuseV1Options, getCurrentFuseWire} from "@electron/fuses";
import {DEFAULT_ZCODE_ROOT, HOST_VERSION, getPaths, resolveZdpRoot} from "../shared/constants.ts";
import {writeJsonAtomic} from "../shared/atomic.ts";
import {installStateSchema, type InstallState} from "../shared/schemas.ts";
import {defaultShortcutPath, readShortcut, restoreShortcut, writeLauncherShortcut} from "./shortcut.ts";

type VendorPackage = {name?: string; productName?: string; version: string; type?: string; main?: string};

export type DoctorReport = {
  ok: boolean;
  installed: boolean;
  zcodeRoot: string;
  zcodeVersion?: string;
  vendorAsar?: string;
  vendorAsarSha256?: string;
  loaderPresent: boolean;
  runtimePresent: boolean;
  shortcutManaged: boolean;
  fuses?: Record<string, string>;
  errors: string[];
};

export async function doctor(zcodeRoot = DEFAULT_ZCODE_ROOT, zdpRoot = resolveZdpRoot()): Promise<DoctorReport> {
  const root = zdpRoot;
  const paths = getPaths(root);
  const errors: string[] = [];
  const resources = path.join(zcodeRoot, "resources");
  const exe = path.join(zcodeRoot, "ZCode.exe");
  const appAsar = path.join(resources, "app.asar");
  const originalAsar = path.join(resources, "zcode.original.asar");
  const vendorAsar = await exists(originalAsar) ? originalAsar : await exists(appAsar) ? appAsar : undefined;
  if (!await exists(exe)) errors.push(`Missing ZCode executable: ${exe}`);
  if (!vendorAsar) errors.push("No vendor app.asar or zcode.original.asar was found");
  let vendorPackage: VendorPackage | undefined;
  let vendorAsarSha256: string | undefined;
  if (vendorAsar) {
    try { vendorPackage = readPackage(vendorAsar); vendorAsarSha256 = await sha256(vendorAsar); }
    catch (error) { errors.push(`Could not read vendor ASAR: ${errorText(error)}`); }
  }
  let fuses: Record<string, string> | undefined;
  if (await exists(exe)) {
    try {
      const wire = await getCurrentFuseWire(exe);
      fuses = fuseReport(wire as unknown as Record<number, FuseState>);
      if ((wire as unknown as Record<number, FuseState>)[FuseV1Options.OnlyLoadAppFromAsar] === FuseState.ENABLE) errors.push("OnlyLoadAppFromAsar is enabled");
      if ((wire as unknown as Record<number, FuseState>)[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] === FuseState.ENABLE) errors.push("Embedded ASAR integrity validation is enabled");
    } catch (error) { errors.push(`Could not read Electron fuses: ${errorText(error)}`); }
  }
  const loaderPresent = await isManagedLoader(path.join(resources, "app"));
  const runtimePresent = await exists(paths.runtimeBootstrap) && await exists(paths.runtimeCurrent);
  const installState = await readInstallState(paths.installState);
  const shortcut = await readShortcut().catch(() => undefined);
  const shortcutManaged = Boolean(shortcut && path.resolve(shortcut.originalTarget) === path.resolve(path.join(paths.bin, "zdp-launcher.exe")));
  return {
    ok: errors.length === 0 && runtimePresent,
    installed: loaderPresent && Boolean(await exists(originalAsar)),
    zcodeRoot,
    ...(vendorPackage ? {zcodeVersion: vendorPackage.version} : {}),
    ...(vendorAsar ? {vendorAsar} : {}),
    ...(vendorAsarSha256 ? {vendorAsarSha256} : {}),
    loaderPresent,
    runtimePresent,
    shortcutManaged: shortcutManaged || Boolean(installState?.shortcut),
    ...(fuses ? {fuses} : {}),
    errors,
  };
}

export async function installOrRepair(zcodeRoot = DEFAULT_ZCODE_ROOT, options: {skipProcessCheck?: boolean; manageShortcut?: boolean; stateRoot?: string; loaderVersion?: string} = {}): Promise<DoctorReport> {
  const root = options.stateRoot ?? resolveZdpRoot();
  const paths = getPaths(root);
  if (!options.skipProcessCheck) assertZCodeClosed();
  if (!await exists(paths.runtimeBootstrap) || !await exists(paths.runtimeCurrent)) throw new Error("Build the ZDP runtime before installing");
  const before = await doctor(zcodeRoot, root);
  if (before.errors.length) throw new Error(`ZCode is not patchable:\n- ${before.errors.join("\n- ")}`);
  const resources = path.join(zcodeRoot, "resources");
  const appAsar = path.join(resources, "app.asar");
  const originalAsar = path.join(resources, "zcode.original.asar");
  let vendorAsar: string;
  if (await exists(appAsar)) {
    const incomingPackage = readPackage(appAsar);
    await backupVendor(appAsar, incomingPackage.version, paths.backups);
    if (await exists(originalAsar)) {
      const previousPackage = readPackage(originalAsar);
      await backupVendor(originalAsar, previousPackage.version, paths.backups);
      await rm(originalAsar, {force: true});
    }
    await rename(appAsar, originalAsar);
    vendorAsar = originalAsar;
  } else if (await exists(originalAsar)) {
    vendorAsar = originalAsar;
    const currentPackage = readPackage(vendorAsar);
    await backupVendor(vendorAsar, currentPackage.version, paths.backups);
  } else {
    throw new Error("ZCode vendor ASAR is missing");
  }
  const vendorPackage = readPackage(vendorAsar);
  const vendorHash = await sha256(vendorAsar);
  await writeLoader(resources, root, zcodeRoot, vendorPackage);
  const existingState = await readInstallState(paths.installState);
  const manageShortcut = options.manageShortcut ?? true;
  const shortcutPath = existingState?.shortcut?.path ?? defaultShortcutPath();
  const originalShortcut = manageShortcut ? existingState?.shortcut ?? await readShortcut(shortcutPath) : undefined;
  const launcher = path.join(paths.bin, "zdp-launcher.exe");
  if (manageShortcut && await exists(launcher)) await writeLauncherShortcut(shortcutPath, launcher, root, path.join(zcodeRoot, "ZCode.exe"));
  const wire = await getCurrentFuseWire(path.join(zcodeRoot, "ZCode.exe"));
  const now = new Date().toISOString();
  const state: InstallState = installStateSchema.parse({
    schemaVersion: 1,
    zdpRoot: root,
    zcodeRoot,
    zcodeVersion: vendorPackage.version,
    vendorAsarSha256: vendorHash,
    installedAt: existingState?.installedAt ?? now,
    ...(existingState ? {repairedAt: now} : {}),
    loaderVersion: options.loaderVersion ?? HOST_VERSION,
    ...(originalShortcut ? {shortcut: originalShortcut} : {}),
    fuses: fuseReport(wire as unknown as Record<number, FuseState>),
  });
  await writeJsonAtomic(paths.installState, state);
  await pruneBackups(paths.backups, 3);
  return doctor(zcodeRoot, root);
}

export async function uninstall(zcodeRoot = DEFAULT_ZCODE_ROOT, purgeData = false, options: {skipProcessCheck?: boolean; manageShortcut?: boolean; stateRoot?: string} = {}): Promise<void> {
  const root = options.stateRoot ?? resolveZdpRoot();
  const paths = getPaths(root);
  if (!options.skipProcessCheck) assertZCodeClosed();
  const resources = path.join(zcodeRoot, "resources");
  const appDir = path.join(resources, "app");
  const appAsar = path.join(resources, "app.asar");
  const originalAsar = path.join(resources, "zcode.original.asar");
  if (await exists(appDir)) {
    if (!await isManagedLoader(appDir)) throw new Error(`Refusing to remove unmanaged directory: ${appDir}`);
    await rm(appDir, {recursive: true, force: true});
  }
  if (!await exists(appAsar) && await exists(originalAsar)) await rename(originalAsar, appAsar);
  else if (await exists(appAsar) && await exists(originalAsar)) {
    const previousPackage = readPackage(originalAsar);
    await backupVendor(originalAsar, previousPackage.version, paths.backups);
    await rm(originalAsar, {force: true});
  }
  const state = await readInstallState(paths.installState);
  if ((options.manageShortcut ?? true) && state?.shortcut) await restoreShortcut(state.shortcut);
  await rm(paths.installState, {force: true});
  await rm(paths.bootState, {force: true});
  if (purgeData) await rm(paths.data, {recursive: true, force: true});
}

export async function launch(zcodeRoot = DEFAULT_ZCODE_ROOT, safe = false): Promise<void> {
  if (!isZCodeRunning()) await installOrRepair(zcodeRoot);
  const child = spawn(path.join(zcodeRoot, "ZCode.exe"), [], {
    cwd: zcodeRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: {...process.env, ZDP_ROOT: resolveZdpRoot(), ...(safe ? {ZDP_SAFE_MODE: "1"} : {})},
  });
  child.unref();
}

export function assertZCodeClosed(): void {
  if (isZCodeRunning()) throw new Error("ZCode is running. Close it before install, repair, or uninstall.");
}

export function isZCodeRunning(): boolean {
  if (process.platform !== "win32") return false;
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq ZCode.exe", "/NH", "/FO", "CSV"], {encoding: "utf8", windowsHide: true});
  return /"ZCode\.exe"/i.test(result.stdout ?? "");
}

export async function readInstallState(filePath = getPaths(resolveZdpRoot()).installState): Promise<InstallState | undefined> {
  try { return installStateSchema.parse(JSON.parse(await readFile(filePath, "utf8"))); }
  catch { return undefined; }
}

async function writeLoader(resources: string, root: string, zcodeRoot: string, pkg: VendorPackage): Promise<void> {
  const destination = path.join(resources, "app");
  if (await exists(destination) && !await isManagedLoader(destination)) throw new Error(`Refusing to replace unmanaged Electron app directory: ${destination}`);
  const temporary = path.join(resources, `.zdp-app-${process.pid}-${Date.now()}`);
  await rm(temporary, {recursive: true, force: true});
  await mkdir(temporary, {recursive: true});
  const loaderPackage = {
    name: pkg.name ?? "@zcode/desktop",
    productName: pkg.productName ?? "ZCode",
    version: pkg.version,
    private: true,
    type: "module",
    main: "index.mjs",
    zdpLoader: true,
  };
  const vendorMain = pkg.main ?? "out/main/index.js";
  const logPath = path.join(getPaths(root).logs, "loader.jsonl");
  const loader = `// ZCode Desktop Extensions managed loader\nimport {app} from "electron";\nimport {appendFile, mkdir} from "node:fs/promises";\nimport path from "node:path";\nimport {pathToFileURL} from "node:url";\nconst root=${JSON.stringify(root)};\nconst zcodeRoot=${JSON.stringify(zcodeRoot)};\nconst vendorAsar=path.join(process.resourcesPath,"zcode.original.asar");\nprocess.env.ZDP_ROOT=root;\nprocess.env.ZDP_ZCODE_ROOT=zcodeRoot;\nprocess.env.ZDP_ZCODE_VERSION=${JSON.stringify(pkg.version)};\ntry { app.getAppPath=()=>vendorAsar; } catch {}\nif(process.env.ZDP_SAFE_MODE!=="1") {\n  try { await import(pathToFileURL(path.join(root,"runtime","bootstrap.mjs")).href); }\n  catch(error) { try { await mkdir(path.dirname(${JSON.stringify(logPath)}),{recursive:true}); await appendFile(${JSON.stringify(logPath)},JSON.stringify({timestamp:new Date().toISOString(),level:"error",message:"Host bootstrap failed",error:error?.stack??String(error)})+"\\n"); } catch {} }\n}\nawait import(pathToFileURL(path.join(vendorAsar,${JSON.stringify(vendorMain)})).href);\n`;
  await writeFile(path.join(temporary, "package.json"), `${JSON.stringify(loaderPackage, null, 2)}\n`, "utf8");
  await writeFile(path.join(temporary, "index.mjs"), loader, "utf8");
  if (await exists(destination)) await rm(destination, {recursive: true, force: true});
  await rename(temporary, destination);
}

function readPackage(asarPath: string): VendorPackage {
  const pkg = JSON.parse(extractFile(asarPath, "package.json").toString("utf8")) as VendorPackage;
  if (!pkg.version) throw new Error("Vendor package.json has no version");
  return pkg;
}

async function backupVendor(source: string, version: string, backupRoot: string): Promise<string> {
  const hash = await sha256(source);
  const directory = path.join(backupRoot, `${version}-${hash.slice(0, 12)}`);
  const target = path.join(directory, "app.asar");
  await mkdir(directory, {recursive: true});
  if (!await exists(target)) await copyFile(source, target);
  await writeJsonAtomic(path.join(directory, "metadata.json"), {version, sha256: hash, backedUpAt: new Date().toISOString()});
  return target;
}

async function pruneBackups(backupRoot: string, keep: number): Promise<void> {
  const entries = await readdir(backupRoot, {withFileTypes: true}).catch(() => []);
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
    path: path.join(backupRoot, entry.name),
    modified: (await stat(path.join(backupRoot, entry.name))).mtimeMs,
  })));
  directories.sort((left, right) => right.modified - left.modified);
  for (const old of directories.slice(keep)) await rm(old.path, {recursive: true, force: true});
}

async function isManagedLoader(directory: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {zdpLoader?: boolean};
    return pkg.zdpLoader === true;
  } catch { return false; }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true).catch(() => false);
}

function fuseReport(wire: Record<number, FuseState>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index !== "number") continue;
    result[name] = FuseState[wire[index]] ?? String(wire[index]);
  }
  return result;
}

function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }

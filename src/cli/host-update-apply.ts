import {copyFile, mkdir, readFile, rm, stat} from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
import {writeJsonAtomic} from "../shared/atomic.ts";
import {getPaths} from "../shared/constants.ts";
import {hostUpdateTransactionSchema, releaseManifestSchema, safeManagedPath, verifyManagedFiles, type ReleaseManifest} from "../host/host-updater.ts";
import {installOrRepair, isZCodeRunning} from "./installer.ts";

type ApplyDependencies = {
  processAlive?: (pid: number) => boolean;
  zcodeRunning?: () => boolean;
  repair?: typeof installOrRepair;
  launch?: (executable: string) => void;
};

export async function applyHostUpdate(parentPid: number, root: string, dependencies: ApplyDependencies = {}): Promise<void> {
  const processAlive = dependencies.processAlive ?? isProcessAlive;
  const zcodeRunning = dependencies.zcodeRunning ?? isZCodeRunning;
  const repair = dependencies.repair ?? installOrRepair;
  const paths = getPaths(root);
  const transaction = hostUpdateTransactionSchema.parse(JSON.parse(await readFile(paths.hostUpdateState, "utf8")));
  if (transaction.phase !== "ready") throw new Error(`Host update is not ready: ${transaction.phase}`);
  assertChild(paths.hostUpdateStaging, transaction.stagingRoot);
  await writeJsonAtomic(paths.hostUpdateState, {...transaction, phase: "applying"});
  let incoming: ReleaseManifest | undefined;
  let current: ReleaseManifest | undefined;
  let backup: string | undefined;
  try {
    while (processAlive(parentPid)) await delay(500);
    const deadline = Date.now() + 60_000;
    while (zcodeRunning() && Date.now() < deadline) await delay(500);
    if (zcodeRunning()) throw new Error("ZCode did not close in time for the host update");
    incoming = releaseManifestSchema.parse(JSON.parse(await readFile(path.join(transaction.stagingRoot, "release-manifest.json"), "utf8")));
    current = releaseManifestSchema.parse(JSON.parse(await readFile(paths.releaseManifest, "utf8")));
    await verifyManagedFiles(transaction.stagingRoot, incoming);
    backup = path.join(paths.hostUpdateStaging, "backup", current.version);
    await rm(backup, {recursive: true, force: true});
    await mkdir(backup, {recursive: true});
    await backupManaged(root, backup, current);
    await copyFileRetry(paths.releaseManifest, path.join(backup, "release-manifest.json"));
    await installManaged(root, transaction.stagingRoot, current, incoming);
    await copyFileRetry(path.join(transaction.stagingRoot, "release-manifest.json"), paths.releaseManifest);
    await verifyManagedFiles(root, incoming);
    await writeJsonAtomic(paths.runtimeCurrent, {version: incoming.version, previousVersion: current.version});
    await repair(transaction.zcodeRoot, {skipProcessCheck: true, stateRoot: root, loaderVersion: incoming.version});
    await rm(paths.hostUpdateState, {force: true});
    await pruneTransaction(paths.hostUpdateStaging, transaction.stagingRoot, backup);
  } catch (error) {
    if (backup && current && incoming) {
      await restoreManaged(root, backup, current, incoming).catch(() => undefined);
      await copyFileRetry(path.join(backup, "release-manifest.json"), paths.releaseManifest).catch(() => undefined);
    }
    await writeJsonAtomic(paths.hostUpdateState, {...transaction, phase: "failed", error: errorText(error)}).catch(() => undefined);
    await repair(transaction.zcodeRoot, {skipProcessCheck: true, stateRoot: root}).catch(() => undefined);
  }
  if (dependencies.launch) dependencies.launch(path.join(transaction.zcodeRoot, "ZCode.exe"));
  else spawn(path.join(transaction.zcodeRoot, "ZCode.exe"), [], {detached: true, stdio: "ignore", windowsHide: true}).unref();
}

async function backupManaged(root: string, backup: string, manifest: ReleaseManifest): Promise<void> {
  for (const file of manifest.files) {
    const relative = safeManagedPath(file.path);
    const source = path.join(root, ...relative.split("/"));
    if (!await exists(source)) continue;
    const destination = path.join(backup, ...relative.split("/"));
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFileRetry(source, destination);
  }
}

async function installManaged(root: string, staging: string, current: ReleaseManifest, incoming: ReleaseManifest): Promise<void> {
  const incomingPaths = new Set(incoming.files.map((file) => safeManagedPath(file.path).toLowerCase()));
  for (const file of current.files) {
    const relative = safeManagedPath(file.path);
    if (!incomingPaths.has(relative.toLowerCase())) await rm(path.join(root, ...relative.split("/")), {force: true});
  }
  for (const file of incoming.files) {
    const relative = safeManagedPath(file.path);
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFileRetry(path.join(staging, ...relative.split("/")), destination);
  }
}

async function restoreManaged(root: string, backup: string, current: ReleaseManifest, incoming: ReleaseManifest): Promise<void> {
  const currentPaths = new Set(current.files.map((file) => safeManagedPath(file.path).toLowerCase()));
  for (const file of incoming.files) {
    const relative = safeManagedPath(file.path);
    if (!currentPaths.has(relative.toLowerCase())) await rm(path.join(root, ...relative.split("/")), {force: true});
  }
  for (const file of current.files) {
    const relative = safeManagedPath(file.path);
    const source = path.join(backup, ...relative.split("/"));
    if (!await exists(source)) continue;
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFileRetry(source, destination);
  }
}

async function copyFileRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await copyFile(source, destination); return; }
    catch (error) { lastError = error; await delay(250); }
  }
  throw lastError;
}

async function pruneTransaction(stagingRoot: string, payloadRoot: string, backup: string): Promise<void> {
  const transactionRoot = path.dirname(path.dirname(payloadRoot));
  if (path.relative(stagingRoot, transactionRoot).startsWith("..")) return;
  await rm(transactionRoot, {recursive: true, force: true});
  const backupParent = path.dirname(backup);
  const entries = await import("node:fs/promises").then(({readdir}) => readdir(backupParent, {withFileTypes: true})).catch(() => []);
  for (const entry of entries) if (entry.isDirectory() && entry.name !== path.basename(backup)) await rm(path.join(backupParent, entry.name), {recursive: true, force: true});
}

function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function exists(value: string): Promise<boolean> { return stat(value).then(() => true).catch(() => false); }
function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function assertChild(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Update payload is outside host staging: ${target}`);
}

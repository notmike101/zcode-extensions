import {createHash, randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import semver from "semver";
import {z} from "zod";
import {writeJsonAtomic} from "../shared/atomic.ts";
import {HOST_UPDATE_URL, HOST_VERSION, getPaths} from "../shared/constants.ts";
import type {JsonLogger} from "../shared/logger.ts";
import type {HostUpdateStatus} from "../shared/schemas.ts";
import {assertRemoteUrl, extractArchive, fetchRemote, readBoundedResponse} from "./extension-updater.ts";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MAX_FEED_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;

export const managedFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().nonnegative(),
}).strict();

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().refine((value) => Boolean(semver.valid(value))),
  files: z.array(managedFileSchema).max(10_000),
}).strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const hostReleaseSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().refine((value) => Boolean(semver.valid(value))),
  engines: z.object({zcode: z.string().min(1)}).strict(),
  archive: z.object({
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  }).strict(),
  releaseUrl: z.string().url(),
  publishedAt: z.string().datetime(),
}).strict();
export type HostRelease = z.infer<typeof hostReleaseSchema>;

export const hostUpdateTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(["ready", "applying", "failed"]),
  currentVersion: z.string(),
  targetVersion: z.string(),
  stagingRoot: z.string().min(1),
  zcodeRoot: z.string().min(1),
  releaseUrl: z.string().url(),
  error: z.string().optional(),
}).strict();
export type HostUpdateTransaction = z.infer<typeof hostUpdateTransactionSchema>;

export type HostUpdaterOptions = {
  root: string;
  zcodeRoot: string;
  zcodeVersion: string;
  logger: JsonLogger;
  onStateChanged: () => void;
  feedUrl?: string;
  allowHttpLocalhost?: boolean;
  launchHelper?: (executable: string, args: string[]) => void;
};

export class HostUpdater {
  readonly #options: HostUpdaterOptions;
  readonly #paths;
  #status: HostUpdateStatus = {state: "unknown", currentVersion: HOST_VERSION, installable: false};
  #release?: HostRelease;
  #checking = false;
  #timer?: NodeJS.Timeout;

  constructor(options: HostUpdaterOptions) {
    this.#options = options;
    this.#paths = getPaths(options.root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#paths.hostUpdateStaging, {recursive: true});
    await cleanupOldHelpers();
    const installable = await this.#installedManifest().then(() => true).catch(() => false);
    this.#status = {...this.#status, installable};
    await this.#recoverStatus();
  }

  status(): HostUpdateStatus { return {...this.#status}; }

  startAutomaticChecks(): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.#timer.unref?.();
  }

  dispose(): void { if (this.#timer) clearInterval(this.#timer); }

  async check(): Promise<void> {
    if (this.#checking || ["downloading", "ready", "applying"].includes(this.#status.state)) return;
    this.#checking = true;
    this.#set({state: "checking", error: undefined});
    try {
      const feedUrl = this.#options.feedUrl ?? process.env.ZDP_HOST_UPDATE_URL ?? HOST_UPDATE_URL;
      const response = await fetchRemote(feedUrl, {headers: {accept: "application/json"}}, this.#options.allowHttpLocalhost);
      if (!response.ok) throw new Error(`Host update feed returned HTTP ${response.status}`);
      const release = hostReleaseSchema.parse(JSON.parse((await readBoundedResponse(response, MAX_FEED_BYTES, "Host update feed is too large")).toString("utf8")));
      assertRemoteUrl(release.archive.url, this.#options.allowHttpLocalhost);
      assertRemoteUrl(release.releaseUrl, this.#options.allowHttpLocalhost);
      this.#release = release;
      const checkedAt = new Date().toISOString();
      if (semver.lte(release.version, HOST_VERSION)) this.#set({state: "up-to-date", latestVersion: release.version, releaseUrl: release.releaseUrl, checkedAt});
      else if (semver.valid(this.#options.zcodeVersion) && !semver.satisfies(this.#options.zcodeVersion, release.engines.zcode, {includePrerelease: true})) {
        this.#set({state: "incompatible", latestVersion: release.version, releaseUrl: release.releaseUrl, checkedAt, error: `Requires ZCode ${release.engines.zcode}`});
      } else this.#set({state: "available", latestVersion: release.version, releaseUrl: release.releaseUrl, checkedAt});
    } catch (error) {
      this.#set({state: "error", checkedAt: new Date().toISOString(), error: errorText(error)});
      await this.#options.logger.warn("Host update check failed", {error});
    } finally { this.#checking = false; }
  }

  async prepareAndRestart(parentPid: number): Promise<void> {
    if (!this.#release || this.#status.state !== "available") throw new Error("No compatible host update is available");
    if (!this.#status.installable) throw new Error("Self-update is available only for packaged installs; open the release page to update this development checkout");
    const release = this.#release;
    this.#set({state: "downloading"});
    const transactionRoot = path.join(this.#paths.hostUpdateStaging, randomUUID());
    const archive = path.join(transactionRoot, "update.zip");
    const extracted = path.join(transactionRoot, "extracted");
    try {
      await mkdir(extracted, {recursive: true});
      const response = await fetchRemote(release.archive.url, {headers: {accept: "application/zip"}}, this.#options.allowHttpLocalhost);
      if (!response.ok) throw new Error(`Host archive returned HTTP ${response.status}`);
      const bytes = await readBoundedResponse(response, release.archive.size, "Host update archive is too large");
      if (bytes.length !== release.archive.size) throw new Error(`Host archive size mismatch: expected ${release.archive.size}, received ${bytes.length}`);
      if (hash(bytes) !== release.archive.sha256.toLowerCase()) throw new Error("Host archive checksum mismatch");
      await writeFile(archive, bytes);
      await extractArchive(archive, extracted, {maxEntries: 10_000, maxExtractedBytes: 500 * 1024 * 1024, label: "Host update"});
      const stagingRoot = await locateReleaseRoot(extracted);
      const manifest = releaseManifestSchema.parse(JSON.parse(await readFile(path.join(stagingRoot, "release-manifest.json"), "utf8")));
      if (manifest.version !== release.version) throw new Error(`Host payload version ${manifest.version} does not match feed ${release.version}`);
      await verifyManagedFiles(stagingRoot, manifest);
      const transaction: HostUpdateTransaction = {
        schemaVersion: 1, phase: "ready", currentVersion: HOST_VERSION, targetVersion: release.version,
        stagingRoot, zcodeRoot: this.#options.zcodeRoot, releaseUrl: release.releaseUrl,
      };
      await writeJsonAtomic(this.#paths.hostUpdateState, transaction);
      const helper = path.join(tmpdir(), `zdp-update-${randomUUID()}.exe`);
      await copyFile(path.join(this.#paths.bin, "zdp.exe"), helper);
      const helperArgs = ["apply-update", "--parent", String(parentPid), "--root", this.#options.root, "--zcode", this.#options.zcodeRoot];
      if (this.#options.launchHelper) this.#options.launchHelper(helper, helperArgs);
      else {
        const child = spawn(helper, helperArgs, {detached: true, stdio: "ignore", windowsHide: true, env: {...process.env, ZDP_ROOT: this.#options.root}});
        child.unref();
      }
      this.#set({state: "applying"});
    } catch (error) {
      await rm(transactionRoot, {recursive: true, force: true}).catch(() => undefined);
      await rm(this.#paths.hostUpdateState, {force: true}).catch(() => undefined);
      this.#set({state: "error", error: errorText(error)});
      throw error;
    }
  }

  async #installedManifest(): Promise<ReleaseManifest> {
    const value = releaseManifestSchema.parse(JSON.parse(await readFile(this.#paths.releaseManifest, "utf8")));
    if (value.version !== HOST_VERSION) throw new Error("Installed release manifest does not match this host");
    return value;
  }

  async #recoverStatus(): Promise<void> {
    try {
      const transaction = hostUpdateTransactionSchema.parse(JSON.parse(await readFile(this.#paths.hostUpdateState, "utf8")));
      if (transaction.phase === "failed") this.#set({state: "error", latestVersion: transaction.targetVersion, releaseUrl: transaction.releaseUrl, error: transaction.error ?? "The previous host update was rolled back"});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") await this.#options.logger.warn("Ignored invalid host update state", {error}); }
  }

  #set(next: Partial<HostUpdateStatus>): void {
    this.#status = {...this.#status, ...next};
    this.#options.onStateChanged();
  }
}

export async function verifyManagedFiles(root: string, manifest: ReleaseManifest): Promise<void> {
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const relative = safeManagedPath(file.path);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate managed file: ${relative}`);
    seen.add(key);
    const target = path.join(root, ...relative.split("/"));
    const info = await stat(target);
    if (!info.isFile() || info.size !== file.size || await sha256(target) !== file.sha256.toLowerCase()) throw new Error(`Managed file verification failed: ${relative}`);
  }
}

export function safeManagedPath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error(`Unsafe managed path: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe managed path: ${value}`);
  if (parts[0]?.toLowerCase() === "data" || parts[0]?.toLowerCase() === ".git") throw new Error(`Managed path may not enter preserved storage: ${value}`);
  return value;
}

async function locateReleaseRoot(extracted: string): Promise<string> {
  if (await exists(path.join(extracted, "release-manifest.json"))) return extracted;
  const entries = await readdir(extracted, {withFileTypes: true});
  if (entries.length !== 1 || !entries[0]?.isDirectory()) throw new Error("Host archive must contain exactly one root folder");
  const root = path.join(extracted, entries[0].name);
  if (!await exists(path.join(root, "release-manifest.json"))) throw new Error("Host archive has no release-manifest.json");
  return root;
}

async function sha256(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}
function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function exists(value: string): Promise<boolean> { return stat(value).then(() => true).catch(() => false); }
async function cleanupOldHelpers(): Promise<void> {
  const entries = await readdir(tmpdir(), {withFileTypes: true}).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile() && /^zdp-update-[0-9a-f-]+\.exe$/i.test(entry.name))
    .map((entry) => rm(path.join(tmpdir(), entry.name), {force: true}).catch(() => undefined)));
}
function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }

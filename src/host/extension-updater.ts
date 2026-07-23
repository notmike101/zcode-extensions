import {createHash, randomUUID} from "node:crypto";
import {createWriteStream} from "node:fs";
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {pipeline} from "node:stream/promises";
import semver from "semver";
import * as yauzl from "yauzl";
import {z} from "zod";
import type {JsonLogger} from "../shared/logger.ts";
import {writeJsonAtomic} from "../shared/atomic.ts";
import {HOST_VERSION, PLUGIN_ID_PATTERN, getPaths} from "../shared/constants.ts";
import {
  extensionReleaseManifestSchema,
  extensionUpdateSourceSchema,
  type CatalogExtensionStatus,
  type ExtensionReleaseManifest,
  type ExtensionUpdateStatus,
  type PluginManifest,
} from "../shared/schemas.ts";
import {readExtensionManifest, rejectExtensionLinks} from "./extension-bundle.ts";
import {OFFICIAL_EXTENSIONS, type OfficialExtension} from "./extension-catalog.ts";

const MAX_FEED_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MAX_REDIRECTS = 5;

type InstalledExtension = {root: string; manifest: PluginManifest};

const pendingUpdateSchema = z.object({
  pluginId: z.string().regex(PLUGIN_ID_PATTERN),
  version: z.string().refine((value) => Boolean(semver.valid(value)), "Version must be semantic"),
  stagingRoot: z.string().min(1),
  stagingContainer: z.string().min(1),
  queuedAt: z.string().datetime(),
  phase: z.enum(["queued", "applying", "installed"]),
  rollbackPath: z.string().min(1).optional(),
}).strict();

const updateStateSchema = z.object({
  schemaVersion: z.literal(1),
  pending: z.record(z.string(), pendingUpdateSchema),
}).strict();

type PendingUpdate = z.infer<typeof pendingUpdateSchema>;
type UpdateState = z.infer<typeof updateStateSchema>;

export type AppliedUpdate = {
  pluginId: string;
  version: string;
  destination: string;
  rollbackPath?: string;
};

export type PreparedExtension = {
  root: string;
  container: string;
  manifest: PluginManifest;
  release: ExtensionReleaseManifest;
};

type ExtensionUpdaterOptions = {
  root: string;
  zcodeVersion: string;
  logger: JsonLogger;
  getInstalled: () => InstalledExtension[];
  onStateChanged: () => void;
  catalog?: readonly OfficialExtension[];
  allowHttpLocalhost?: boolean;
};

export class ExtensionUpdater {
  readonly #options: ExtensionUpdaterOptions;
  readonly #paths;
  readonly #stateFile: string;
  readonly #catalog: readonly OfficialExtension[];
  readonly #releases = new Map<string, ExtensionReleaseManifest>();
  readonly #errors = new Map<string, string>();
  #state: UpdateState = {schemaVersion: 1, pending: {}};
  #checkedAt?: string;
  #checking = false;
  #checkTimer?: NodeJS.Timeout;

  constructor(options: ExtensionUpdaterOptions) {
    this.#options = options;
    this.#paths = getPaths(options.root);
    this.#stateFile = path.join(this.#paths.data, "extension-updates.json");
    this.#catalog = options.catalog ?? OFFICIAL_EXTENSIONS;
  }

  async initialize(): Promise<Map<string, AppliedUpdate>> {
    await Promise.all([
      mkdir(this.#paths.staging, {recursive: true}),
      mkdir(this.#paths.trash, {recursive: true}),
      mkdir(this.#paths.plugins, {recursive: true}),
    ]);
    await this.#loadState();
    return this.#applyPending();
  }

  startAutomaticChecks(): void {
    void this.checkForUpdates();
    this.#checkTimer = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
    this.#checkTimer.unref?.();
  }

  dispose(): void {
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = undefined;
  }

  async checkForUpdates(): Promise<void> {
    if (this.#checking) return;
    this.#checking = true;
    this.#options.onStateChanged();
    try {
      const sources = new Map(this.#catalog.map((entry) => [entry.id, entry.manifestUrl]));
      for (const installed of this.#options.getInstalled()) {
        if (sources.has(installed.manifest.id)) continue;
        const source = await readUpdateSource(installed.root).catch((error) => {
          this.#errors.set(installed.manifest.id, errorText(error));
          return undefined;
        });
        if (source) sources.set(installed.manifest.id, source.manifestUrl);
      }
      await Promise.all([...sources].map(async ([pluginId, manifestUrl]) => {
        try {
          const release = await this.#fetchRelease(manifestUrl);
          if (release.id !== pluginId) throw new Error(`Update feed identifies ${release.id} instead of ${pluginId}`);
          this.#releases.set(pluginId, release);
          this.#errors.delete(pluginId);
        } catch (error) {
          this.#releases.delete(pluginId);
          this.#errors.set(pluginId, errorText(error));
          await this.#options.logger.warn("Extension update check failed", {pluginId, manifestUrl, error});
        }
      }));
      this.#checkedAt = new Date().toISOString();
    } finally {
      this.#checking = false;
      this.#options.onStateChanged();
    }
  }

  status(manifest: PluginManifest): ExtensionUpdateStatus {
    const pending = this.#state.pending[manifest.id];
    if (pending) {
      return {
        state: "queued",
        currentVersion: manifest.version,
        queuedVersion: pending.version,
        latestVersion: pending.version,
        checkedAt: this.#checkedAt,
      };
    }
    if (this.#checking) return {state: "checking", currentVersion: manifest.version, checkedAt: this.#checkedAt};
    const error = this.#errors.get(manifest.id);
    if (error) return {state: "error", currentVersion: manifest.version, error, checkedAt: this.#checkedAt};
    const release = this.#releases.get(manifest.id);
    if (!release) return {state: "unknown", currentVersion: manifest.version, checkedAt: this.#checkedAt};
    if (!semver.valid(manifest.version)) {
      return {
        state: "error",
        currentVersion: manifest.version,
        latestVersion: release.version,
        releaseUrl: release.releaseUrl,
        checkedAt: this.#checkedAt,
        error: `Installed extension version is not semantic: ${manifest.version}`,
      };
    }
    if (!this.#compatible(release)) {
      return {
        state: "incompatible",
        currentVersion: manifest.version,
        latestVersion: release.version,
        releaseUrl: release.releaseUrl,
        checkedAt: this.#checkedAt,
      };
    }
    return {
      state: semver.gt(release.version, manifest.version) ? "available" : "up-to-date",
      currentVersion: manifest.version,
      latestVersion: release.version,
      releaseUrl: release.releaseUrl,
      checkedAt: this.#checkedAt,
    };
  }

  catalog(): CatalogExtensionStatus[] {
    const installed = new Map(this.#options.getInstalled().map((entry) => [entry.manifest.id, entry.manifest]));
    return this.#catalog.map((entry) => {
      const current = installed.get(entry.id);
      const release = this.#releases.get(entry.id);
      const error = this.#errors.get(entry.id);
      const base = {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        repositoryUrl: entry.repositoryUrl,
        installed: Boolean(current),
        ...(current ? {currentVersion: current.version} : {}),
        ...(release ? {latestVersion: release.version, releaseUrl: release.releaseUrl} : {}),
      };
      if (this.#checking) return {...base, state: "checking" as const};
      if (error) return {...base, state: "error" as const, error};
      if (!release) return {...base, state: current ? "installed" as const : "unknown" as const};
      if (!this.#compatible(release)) return {...base, state: "incompatible" as const};
      return {...base, state: current ? "installed" as const : "available" as const};
    });
  }

  async prepareCatalogInstall(pluginId: string): Promise<PreparedExtension> {
    if (this.#options.getInstalled().some((entry) => entry.manifest.id === pluginId)) {
      throw new Error(`Extension is already installed: ${pluginId}`);
    }
    const entry = this.#catalog.find((item) => item.id === pluginId);
    if (!entry) throw new Error(`Unknown catalog extension: ${pluginId}`);
    const release = this.#releases.get(pluginId) ?? await this.#fetchRelease(entry.manifestUrl);
    return this.#prepare(release);
  }

  async queueUpdate(pluginId: string): Promise<void> {
    if (this.#state.pending[pluginId]) throw new Error(`An update is already queued for ${pluginId}`);
    const installed = this.#options.getInstalled().find((entry) => entry.manifest.id === pluginId);
    if (!installed) throw new Error(`Extension is not installed: ${pluginId}`);
    const release = this.#releases.get(pluginId) ?? await this.#releaseForInstalled(installed);
    if (!semver.valid(installed.manifest.version)) throw new Error(`Installed extension version is not semantic: ${installed.manifest.version}`);
    if (!semver.gt(release.version, installed.manifest.version)) throw new Error(`${pluginId} is already up to date`);
    if (!this.#compatible(release)) throw new Error(`${pluginId} ${release.version} is not compatible with this host`);
    const prepared = await this.#prepare(release);
    this.#state.pending[pluginId] = {
      pluginId,
      version: release.version,
      stagingRoot: prepared.root,
      stagingContainer: prepared.container,
      queuedAt: new Date().toISOString(),
      phase: "queued",
    };
    await this.#persistState();
    this.#options.onStateChanged();
  }

  async cancelPending(pluginId: string): Promise<void> {
    const pending = this.#state.pending[pluginId];
    if (!pending || pending.phase !== "queued") return;
    assertChild(this.#paths.staging, pending.stagingContainer);
    delete this.#state.pending[pluginId];
    await this.#persistState();
    await rm(pending.stagingContainer, {recursive: true, force: true});
    this.#options.onStateChanged();
  }

  async commitApplied(pluginId: string): Promise<void> {
    const pending = this.#state.pending[pluginId];
    if (!pending) return;
    assertChild(this.#paths.staging, pending.stagingContainer);
    delete this.#state.pending[pluginId];
    await this.#persistState();
    await rm(pending.stagingContainer, {recursive: true, force: true}).catch(() => undefined);
  }

  async rollbackApplied(pluginId: string): Promise<void> {
    const pending = this.#state.pending[pluginId];
    if (!pending?.rollbackPath) return;
    assertChild(this.#paths.staging, pending.stagingContainer);
    assertChild(this.#paths.trash, pending.rollbackPath);
    const destination = path.join(this.#paths.plugins, pluginId);
    const failed = path.join(this.#paths.trash, `${pluginId}-${pending.version}-failed-${timestamp()}`);
    if (await exists(destination)) await rename(destination, failed);
    if (await exists(pending.rollbackPath)) await rename(pending.rollbackPath, destination);
    delete this.#state.pending[pluginId];
    await this.#persistState();
    await rm(pending.stagingContainer, {recursive: true, force: true}).catch(() => undefined);
  }

  async cleanupPrepared(prepared: PreparedExtension): Promise<void> {
    assertChild(this.#paths.staging, prepared.container);
    await rm(prepared.container, {recursive: true, force: true});
  }

  async #applyPending(): Promise<Map<string, AppliedUpdate>> {
    const applied = new Map<string, AppliedUpdate>();
    for (const pending of Object.values(this.#state.pending)) {
      try {
        assertChild(this.#paths.staging, pending.stagingContainer);
        assertChild(pending.stagingContainer, pending.stagingRoot);
        if (pending.rollbackPath) assertChild(this.#paths.trash, pending.rollbackPath);
        const destination = path.join(this.#paths.plugins, pending.pluginId);
        if (pending.phase === "queued") {
          const manifest = await readExtensionManifest(pending.stagingRoot);
          if (manifest.id !== pending.pluginId || manifest.version !== pending.version) {
            throw new Error(`Queued bundle identity mismatch for ${pending.pluginId}`);
          }
          this.#checkCompatibility(manifest.engines);
          pending.rollbackPath = path.join(this.#paths.trash, `${pending.pluginId}-${timestamp()}`);
          pending.phase = "applying";
          await this.#persistState();
        }
        if (pending.phase === "applying") {
          if (await exists(destination)) {
            if (!pending.rollbackPath) throw new Error(`Missing rollback path for ${pending.pluginId}`);
            await rename(destination, pending.rollbackPath);
          }
          if (await exists(pending.stagingRoot)) await rename(pending.stagingRoot, destination);
          const installed = await readExtensionManifest(destination);
          if (installed.id !== pending.pluginId || installed.version !== pending.version) {
            throw new Error(`Applied bundle identity mismatch for ${pending.pluginId}`);
          }
          pending.phase = "installed";
          await this.#persistState();
        }
        applied.set(pending.pluginId, {
          pluginId: pending.pluginId,
          version: pending.version,
          destination,
          rollbackPath: pending.rollbackPath,
        });
      } catch (error) {
        await this.#options.logger.error("Could not apply queued extension update", {pluginId: pending.pluginId, error});
        this.#errors.set(pending.pluginId, errorText(error));
        if (pending.rollbackPath && await exists(pending.rollbackPath)) {
          const destination = path.join(this.#paths.plugins, pending.pluginId);
          if (await exists(destination)) await rm(destination, {recursive: true, force: true});
          await rename(pending.rollbackPath, destination);
        }
        delete this.#state.pending[pending.pluginId];
        await this.#persistState();
      }
    }
    return applied;
  }

  async #releaseForInstalled(installed: InstalledExtension): Promise<ExtensionReleaseManifest> {
    const official = this.#catalog.find((entry) => entry.id === installed.manifest.id);
    const source = official ? {manifestUrl: official.manifestUrl} : await readUpdateSource(installed.root);
    if (!source) throw new Error(`${installed.manifest.id} does not declare an update feed`);
    const release = await this.#fetchRelease(source.manifestUrl);
    if (release.id !== installed.manifest.id) throw new Error(`Update feed identifies ${release.id} instead of ${installed.manifest.id}`);
    this.#releases.set(installed.manifest.id, release);
    return release;
  }

  async #fetchRelease(manifestUrl: string): Promise<ExtensionReleaseManifest> {
    const response = await fetchRemote(manifestUrl, {
      headers: {Accept: "application/json"},
      signal: AbortSignal.timeout(10_000),
    }, this.#options.allowHttpLocalhost);
    if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}`);
    const text = (await readBoundedResponse(response, MAX_FEED_BYTES, "Update feed is too large")).toString("utf8");
    const release = extensionReleaseManifestSchema.parse(JSON.parse(text));
    if (!semver.valid(release.version)) throw new Error(`Update feed version is not semantic: ${release.version}`);
    assertRemoteUrl(release.archive.url, this.#options.allowHttpLocalhost);
    assertRemoteUrl(release.releaseUrl, this.#options.allowHttpLocalhost);
    return release;
  }

  async #prepare(release: ExtensionReleaseManifest): Promise<PreparedExtension> {
    if (!this.#compatible(release)) throw new Error(`${release.id} ${release.version} is not compatible with this host`);
    const container = path.join(this.#paths.staging, `download-${release.id}-${randomUUID()}`);
    const archive = path.join(container, "extension.zip");
    const extracted = path.join(container, "extracted");
    await mkdir(extracted, {recursive: true});
    try {
      const response = await fetchRemote(
        release.archive.url,
        {signal: AbortSignal.timeout(60_000)},
        this.#options.allowHttpLocalhost,
      );
      if (!response.ok) throw new Error(`Extension archive returned HTTP ${response.status}`);
      const bytes = await readBoundedResponse(
        response,
        Math.min(MAX_ARCHIVE_BYTES, release.archive.size),
        "Extension archive is too large",
      );
      if (bytes.byteLength !== release.archive.size) throw new Error("Extension archive size does not match its release manifest");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest.toLowerCase() !== release.archive.sha256.toLowerCase()) throw new Error("Extension archive checksum mismatch");
      await writeFile(archive, bytes, {flag: "wx"});
      await extractArchive(archive, extracted);
      const root = await locateBundleRoot(extracted);
      await rejectExtensionLinks(root);
      const manifest = await readExtensionManifest(root);
      if (manifest.id !== release.id || manifest.version !== release.version) {
        throw new Error(`Downloaded bundle is ${manifest.id} ${manifest.version}, expected ${release.id} ${release.version}`);
      }
      this.#checkCompatibility(manifest.engines);
      return {root, container, manifest, release};
    } catch (error) {
      await rm(container, {recursive: true, force: true});
      throw error;
    }
  }

  #compatible(release: ExtensionReleaseManifest): boolean {
    try {
      this.#checkCompatibility(release.engines);
      return true;
    } catch {
      return false;
    }
  }

  #checkCompatibility(engines: {host: string; zcode: string}): void {
    if (!semver.satisfies(HOST_VERSION, engines.host, {includePrerelease: true})) {
      throw new Error(`Extension requires host ${engines.host}; installed ${HOST_VERSION}`);
    }
    if (semver.valid(this.#options.zcodeVersion) && !semver.satisfies(this.#options.zcodeVersion, engines.zcode, {includePrerelease: true})) {
      throw new Error(`Extension requires ZCode ${engines.zcode}; installed ${this.#options.zcodeVersion}`);
    }
  }

  async #loadState(): Promise<void> {
    try {
      const value = updateStateSchema.parse(JSON.parse(await readFile(this.#stateFile, "utf8")));
      for (const [pluginId, pending] of Object.entries(value.pending)) {
        if (pluginId !== pending.pluginId) throw new Error(`Update state key mismatch for ${pluginId}`);
        assertChild(this.#paths.staging, pending.stagingContainer);
        assertChild(pending.stagingContainer, pending.stagingRoot);
        if (pending.rollbackPath) assertChild(this.#paths.trash, pending.rollbackPath);
      }
      this.#state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await this.#options.logger.warn("Reset invalid extension update state", {error});
      this.#state = {schemaVersion: 1, pending: {}};
    }
  }

  async #persistState(): Promise<void> {
    await writeJsonAtomic(this.#stateFile, this.#state);
  }
}

export async function readUpdateSource(root: string) {
  try {
    return extensionUpdateSourceSchema.parse(JSON.parse(await readFile(path.join(root, ".zdp", "update.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function extractArchive(archive: string, destination: string, limits: {maxEntries?: number; maxExtractedBytes?: number; label?: string} = {}): Promise<void> {
  const maxEntries = limits.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const maxExtractedBytes = limits.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
  const label = limits.label ?? "Extension";
  const zip = await openZip(archive);
  const names = new Set<string>();
  let entries = 0;
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      void (async () => {
        entries += 1;
        if (entries > maxEntries) throw new Error(`${label} archive contains too many entries`);
        const relative = validateArchiveEntryPath(entry.fileName);
        const key = process.platform === "win32" ? relative.toLowerCase() : relative;
        if (names.has(key)) throw new Error(`Extension archive contains a duplicate path: ${relative}`);
        names.add(key);
        if (isArchiveLink(entry)) throw new Error(`Extension archive contains a link: ${relative}`);
        totalBytes += entry.uncompressedSize;
        if (totalBytes > maxExtractedBytes) throw new Error(`${label} archive expands beyond the allowed size`);
        const target = path.resolve(destination, ...relative.split("/"));
        assertContained(destination, target);
        if (entry.fileName.endsWith("/")) {
          await mkdir(target, {recursive: true});
        } else {
          await mkdir(path.dirname(target), {recursive: true});
          const stream = await openEntry(zip, entry);
          await pipeline(stream, createWriteStream(target, {flags: "wx"}));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

async function locateBundleRoot(extracted: string): Promise<string> {
  if (await exists(path.join(extracted, ".zdp", "plugin.json"))) return extracted;
  const entries = await readdir(extracted, {withFileTypes: true});
  if (entries.length !== 1 || !entries[0]?.isDirectory()) throw new Error("Extension archive must contain exactly one root folder");
  const root = path.join(extracted, entries[0].name);
  if (!await exists(path.join(root, ".zdp", "plugin.json"))) throw new Error("Extension archive root has no .zdp/plugin.json");
  return root;
}

function openZip(archive: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, {lazyEntries: true, validateEntrySizes: true}, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open extension archive"));
      else resolve(zip);
    });
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Could not read archive entry: ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

export function validateArchiveEntryPath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Unsafe extension archive path: ${value}`);
  }
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => (
    !part
    || part === "."
    || part === ".."
    || /[<>:"|?*\u0000-\u001f]/.test(part)
    || /[ .]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  ))) throw new Error(`Unsafe extension archive path: ${value}`);
  return normalized;
}

function isArchiveLink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

export function assertRemoteUrl(value: string, allowHttpLocalhost = false): void {
  const url = new URL(value);
  if (url.protocol === "https:") return;
  if (allowHttpLocalhost && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return;
  throw new Error(`Extension updates require HTTPS: ${value}`);
}

export async function fetchRemote(
  initialUrl: string,
  init: RequestInit,
  allowHttpLocalhost = false,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertRemoteUrl(currentUrl, allowHttpLocalhost);
    const response = await fetch(currentUrl, {...init, redirect: "manual"});
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === MAX_REDIRECTS) throw new Error("Extension update redirected too many times");
    const location = response.headers.get("location");
    if (!location) throw new Error(`Extension update redirect ${response.status} has no location`);
    const nextUrl = new URL(location, currentUrl).href;
    assertRemoteUrl(nextUrl, allowHttpLocalhost);
    await response.body?.cancel().catch(() => undefined);
    currentUrl = nextUrl;
  }
  throw new Error("Extension update redirected too many times");
}

export async function readBoundedResponse(response: Response, maximumBytes: number, message: string): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(message);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(message);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes update staging: ${target}`);
}

function assertChild(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is not a child of its update transaction root: ${target}`);
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

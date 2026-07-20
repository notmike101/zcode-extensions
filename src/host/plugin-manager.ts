import {createRequire} from "node:module";
import {cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import semver from "semver";
import type {ExtensionContext, ExtensionDisposable, ExtensionModule} from "../../sdk/index.ts";
import {HOST_VERSION, getPaths, PLUGIN_ID_PATTERN} from "../shared/constants.ts";
import {writeJsonAtomic} from "../shared/atomic.ts";
import {pluginManifestSchema, type PluginManifest, type PluginStatus} from "../shared/schemas.ts";
import type {JsonLogger} from "../shared/logger.ts";
import type {TaskService} from "../protocol/task-service.ts";

type PluginModule = ExtensionModule;
type Disposable = ExtensionDisposable;
export type PluginContext = ExtensionContext;

type PluginRecord = {
  root: string;
  manifest: PluginManifest;
  enabled: boolean;
  generation: number;
  module?: PluginModule;
  deactivate?: () => unknown | Promise<unknown>;
  disposables: Disposable[];
  error?: string;
};

type PluginManagerOptions = {
  root: string;
  runtimeVersionDir: string;
  zcodeVersion: string;
  logger: JsonLogger;
  taskService: TaskService;
  emit: (event: string, payload?: unknown) => void;
  onResume: (handler: () => void) => Disposable;
};

export class PluginManager {
  readonly #options: PluginManagerOptions;
  readonly #paths;
  readonly #records = new Map<string, PluginRecord>();
  readonly #ipcHandlers = new Map<string, (payload: unknown) => unknown | Promise<unknown>>();
  #enabledState: Record<string, boolean> = {};

  constructor(options: PluginManagerOptions) {
    this.#options = options;
    this.#paths = getPaths(options.root);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#paths.plugins, {recursive: true}),
      mkdir(this.#paths.staging, {recursive: true}),
      mkdir(this.#paths.trash, {recursive: true}),
      mkdir(path.join(this.#paths.data, "plugin-data"), {recursive: true}),
    ]);
    await this.#restoreBuiltins();
    await this.#loadEnabledState();
    await this.#scan();
    for (const record of this.#records.values()) {
      if (record.enabled) await this.#activate(record);
    }
  }

  list(): PluginStatus[] {
    return [...this.#records.values()].map((record) => ({
      manifest: record.manifest,
      enabled: record.enabled,
      loaded: Boolean(record.module || (!record.manifest.entrypoints.main && record.enabled)),
      ...(record.error ? {error: record.error} : {}),
      ...(record.enabled && record.manifest.entrypoints.renderer
        ? {rendererUrl: `zdp://plugin/${encodeURIComponent(record.manifest.id)}/renderer.js?generation=${record.generation}`}
        : {}),
      generation: record.generation,
    })).sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  }

  async install(sourceDirectory: string): Promise<PluginStatus> {
    const sourceRoot = await realpath(sourceDirectory);
    await rejectLinks(sourceRoot);
    const manifest = await readManifest(sourceRoot);
    this.#checkCompatibility(manifest);
    if (this.#records.has(manifest.id)) throw new Error(`Extension is already installed: ${manifest.id}`);
    const staging = path.join(this.#paths.staging, `${manifest.id}-${randomUUID()}`);
    const destination = path.join(this.#paths.plugins, manifest.id);
    await cp(sourceRoot, staging, {recursive: true, force: false, errorOnExist: true, dereference: false});
    await readManifest(staging);
    await rename(staging, destination).catch(async (error) => {
      await rm(staging, {recursive: true, force: true});
      throw error;
    });
    const record: PluginRecord = {root: destination, manifest, enabled: true, generation: 1, disposables: []};
    this.#records.set(manifest.id, record);
    this.#enabledState[manifest.id] = true;
    await this.#persistEnabledState();
    await this.#activate(record);
    this.#stateChanged();
    return this.list().find((item) => item.manifest.id === manifest.id)!;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const record = this.#require(pluginId);
    if (record.enabled === enabled) return;
    if (enabled) {
      record.enabled = true;
      await this.#activate(record);
    } else {
      await this.#deactivate(record);
      record.enabled = false;
    }
    record.generation += 1;
    this.#enabledState[pluginId] = enabled;
    await this.#persistEnabledState();
    this.#stateChanged();
  }

  async reload(pluginId: string): Promise<void> {
    const record = this.#require(pluginId);
    await this.#deactivate(record);
    record.generation += 1;
    record.error = undefined;
    if (record.enabled) await this.#activate(record);
    this.#stateChanged();
  }

  async uninstall(pluginId: string): Promise<void> {
    const record = this.#require(pluginId);
    await this.#deactivate(record);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(this.#paths.trash, `${pluginId}-${timestamp}`);
    await rename(record.root, destination);
    this.#records.delete(pluginId);
    delete this.#enabledState[pluginId];
    await this.#persistEnabledState();
    this.#stateChanged();
  }

  async invoke(pluginId: string, method: string, payload: unknown): Promise<unknown> {
    if (!PLUGIN_ID_PATTERN.test(pluginId) || !PLUGIN_ID_PATTERN.test(method)) throw new Error("Invalid extension IPC namespace");
    const record = this.#require(pluginId);
    if (!record.enabled) throw new Error(`Extension is disabled: ${pluginId}`);
    const handler = this.#ipcHandlers.get(`${pluginId}:${method}`);
    if (!handler) throw new Error(`Unknown extension method: ${pluginId}:${method}`);
    return handler(payload);
  }

  rendererPath(pluginId: string): string {
    const record = this.#require(pluginId);
    if (!record.enabled || !record.manifest.entrypoints.renderer) throw new Error("Renderer entrypoint is unavailable");
    return containedPath(record.root, record.manifest.entrypoints.renderer);
  }

  async deactivateAll(): Promise<void> {
    for (const record of [...this.#records.values()].reverse()) await this.#deactivate(record);
  }

  async #scan(): Promise<void> {
    const entries = await readdir(this.#paths.plugins, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(this.#paths.plugins, entry.name);
      try {
        const manifest = await readManifest(root);
        this.#checkCompatibility(manifest);
        this.#records.set(manifest.id, {
          root,
          manifest,
          enabled: this.#enabledState[manifest.id] ?? true,
          generation: 1,
          disposables: [],
        });
      } catch (error) {
        await this.#options.logger.error("Skipped invalid extension", {root, error});
      }
    }
  }

  async #activate(record: PluginRecord): Promise<void> {
    record.error = undefined;
    if (!record.manifest.entrypoints.main) return;
    const entrypoint = containedPath(record.root, record.manifest.entrypoints.main);
    try {
      clearRequireCache(record.root);
      const required = createRequire(import.meta.url)(entrypoint) as PluginModule | {default?: PluginModule};
      const module = ("default" in required && required.default ? required.default : required) as PluginModule;
      if (typeof module.activate !== "function") throw new Error("Main entrypoint must export activate(context)");
      record.module = module;
      const logger = this.#options.logger.child(`plugin:${record.manifest.id}`);
      const context: PluginContext = {
        manifest: record.manifest,
        dataDir: path.join(this.#paths.data, "plugin-data", record.manifest.id),
        logger,
        ipc: {
          handle: (method, handler) => {
            if (!PLUGIN_ID_PATTERN.test(method)) throw new Error(`Invalid extension IPC method: ${method}`);
            const key = `${record.manifest.id}:${method}`;
            if (this.#ipcHandlers.has(key)) throw new Error(`Duplicate extension IPC method: ${key}`);
            this.#ipcHandlers.set(key, handler);
            const disposable = {dispose: () => { this.#ipcHandlers.delete(key); }};
            record.disposables.push(disposable);
            return disposable;
          },
          emit: (event, payload) => this.#options.emit(`plugin:${record.manifest.id}:${event}`, payload),
        },
        lifecycle: {onResume: (handler) => this.#options.onResume(handler)},
        zcode: {
          readWorkspaceState: (workspacePath) => this.#options.taskService.readWorkspaceState(workspacePath),
          tasks: {run: (spec) => this.#options.taskService.run(spec)},
        },
      };
      await mkdir(context.dataDir, {recursive: true});
      const activated = await module.activate(context);
      if (typeof activated === "function") record.deactivate = activated as () => unknown;
      else if (activated && typeof activated === "object" && "dispose" in activated && typeof (activated as Disposable).dispose === "function") {
        record.deactivate = () => (activated as Disposable).dispose();
      } else if (module.deactivate) record.deactivate = () => module.deactivate?.();
      await logger.info("Extension activated", {version: record.manifest.version});
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      await this.#options.logger.error("Extension activation failed", {pluginId: record.manifest.id, error});
    }
  }

  async #deactivate(record: PluginRecord): Promise<void> {
    try { await record.deactivate?.(); } catch (error) {
      await this.#options.logger.warn("Extension deactivation failed", {pluginId: record.manifest.id, error});
    }
    for (const disposable of record.disposables.splice(0).reverse()) {
      try { await disposable.dispose(); } catch { /* isolated cleanup */ }
    }
    record.deactivate = undefined;
    record.module = undefined;
    clearRequireCache(record.root);
  }

  async #restoreBuiltins(): Promise<void> {
    const source = path.join(this.#options.runtimeVersionDir, "builtin-plugins");
    const entries = await readdir(source, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const destination = path.join(this.#paths.plugins, entry.name);
      const bundledRoot = path.join(source, entry.name);
      if (await stat(destination).then(() => true).catch(() => false)) {
        try {
          const bundled = await readManifest(bundledRoot);
          const installed = await readManifest(destination);
          if (!semver.gt(bundled.version, installed.version)) continue;
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          await rename(destination, path.join(this.#paths.trash, `${entry.name}-${installed.version}-${timestamp}`));
        } catch (error) {
          await this.#options.logger.warn("Could not update bundled extension", {pluginId: entry.name, error});
          continue;
        }
      }
      await cp(bundledRoot, destination, {recursive: true, force: false, errorOnExist: true});
    }
  }

  async #loadEnabledState(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#paths.pluginState, "utf8")) as {enabled?: Record<string, boolean>};
      this.#enabledState = value.enabled ?? {};
    } catch {
      this.#enabledState = {};
    }
  }

  #checkCompatibility(manifest: PluginManifest): void {
    if (!semver.satisfies(HOST_VERSION, manifest.engines.host, {includePrerelease: true})) {
      throw new Error(`Extension requires host ${manifest.engines.host}; installed ${HOST_VERSION}`);
    }
    if (semver.valid(this.#options.zcodeVersion) && !semver.satisfies(this.#options.zcodeVersion, manifest.engines.zcode, {includePrerelease: true})) {
      throw new Error(`Extension requires ZCode ${manifest.engines.zcode}; installed ${this.#options.zcodeVersion}`);
    }
  }

  #require(pluginId: string): PluginRecord {
    const record = this.#records.get(pluginId);
    if (!record) throw new Error(`Extension is not installed: ${pluginId}`);
    return record;
  }

  async #persistEnabledState(): Promise<void> {
    await writeJsonAtomic(this.#paths.pluginState, {schemaVersion: 1, enabled: this.#enabledState});
  }

  #stateChanged(): void {
    this.#options.emit("host-state-changed", undefined);
  }
}

async function readManifest(root: string): Promise<PluginManifest> {
  const manifestPath = path.join(root, ".zdp", "plugin.json");
  const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  for (const entrypoint of [manifest.entrypoints.main, manifest.entrypoints.renderer]) {
    if (!entrypoint) continue;
    const target = containedPath(root, entrypoint);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Extension entrypoint is not a file: ${entrypoint}`);
  }
  return manifest;
}

function containedPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (target !== resolvedRoot) throw new Error(`Path escapes extension root: ${relativePath}`);
  }
  return target;
}

async function rejectLinks(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Extension bundles cannot contain links: ${path.relative(root, target)}`);
      if (entry.isDirectory()) await walk(target);
    }
  };
  await walk(root);
}

function clearRequireCache(root: string): void {
  const require = createRequire(import.meta.url);
  for (const key of Object.keys(require.cache)) {
    const relative = path.relative(root, key);
    if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) delete require.cache[key];
  }
}

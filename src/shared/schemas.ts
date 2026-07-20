import {z} from "zod";
import {API_VERSION, INSTALL_STATE_VERSION, PLUGIN_ID_PATTERN} from "./constants.ts";

const entryPath = z.string().min(1).refine((value) => !value.includes("..") && !/^[\\/]/.test(value), {
  message: "Entrypoints must be relative paths contained by the extension",
});

export const pluginManifestSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  id: z.string().regex(PLUGIN_ID_PATTERN),
  name: z.string().min(1).max(80),
  version: z.string().min(1),
  description: z.string().max(500).optional(),
  entrypoints: z.object({
    main: entryPath.optional(),
    renderer: entryPath.optional(),
  }).refine((value) => Boolean(value.main || value.renderer), "At least one entrypoint is required"),
  engines: z.object({
    host: z.string().default(">=0.1.0"),
    zcode: z.string().default(">=3.3.6"),
  }).default({host: ">=0.1.0", zcode: ">=3.3.6"}),
  pages: z.array(z.object({
    id: z.string().regex(PLUGIN_ID_PATTERN),
    title: z.string().min(1).max(40),
  })).default([]),
}).strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const extensionUpdateSourceSchema = z.object({
  schemaVersion: z.literal(1),
  manifestUrl: z.string().url(),
}).strict();

export type ExtensionUpdateSource = z.infer<typeof extensionUpdateSourceSchema>;

export const extensionReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(PLUGIN_ID_PATTERN),
  apiVersion: z.literal(API_VERSION),
  version: z.string().min(1),
  engines: z.object({
    host: z.string().min(1),
    zcode: z.string().min(1),
  }).strict(),
  archive: z.object({
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    size: z.number().int().positive().max(50 * 1024 * 1024),
  }).strict(),
  releaseUrl: z.string().url(),
  publishedAt: z.string().datetime(),
}).strict();

export type ExtensionReleaseManifest = z.infer<typeof extensionReleaseManifestSchema>;

export const modelRefSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  variant: z.string().min(1).optional(),
}).strict();

export type ModelRef = z.infer<typeof modelRefSchema>;

export const taskSpecSchema = z.object({
  workspacePath: z.string().min(1),
  prompt: z.string().min(1),
  title: z.string().min(1).max(120).optional(),
  mode: z.enum(["plan", "build", "edit", "yolo"]).default("plan"),
  model: modelRefSchema.optional(),
  thoughtLevel: z.string().min(1).optional(),
  toolAllowlist: z.array(z.string().min(1)).optional(),
  toolDenylist: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();

export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const installStateSchema = z.object({
  schemaVersion: z.literal(INSTALL_STATE_VERSION),
  zdpRoot: z.string().min(1),
  zcodeRoot: z.string().min(1),
  zcodeVersion: z.string().min(1),
  vendorAsarSha256: z.string().length(64),
  installedAt: z.string().datetime(),
  repairedAt: z.string().datetime().optional(),
  loaderVersion: z.string().min(1),
  shortcut: z.object({
    path: z.string().min(1),
    originalTarget: z.string().min(1),
    originalArguments: z.string(),
    originalWorkingDirectory: z.string(),
    originalIconLocation: z.string(),
  }).optional(),
  fuses: z.record(z.string(), z.string()),
}).strict();

export type InstallState = z.infer<typeof installStateSchema>;

export type PluginStatus = {
  manifest: PluginManifest;
  enabled: boolean;
  loaded: boolean;
  error?: string;
  rendererUrl?: string;
  generation: number;
  update: ExtensionUpdateStatus;
};

export type ExtensionUpdateStatus = {
  state: "unknown" | "checking" | "up-to-date" | "available" | "incompatible" | "queued" | "error";
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: string;
  queuedVersion?: string;
  error?: string;
};

export type CatalogExtensionStatus = {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  state: "unknown" | "checking" | "available" | "installed" | "incompatible" | "error";
  error?: string;
};

export type HostState = {
  name: string;
  version: string;
  zcodeVersion: string;
  root: string;
  dataDir: string;
  plugins: PluginStatus[];
  catalog: CatalogExtensionStatus[];
  health: {
    protocol: "idle" | "starting" | "ready" | "error";
    protocolError?: string;
  };
};

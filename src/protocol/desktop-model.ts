import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import path from "node:path";
import {modelRefSchema, type ModelRef} from "../shared/schemas.ts";

type ModelRow = {
  provider?: unknown;
  model?: unknown;
};

type Statement = {
  get: (...parameters: unknown[]) => unknown;
};

type Database = {
  prepare: (sql: string) => Statement;
  close: () => void;
};

type NodeSqlite = {
  DatabaseSync: new (databasePath: string, options: {readOnly: boolean}) => Database;
};

export type RuntimeModelConfig = {
  revision: string;
  generatedAt: number;
  model: ModelRef;
  provider: {
    providerId: string;
    kind: "anthropic" | "openai" | "openai-compatible";
    apiFormat?: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
    label?: string;
    source: "builtin" | "models-dev" | "custom" | "user" | "workspace" | "ephemeral";
    baseURL?: string;
    apiKey?: {source: "inline"; value: string};
    apiKeyRequired?: boolean;
    headers?: Record<string, string>;
    providerOptions?: Record<string, unknown>;
    models: Array<{
      modelId: string;
      label?: string;
      contextWindow?: number;
      maxOutputTokens?: number;
      supportsImages?: boolean;
      supportsPdf?: boolean;
      supportsTools?: boolean;
      supportsStructuredOutput?: boolean;
      providerOptions?: Record<string, unknown>;
    }>;
  };
  thoughtLevel?: string;
};

export type DesktopModelResolution = {
  model: ModelRef;
  source: "explicit" | "workspace-task" | "recent-task";
  runtimeModel?: RuntimeModelConfig;
};

type DesktopModelPaths = {
  databasePath?: string;
  providerCachePath?: string;
};

const nodeRequire = createRequire(import.meta.url);

export function parseStoredModelRef(provider: unknown, storedModel: unknown): ModelRef | undefined {
  if (typeof storedModel !== "string" || !storedModel.trim()) return undefined;
  const stored = storedModel.trim();
  const slash = stored.indexOf("/");
  const providerId = slash > 0
    ? stored.slice(0, slash).trim()
    : typeof provider === "string"
      ? provider.trim()
      : "";
  let modelId = slash > 0 ? stored.slice(slash + 1).trim() : stored;
  try {
    modelId = decodeURIComponent(modelId);
  } catch {
    // The task index normally stores a plain value; retain malformed legacy values as-is.
  }
  const parsed = modelRefSchema.safeParse({providerId, modelId});
  return parsed.success ? parsed.data : undefined;
}

export function resolveDesktopModel(
  workspacePath: string,
  databasePath = path.join(homedir(), ".zcode", "v2", "tasks-index.sqlite"),
): DesktopModelResolution | undefined {
  let database: Database | undefined;
  try {
    const {DatabaseSync} = nodeRequire("node:sqlite") as NodeSqlite;
    database = new DatabaseSync(databasePath, {readOnly: true});
    const exact = database.prepare(`
      SELECT provider, model
      FROM tasks
      WHERE deleted = 0
        AND model IS NOT NULL
        AND TRIM(model) <> ''
        AND LOWER(workspace_path) = LOWER(?)
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(path.resolve(workspacePath)) as ModelRow | undefined;
    const exactModel = parseStoredModelRef(exact?.provider, exact?.model);
    if (exactModel) return {model: exactModel, source: "workspace-task"};

    const recent = database.prepare(`
      SELECT provider, model
      FROM tasks
      WHERE deleted = 0
        AND model IS NOT NULL
        AND TRIM(model) <> ''
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as ModelRow | undefined;
    const recentModel = parseStoredModelRef(recent?.provider, recent?.model);
    return recentModel ? {model: recentModel, source: "recent-task"} : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export function resolveDesktopRuntimeModel(
  workspacePath: string,
  requestedModel?: ModelRef,
  paths: DesktopModelPaths = {},
): DesktopModelResolution | undefined {
  const selection = requestedModel
    ? {model: requestedModel, source: "explicit" as const}
    : resolveDesktopModel(workspacePath, paths.databasePath);
  if (!selection) return undefined;
  try {
    const providerCachePath = paths.providerCachePath
      ?? path.join(homedir(), ".zcode", "v2", "bots-model-cache.v2.json");
    const cache = JSON.parse(readFileSync(providerCachePath, "utf8")) as unknown;
    const runtimeModel = buildRuntimeModelFromProviderCache(cache, selection.model);
    return runtimeModel
      ? {...selection, model: runtimeModel.model, runtimeModel}
      : selection;
  } catch {
    return selection;
  }
}

export function buildRuntimeModelFromProviderCache(cacheValue: unknown, requestedModel: ModelRef): RuntimeModelConfig | undefined {
  const cache = asRecord(cacheValue);
  const providers = Array.isArray(cache?.providers) ? cache.providers : [];
  const cachedProvider = providers.map(asRecord).find((provider) => readString(provider?.id) === requestedModel.providerId);
  if (!cachedProvider || cachedProvider.enabled === false || readString(cachedProvider.systemDisabledReason)) return undefined;

  const cachedModels = Array.isArray(cachedProvider.models) ? cachedProvider.models.map(asRecord).filter(Boolean) : [];
  const requestedIds = new Set([
    requestedModel.modelId,
    ...(requestedModel.variant ? [`${requestedModel.modelId}@${requestedModel.variant}`] : []),
  ]);
  const cachedModel = cachedModels.find((model) => requestedIds.has(readString(model?.id) ?? ""));
  if (!cachedModel) return undefined;

  const kind = providerKind(cachedProvider);
  if (!kind) return undefined;
  const cachedModelId = readString(cachedModel.id);
  if (!cachedModelId) return undefined;
  const modelIdByKind = asRecord(cachedModel.modelIdByKind);
  const runtimeModelId = readString(modelIdByKind?.[kind]) ?? cachedModelId;
  const model = modelRefSchema.parse({
    providerId: requestedModel.providerId,
    modelId: runtimeModelId,
    ...(runtimeModelId === requestedModel.modelId && requestedModel.variant ? {variant: requestedModel.variant} : {}),
  });
  const endpoints = asRecord(cachedProvider.endpoints);
  const baseURL = readString(endpoints?.baseURL);
  const apiFormat = providerApiFormat(cachedProvider);
  const modelInput = {
    modelId: runtimeModelId,
    ...(readString(cachedModel.name) || readString(cachedModel.label)
      ? {label: readString(cachedModel.name) ?? readString(cachedModel.label)}
      : {}),
    ...(readPositiveInteger(cachedModel.contextWindow) ?? readPositiveInteger(asRecord(cachedModel.limit)?.context)
      ? {contextWindow: readPositiveInteger(cachedModel.contextWindow) ?? readPositiveInteger(asRecord(cachedModel.limit)?.context)}
      : {}),
    ...(readPositiveInteger(cachedModel.maxOutputTokens) ?? readPositiveInteger(asRecord(cachedModel.limit)?.output)
      ? {maxOutputTokens: readPositiveInteger(cachedModel.maxOutputTokens) ?? readPositiveInteger(asRecord(cachedModel.limit)?.output)}
      : {}),
    ...capabilities(cachedModel),
  };
  const source = providerSource(cachedProvider.source);
  const apiKey = readString(cachedProvider.apiKey);
  const headers = stringRecord(cachedProvider.headers);
  const provider = {
    providerId: requestedModel.providerId,
    kind,
    ...(apiFormat ? {apiFormat} : {}),
    ...(readString(cachedProvider.name) ? {label: readString(cachedProvider.name)} : {}),
    source,
    ...(baseURL ? {baseURL} : {}),
    ...(apiKey ? {apiKey: {source: "inline" as const, value: apiKey}} : {}),
    ...(typeof cachedProvider.apiKeyRequired === "boolean" ? {apiKeyRequired: cachedProvider.apiKeyRequired} : {}),
    ...(headers ? {headers} : {}),
    providerOptions: {
      ...(endpoints ? {endpoints} : {}),
      ...(apiFormat ? {apiFormat} : {}),
      modelSupportedFormats: asRecord(cachedProvider.modelSupportedFormats) ?? {},
    },
    models: [modelInput],
  };
  const generatedAt = readNonNegativeInteger(cache?.updatedAt) ?? Date.now();
  const revision = `model-runtime:${createHash("sha256").update(stableStringify({model, provider})).digest("hex").slice(0, 24)}`;
  return {revision, generatedAt, model, provider};
}

function providerKind(provider: Record<string, unknown>): RuntimeModelConfig["provider"]["kind"] | undefined {
  const value = readString(provider.defaultKind) ?? readString(provider.kind);
  if (value === "anthropic" || value === "openai" || value === "openai-compatible") return value;
  const format = readString(provider.apiFormat);
  if (format === "anthropic-messages") return "anthropic";
  if (format === "openai-chat-completions" || format === "openai-responses") return "openai-compatible";
  return undefined;
}

function providerApiFormat(provider: Record<string, unknown>): RuntimeModelConfig["provider"]["apiFormat"] | undefined {
  const value = readString(provider.apiFormat);
  return value === "anthropic-messages" || value === "openai-chat-completions" || value === "openai-responses"
    ? value
    : undefined;
}

function providerSource(value: unknown): RuntimeModelConfig["provider"]["source"] {
  return value === "builtin" || value === "models-dev" || value === "custom" || value === "user" || value === "ephemeral"
    ? value
    : "workspace";
}

function capabilities(model: Record<string, unknown>) {
  const modalities = asRecord(model.modalities);
  const input = Array.isArray(modalities?.input) ? modalities.input : [];
  return {
    ...(input?.includes("image") ? {supportsImages: true} : {}),
    ...(input?.includes("pdf") ? {supportsPdf: true} : {}),
    ...(typeof model.supportsTools === "boolean" ? {supportsTools: model.supportsTools} : {}),
    ...(typeof model.supportsStructuredOutput === "boolean" ? {supportsStructuredOutput: model.supportsStructuredOutput} : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, item]) => [key.trim(), item.trim()] as const)
    .filter(([key, item]) => key && item);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

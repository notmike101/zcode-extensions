import type * as Sdk from "./index";

export const ZCODE_EXTENSION_API_VERSION = 1 as const;

export function defineMainExtension(extension: Sdk.ExtensionModule): Sdk.ExtensionModule {
  return extension;
}

export type {
  ExtensionActivationResult,
  ExtensionCapability,
  ExtensionContext,
  ExtensionDisposable,
  ExtensionHostCapabilities,
  ExtensionLogger,
  ExtensionManifest,
  ExtensionModule,
  ExtensionTaskRunHandle,
  ExtensionTaskSpec,
  ExtensionZCodeApi,
  ModelRequestEvent,
  ModelRequestHistory,
  ModelRequestRecord,
  ModelTokenUsage,
  ZCodeMcpServerStatus,
  ZCodeMessage,
  ZCodeModelGenerationResult,
  ZCodeProviderDescriptor,
  ZCodeProviderRegistry,
  ZCodeSessionEvent,
  ZCodeSessionSummary,
  ZCodeSessionTarget,
  ZCodeTaskListResult,
  ZCodeTaskSummary,
  ZCodeWorkspaceDefaults,
  ZCodeWorkspaceTarget,
} from "./index";

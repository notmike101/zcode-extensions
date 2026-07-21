import type * as Sdk from "./index";

export const UI_CONTRIBUTION_SLOTS = [
  "sidebar.navigation",
  "workspace.header.actions",
  "task.row.trailing",
  "chat.header.actions",
  "chat.overlay",
  "chat.composer.leading",
  "chat.composer.trailing",
  "chat.turn.after",
  "chat.message.before",
  "chat.message.after",
  "chat.message.footer",
  "chat.message.overlay",
] as const;

export function defineRendererExtension(extension: Sdk.RendererExtension): Sdk.RendererExtension {
  return extension;
}

export type {
  ActiveUiContext,
  ExtensionBridge,
  ExtensionCapability,
  ExtensionDisposable,
  ExtensionHostCapabilities,
  ModelRequestEvent,
  ModelRequestHistory,
  ModelTokenUsage,
  RendererExtension,
  RendererExtensionContext,
  UiContributionMount,
  UiContributionSlot,
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

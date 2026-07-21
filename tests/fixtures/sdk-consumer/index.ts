import {assertExtensionManifest} from "@notmike101/zcode-extension-sdk";
import {defineMainExtension} from "@notmike101/zcode-extension-sdk/main";
import {defineRendererExtension} from "@notmike101/zcode-extension-sdk/renderer";
import type {ModelRequestRecord, ZCodeSubscriptionTarget} from "@notmike101/zcode-extension-sdk/renderer";
import type {ZCodeRawChannel} from "@notmike101/zcode-extension-sdk/experimental";

const manifest = assertExtensionManifest({
  apiVersion: 1,
  id: "consumer-test",
  name: "Consumer Test",
  version: "1.0.0",
  entrypoints: {renderer: "dist/renderer.js"},
  capabilities: ["zcode.sessions.read", "zcode.usage.read", "ui.pages"],
});

defineMainExtension({
  async activate(context) {
    const target = await context.zcode.sessions.resolveTarget("session-1");
    if (target) await context.zcode.sessions.readMessages({...target, limit: 10});
  },
});

defineRendererExtension({
  id: manifest.id,
  mountPage(_pageId, container, context) {
    container.textContent = context.capabilities.hostVersion;
  },
});

declare const channel: ZCodeRawChannel;
declare const requestRecord: ModelRequestRecord;
declare const subscriptionTarget: ZCodeSubscriptionTarget;
void channel.call("inspect", {});
void requestRecord.usage?.outputTokens;
void subscriptionTarget.includeSnapshot;

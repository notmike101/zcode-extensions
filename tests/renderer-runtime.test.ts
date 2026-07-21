import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {Window} from "happy-dom";
import type {ActiveUiContext, ExtensionHostCapabilities, ExtensionManifest, RendererExtension} from "../sdk/index.ts";
import type {PluginStatus} from "../src/shared/schemas.ts";
import type {ZdpBridge} from "../src/renderer/globals.d.ts";
import {RendererExtensionRuntime} from "../src/renderer/extension-runtime.ts";

let window: Window;

describe("renderer extension runtime", () => {
  beforeEach(() => {
    window = new Window({url: "https://zcode.local"});
    window.document.body.innerHTML = '<div id="root"></div>';
    Object.assign(globalThis, {
      window,
      document: window.document,
      MutationObserver: window.MutationObserver,
      HTMLElement: window.HTMLElement,
      HTMLButtonElement: window.HTMLButtonElement,
      Element: window.Element,
      crypto: window.crypto,
    });
  });

  afterEach(() => window.close());

  test("activates vNext once, remounts shadow-root contributions, and disposes on reload/disable", async () => {
    const bridge = createBridge(["ui.pages", "ui.chat", "zcode.usage.read"]);
    const runtime = new RendererExtensionRuntime(bridge.value);
    let activations = 0;
    let activationCleanups = 0;
    let contributionMounts = 0;
    let contributionCleanups = 0;
    const plugin: RendererExtension = {
      id: "runtime-test",
      activate(context) {
        activations += 1;
        context.zcode.usage.subscribeModelRequests({
          workspacePath: "D:\\project",
          sessionId: "session-1",
        }, () => undefined);
        context.ui.contribute("chat.message.footer", (container, active) => {
          contributionMounts += 1;
          container.textContent = `${active.role}:${active.messageId}`;
          return () => { contributionCleanups += 1; };
        }, {when: (active) => active.role === "assistant"});
        return () => { activationCleanups += 1; };
      },
      mountPage(pageId, container) {
        container.textContent = `page:${pageId}`;
        return () => container.replaceChildren();
      },
    };
    runtime.register(plugin);
    runtime.sync([status(1, true, ["ui.pages", "ui.chat", "zcode.usage.read"])]);
    const chat = appendChatMessage("message-1");
    const page = window.document.createElement("div");
    window.document.body.append(page);
    const pageCleanup = await runtime.mountPage("runtime-test", "dashboard", page as never);
    await settle();

    expect(activations).toBe(1);
    expect(page.querySelector("[data-zdp-extension-page]")?.shadowRoot?.textContent).toBe("page:dashboard");
    expect(contributionMounts).toBe(1);
    expect(chat.querySelector("[data-zdp-contribution]")?.shadowRoot?.textContent).toBe("assistant:message-1");
    expect(bridge.subscriptions).toBe(1);

    chat.remove();
    const replacement = appendChatMessage("message-2");
    runtime.refreshUi();
    await settle();
    expect(contributionCleanups).toBe(1);
    expect(contributionMounts).toBe(2);
    expect(replacement.querySelector("[data-zdp-contribution]")?.shadowRoot?.textContent).toBe("assistant:message-2");

    runtime.sync([status(2, true, ["ui.pages", "ui.chat", "zcode.usage.read"])]);
    await settle();
    expect(activations).toBe(2);
    expect(activationCleanups).toBe(1);
    expect(page.textContent).toBe("");
    expect(bridge.unsubscriptions).toBe(1);

    runtime.sync([status(2, false, ["ui.pages", "ui.chat", "zcode.usage.read"])]);
    await settle();
    expect(activationCleanups).toBe(2);
    expect(window.document.querySelectorAll("[data-zdp-contribution]")).toHaveLength(0);
    expect(bridge.unsubscriptions).toBe(2);
    pageCleanup();
  });

  test("retains legacy mount and denies undeclared page capability", async () => {
    const legacyBridge = createBridge(["zcode.workspaces.read", "zcode.tasks.run", "ui.pages"], true);
    const legacy = new RendererExtensionRuntime(legacyBridge.value);
    let legacyCleanup = 0;
    legacy.register({
      id: "runtime-test",
      mount(container) {
        container.textContent = "legacy";
        return () => { legacyCleanup += 1; container.replaceChildren(); };
      },
    });
    legacy.sync([status(1, true)]);
    const container = window.document.createElement("div");
    window.document.body.append(container);
    await legacy.mountPage("runtime-test", "dashboard", container as never);
    expect(container.textContent).toBe("legacy");
    legacy.sync([status(1, false)]);
    await settle();
    expect(legacyCleanup).toBe(1);

    const restricted = new RendererExtensionRuntime(createBridge([]).value);
    restricted.register({id: "runtime-test", mountPage() {}});
    restricted.sync([status(1, true, [])]);
    await expect(restricted.mountPage("runtime-test", "dashboard", container as never))
      .rejects.toThrow("ui.pages");
  });

  test("supplies the assistant descendant as context for a real ZCode turn shell without turn ids", async () => {
    const runtime = new RendererExtensionRuntime(createBridge(["ui.chat"]).value);
    let mountedContext: ActiveUiContext | undefined;
    runtime.register({
      id: "runtime-test",
      activate(context) {
        context.ui.contribute("chat.turn.after", (_container, active) => {
          mountedContext = active;
        });
      },
    });
    runtime.sync([status(1, true, ["ui.chat"])]);
    const root = window.document.getElementById("root")!;
    root.innerHTML = `<main data-testid="chat-view" data-session-id="session-1">
      <section data-chat-turn-group-shell="true">
        <article data-message-id="user-message" data-role="user"></article>
        <article data-message-id="assistant-message" data-role="assistant"></article>
      </section>
    </main>`;
    runtime.refreshUi();
    await settle();

    expect(mountedContext).toMatchObject({
      sessionId: "session-1",
      messageId: "assistant-message",
      role: "assistant",
    });
    expect(mountedContext?.turnId).toBeUndefined();
    await runtime.dispose();
  });
});

function appendChatMessage(messageId: string): HTMLElement {
  const root = window.document.getElementById("root")!;
  root.innerHTML = `<main data-testid="chat-view" data-task-id="session-1" data-session-id="session-1">
    <article data-message-id="${messageId}" data-role="assistant"></article>
  </main>`;
  return root.querySelector("article") as never;
}

function status(generation: number, enabled: boolean, capabilities?: ExtensionManifest["capabilities"]): PluginStatus {
  return {
    manifest: {
      apiVersion: 1,
      id: "runtime-test",
      name: "Runtime Test",
      version: "1.0.0",
      entrypoints: {renderer: "dist/renderer.js"},
      engines: {host: ">=0.3.0", zcode: ">=3.3.6"},
      pages: [{id: "dashboard", title: "Dashboard"}],
      ...(capabilities === undefined ? {} : {capabilities}),
    },
    enabled,
    loaded: enabled,
    generation,
    update: {state: "up-to-date", currentVersion: "1.0.0"},
  };
}

function createBridge(granted: ExtensionManifest["capabilities"] = [], legacyDefaults = false) {
  const listeners = new Set<(event: string, payload: unknown) => void>();
  let subscriptions = 0;
  let unsubscriptions = 0;
  const capabilities: ExtensionHostCapabilities = {
    apiVersion: 1,
    hostVersion: "0.3.0",
    zcodeVersion: "3.3.6",
    declared: legacyDefaults ? [] : granted,
    granted,
    legacyDefaults,
    uiSlots: ["chat.message.footer"],
    experimental: false,
  };
  const value: ZdpBridge = {
    async invoke<T>(method: string): Promise<T> {
      if (method === "plugin:capabilities") return capabilities as T;
      if (method === "plugin:zcode:subscribe") {
        subscriptions += 1;
        return `subscription-${subscriptions}` as T;
      }
      if (method === "plugin:zcode:unsubscribe") {
        unsubscriptions += 1;
        return undefined as T;
      }
      return undefined as T;
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {
    value,
    get subscriptions() { return subscriptions; },
    get unsubscriptions() { return unsubscriptions; },
  };
}

async function settle(): Promise<void> {
  await window.happyDOM.whenAsyncComplete();
  await Bun.sleep(30);
  await window.happyDOM.whenAsyncComplete();
}

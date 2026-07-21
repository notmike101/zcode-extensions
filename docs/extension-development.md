# Developing ZCode Desktop Extensions

This guide describes extension API version 1 as implemented by host/SDK 0.3.1. The public package is [`@notmike101/zcode-extension-sdk`](https://www.npmjs.com/package/@notmike101/zcode-extension-sdk), the source contract is [`sdk/index.ts`](../sdk/index.ts), and [Hello Extension](../examples/hello-extension) remains a complete legacy-lifecycle example.

Extensions are trusted local code. A main entrypoint runs in ZCode's Electron main process with Node.js access, while an optional renderer entrypoint runs inside the ZCode renderer. Declared capabilities control access through the SDK and are shown during installation; they do not sandbox trusted Node or renderer code.

## Quick start

For a separate Bun or TypeScript project:

```powershell
bun add -d @notmike101/zcode-extension-sdk@0.3.1
```

Import main-only types and helpers from `@notmike101/zcode-extension-sdk/main`, browser-safe renderer types and helpers from `/renderer`, and unstable raw-channel types from `/experimental`. The root export is also browser-safe. A JSON Schema is available at `/manifest.schema.json`, and `validateExtensionManifest` or `assertExtensionManifest` can validate manifests at runtime.

From a clone of this repository, `bun run build:example` builds Hello Extension. Open **Extensions → Installed → Install extension**, select `examples\hello-extension`, then use **Reload** after rebuilding an installed development copy.

## Extension layout

```text
hello-extension/
├── .zdp/
│   ├── plugin.json
│   └── update.json        # optional update feed pointer
├── dist/
│   ├── main.cjs
│   └── renderer.js
├── src/
│   ├── main.ts
│   └── renderer.ts
└── build.ts
```

The selected folder is copied into `data\plugins\<extension-id>`. Symbolic links are rejected, entrypoints must remain inside the extension root, and at least one main or renderer entrypoint is required.

## Manifest

The manifest filename remains `.zdp\plugin.json` for API compatibility:

```json
{
  "apiVersion": 1,
  "id": "hello-extension",
  "name": "Hello Extension",
  "version": "0.1.0",
  "description": "A minimal example extension.",
  "entrypoints": {
    "main": "dist/main.cjs",
    "renderer": "dist/renderer.js"
  },
  "engines": {
    "host": ">=0.3.0 <1",
    "zcode": ">=3.3.6"
  },
  "capabilities": [
    "zcode.workspaces.read",
    "zcode.tasks.run",
    "ui.pages"
  ],
  "pages": [
    {"id": "hello", "title": "Hello"}
  ]
}
```

| Field | Contract |
| --- | --- |
| `apiVersion` | Must be `1`. |
| `id` | Lowercase letters, numbers, dots, and hyphens; 1–64 characters with alphanumeric ends. This is the IPC, data, and renderer namespace. |
| `name` | User-facing name, at most 80 characters. |
| `version` | Extension version. Semantic versioning is required to participate in automatic updates. |
| `description` | Optional user-facing description, at most 500 characters. |
| `entrypoints.main` | Optional Node.js entrypoint. Bundle as CommonJS. |
| `entrypoints.renderer` | Optional browser entrypoint. Bundle as a self-registering IIFE. |
| `engines.host` | SemVer range for compatible ZCode Desktop Extensions host versions. |
| `engines.zcode` | SemVer range for compatible ZCode releases. |
| `pages` | Manager navigation entries. Page IDs follow the same identifier pattern and titles are limited to 40 characters. |
| `capabilities` | Optional SDK/UI privileges. An omitted field receives only the legacy API-v1 workspace-read, task-run, and page behavior. |

The manifest is strict: unknown keys, path traversal, absolute entrypoints, empty entrypoints, and incompatible engine ranges are rejected.

### Capabilities

| Capability | Enables |
| --- | --- |
| `zcode.workspaces.read` | Workspace state, provider registry, and defaults. |
| `zcode.sessions.read` / `.events` / `.write` | Session history reads, subscriptions, and session mutation. |
| `zcode.tasks.read` / `.run` / `.write` | Task metadata and usage, native task execution, and task mutation. |
| `zcode.models.read` / `.generate` | Provider/default/MCP discovery and direct generation. |
| `zcode.usage.read` | Sanitized model-request history and lifecycle events. |
| `zcode.broadcast` | Named host broadcast channels. |
| `ui.pages` / `.navigation` / `.workspace` / `.tasks` / `.chat` / `.overlays` | The matching page or stable UI contribution surfaces. |
| `experimental.zcode.rpc` | Version-gated private ZCode service channels. |
| `experimental.ui.dom` | Selector-based renderer anchors outside stable UI slots. |

Calls without their declared capability reject with an explicit error. Use `context.zcode.capabilities()` or `rendererContext.capabilities` to inspect the effective grants. Existing API-v1 manifests without a `capabilities` field remain compatible and receive `zcode.workspaces.read`, `zcode.tasks.run`, and `ui.pages` only.

## Main entrypoint

Export `activate(context)`. It may return a cleanup function or an object with `dispose()`. An optional `deactivate()` export is also supported.

```typescript
import type {ExtensionContext, ExtensionDisposable} from "@notmike101/zcode-extension-sdk/main";

export async function activate(
  context: ExtensionContext,
): Promise<ExtensionDisposable> {
  const handler = context.ipc.handle("status", () => ({ready: true}));
  await context.logger.info("Extension activated");

  return {
    dispose: async () => {
      await handler.dispose();
      await context.logger.info("Extension disposed");
    },
  };
}
```

Activation failures are isolated to the extension and shown in the manager. Disable, reload, uninstall, host shutdown, and built-in upgrades all invoke cleanup. Do not leave timers, listeners, subprocesses, or IPC registrations alive after disposal.

### `ExtensionContext`

| API | Behavior |
| --- | --- |
| `manifest` | Parsed manifest for the active extension. |
| `dataDir` | Private persistent directory under `data\plugin-data\<id>`. Create files here rather than inside the copied bundle. |
| `logger.debug/info/warn/error` | Append structured JSONL log entries visible through **Extensions → Health**. |
| `logger.child(scope)` | Create a nested logger scope. |
| `ipc.handle(method, handler)` | Register a namespaced renderer-callable method and receive a disposable. |
| `ipc.emit(event, payload)` | Emit `plugin:<id>:<event>` to renderer bridges. |
| `lifecycle.onResume(handler)` | Run after Windows resume or unlock and receive a disposable. |
| `zcode.capabilities()` | Read declared/effective grants plus host/ZCode versions and supported UI slots. |
| `zcode.workspaces.*` | Read workspace state, provider registry, and defaults. `readWorkspaceState` remains as a deprecated compatibility alias. |
| `zcode.sessions.*` | Resolve a session ID to its read-only workspace target, list/read sessions and messages, subscribe to events, or perform capability-gated session actions. |
| `zcode.tasks.run(spec)` | Start a normal persistent ZCode sidebar task and receive a run handle. |
| `zcode.tasks.ensureVisible(spec)` | Restore a retained session to the native task index and optionally assign its title. Useful for one-time migrations. |
| `zcode.tasks.*` | Read task metadata, snapshots/usage, subscribe to lifecycle changes, and perform task actions. |
| `zcode.models.*` / `zcode.mcp.list()` | Discover model providers/defaults/MCP state or request model generation. |
| `zcode.usage.*` | Read sanitized request history and subscribe to model-request lifecycle events. |
| `zcode.broadcast.*` | Send/listen on named broadcast channels. |
| `zcode.experimental.channel(name)` | Call or listen on a private service channel when explicitly enabled. |

IPC method and event names use the identifier pattern. Duplicate handlers are rejected.

## Renderer entrypoint

Renderer bundles register once through the compatibility global `window.ZDP_REGISTER_PLUGIN_RENDERER`. The registration `id` must equal the extension manifest ID. Host 0.3 adds global activation and page-aware mounting while preserving the legacy `mount(container, bridge)` lifecycle.

```typescript
import {defineRendererExtension} from "@notmike101/zcode-extension-sdk/renderer";

window.ZDP_REGISTER_PLUGIN_RENDERER?.(defineRendererExtension({
  id: "hello-extension",
  activate(context) {
    context.subscriptions.add(context.ui.contribute(
      "chat.message.footer",
      (container, active) => {
        if (active.role !== "assistant") return;
        container.textContent = "Hello from the extension";
      },
    ));
  },
  async mountPage(pageId, container, context) {
    if (pageId !== "hello") return;
    const status = await context.ipc.invoke<{ready: boolean}>("status");
    container.textContent = status.ready ? "Ready" : "Not ready";
    return () => container.replaceChildren();
  },
}));
```

`activate(rendererContext)` runs once per enabled renderer and is the right place for subscriptions and UI contributions. `mountPage(pageId, container, rendererContext)` runs for the selected extension page. vNext pages and contributions are mounted inside extension-owned shadow roots; disable, reload, renderer teardown, or SPA replacement disposes and safely remounts them. Return a cleanup function or disposable from either lifecycle, or add it to `context.subscriptions`.

`rendererContext` provides:

- Namespaced `ipc.invoke` and `ipc.on` without manually supplying the extension ID.
- Namespaced local UI preferences through `storage`; do not use it for prompts or responses.
- The capability-gated ZCode read/event proxies available to renderer code.
- `ui.activeContext` with current workspace, task, session, turn, message, role, status, and tool-call identifiers when available.
- Toasts, confirmation dialogs, and stable UI contribution slots.
- `ui.experimental.anchor(...)` for selector-based surfaces when `experimental.ui.dom` is declared.

Stable contribution slots are `sidebar.navigation`, `workspace.header.actions`, `task.row.trailing`, `chat.header.actions`, `chat.overlay`, `chat.composer.leading`, `chat.composer.trailing`, `chat.turn.after`, `chat.message.before`, `chat.message.after`, `chat.message.footer`, and `chat.message.overlay`. The host enforces the matching `ui.*` capability.

For host versions before 0.3, retain the legacy form when compatibility matters:

```typescript
import type {ExtensionBridge} from "@notmike101/zcode-extension-sdk/renderer";

window.ZDP_REGISTER_PLUGIN_RENDERER?.({
  id: "hello-extension",
  mount(container, bridge: ExtensionBridge) {
    container.textContent = "Legacy page";
    return () => container.replaceChildren();
  },
});
```

Legacy `mount` receives the preload bridge directly. Namespace its CSS because legacy pages share the manager shadow root.

### Bridge methods

- `bridge.invoke("plugin:invoke", {pluginId, method, payload})` calls a main-process handler.
- `bridge.on(listener)` receives host and extension events and returns an unsubscribe function.
- An emitted extension event arrives as `plugin:<extension-id>:<event>` with its payload.

Do not call host management methods such as install or uninstall from extension pages. Treat payloads from either process as untrusted input and validate them.

## Running ZCode tasks

`context.zcode.tasks.run` accepts:

```typescript
const handle = await context.zcode.tasks.run({
  workspacePath: "D:\\project",
  prompt: "Run the weekly maintenance task.",
  title: "⏰ Weekly maintenance",
  mode: "build",
  model: {
    providerId: "openai",
    modelId: "example-model"
  },
  thoughtLevel: "high",
  timeoutMs: 30 * 60 * 1000,
  toolAllowlist: ["read_file"],
  toolDenylist: ["shell"]
});

context.logger.info("Task started", {sessionId: handle.sessionId});
const result = await handle.completion;
```

`mode` is required by the TypeScript SDK; runtime validation defaults an omitted JavaScript value to `plan`. Title, model, thought level, timeout, and tool lists are optional. The title is applied to the ordinary native task visible in ZCode's sidebar. With no explicit model, ZCode's desktop service resolves its normal workspace or global selection.

The completion status is one of `succeeded`, `failed`, `cancelled`, `timed_out`, `lost`, or `needs_attention`. Call `handle.stop()` during extension cleanup when an active run must be cancelled.

The ZCode desktop task service is private and can change between ZCode releases. Use conservative engine ranges, handle service errors, and test against every ZCode version you claim to support. The host does not patch ZCode's task database or vendor source to provide this API.

## Events and model usage

Session subscriptions preserve host ordering and replay state across a service reconnect. Each normalized event carries `sessionId`, optional `turnId`/`seq`/trace/timestamp metadata, its `type`, a payload, the untouched `raw` envelope, and `known`. Known names cover session, turn, message/part, model/tool, permission/input, checkpoint/rewind, and recovery events. An unrecognized future event is delivered with `known: false`; it is never silently discarded.

Task, workspace, and broadcast subscriptions use the same forward-compatible envelope approach. Always dispose a subscription. The gateway reference-counts equivalent private-service subscriptions, tears them down when the last listener leaves, and reconnects with its last sequence cursor when possible. Renderer extensions that begin with only an active `sessionId` can call `sessions.resolveTarget(sessionId)` before listing or subscribing; ambiguous task-index matches return `undefined` instead of selecting the wrong workspace.

`zcode.usage.listModelRequests({sessionId, limit})` returns bounded, sanitized model-request records. They can include request/turn IDs, attempt, timing, model/provider identity, call source, status, finish reason, and provider token usage. Prompt and response bodies are never exposed by the usage API. `subscribeModelRequests` emits start, completion, failure, retry, and stall lifecycle records with the same restriction.

```typescript
const history = await context.zcode.usage.listModelRequests({
  sessionId,
  limit: 200,
});

for (const request of history.records) {
  const outputTokens = request.usage?.outputTokens;
  if (request.status === "completed" && outputTokens && request.durationMs) {
    const tokensPerSecond = outputTokens / (request.durationMs / 1000);
    await context.logger.info("Model throughput", {
      requestId: request.requestId,
      tokensPerSecond,
    });
  }
}
```

This duration is the complete provider request, including time to first token and network completion. It is not decoder-only throughput. Extensions must decide explicitly whether retries, subagents, compact calls, and sidecars belong in their own aggregate.

## Experimental private channels

When a stable API is not yet available, an extension may declare `experimental.zcode.rpc` and use:

```typescript
const channel = context.zcode.experimental.channel("installed-private-service");
const result = await channel.call("commandName", {value: 1});
const subscription = channel.listen("eventName", {includeSnapshot: true}, console.log);
```

The gateway can reach any installed private service channel, but this escape hatch deliberately makes no stability promise for its command names or wire payloads. Gate the extension to tested ZCode versions, validate every value, handle absence visibly, and dispose every listener.

## Persistence and scheduling

- Persist only beneath `context.dataDir`.
- Use atomic replacement for state files and append-only or bounded logs for history.
- Treat timers as best-effort application timers: ZCode must remain open.
- Register resume handlers when time-sensitive state must be recalculated after sleep.
- Define missed-run, overlap, cancellation, and retry behavior explicitly.

The separate [Scheduler repository](https://github.com/notmike101/zcode-scheduler) is the full reference for persistent jobs, cron timezones, overlap policies, native task handles, bounded history, migrations, and resume behavior.

## Build and package

Bundle dependencies into the extension:

```typescript
await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  target: "node",
  format: "cjs",
  naming: "main.cjs",
});

await Bun.build({
  entrypoints: ["src/renderer.ts"],
  outdir: "dist",
  target: "browser",
  format: "iife",
  naming: "renderer.js",
});
```

The main entrypoint is loaded with Node's CommonJS loader. The renderer must execute without module imports at runtime. Mark Electron as external if used, never package symlinks, and ensure every manifest entrypoint exists before distribution.

An installable ZIP should expand to one folder containing `.zdp` and the built entrypoints. Do not include `node_modules` when dependencies are already bundled.

## Extension updates

To opt into host-managed updates, add `.zdp/update.json`:

```json
{
  "schemaVersion": 1,
  "manifestUrl": "https://example.com/releases/latest/download/extension-update.json"
}
```

The feed must be served over HTTPS and contain a release manifest:

```json
{
  "schemaVersion": 1,
  "id": "hello-extension",
  "apiVersion": 1,
  "version": "0.2.0",
  "engines": {"host": ">=0.2.0 <1", "zcode": ">=3.3.6"},
  "archive": {
    "url": "https://example.com/releases/v0.2.0/hello-extension-v0.2.0.zip",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "size": 12345
  },
  "releaseUrl": "https://example.com/releases/v0.2.0",
  "publishedAt": "2026-07-19T12:00:00.000Z"
}
```

The host bounds feed, archive, entry-count, and expanded sizes; verifies the exact archive size and SHA-256; rejects traversal, links, duplicate paths, and multiple roots; validates both manifests and engine ranges; and stages the result for the next launch. An activation failure rolls an enabled extension back to its prior bundle. Private state under `context.dataDir` is never included in the transaction.

## Development workflow

1. Build the extension.
2. Validate `.zdp\plugin.json` and its engine ranges.
3. Install the folder through **Extensions → Installed**.
4. Inspect **Health** for activation or protocol errors.
5. Rebuild the installed development copy and choose **Reload**, or uninstall and reinstall the source folder.
6. Disable and re-enable to verify cleanup and cold activation.
7. Close and reopen ZCode to verify persistence.
8. Test safe mode and incompatible host/ZCode ranges before publishing.
9. Serve a candidate update feed and verify queue, restart application, activation, and rollback behavior.

## Release checklist

- Bundle both entrypoints and verify their exact manifest paths.
- Increment the extension version.
- If updates are supported, publish a matching immutable ZIP, checksum, and `extension-update.json` feed.
- Keep `apiVersion` at `1` until the host introduces another API.
- Set the narrowest accurate host and ZCode engine ranges.
- Validate every IPC payload and renderer result.
- Dispose timers, handlers, listeners, and active tasks.
- Keep private data under `context.dataDir`.
- Document permissions, network access, subprocesses, and destructive actions.
- Test install, reload, disable, restart, upgrade, and uninstall.

## Security model

Extensions are not sandboxed. Main entrypoints have Node.js file and process access, and renderer code runs inside the ZCode renderer. The host validates manifests, paths, compatibility, and links, but it does not make untrusted code safe.

Never install or distribute an extension you have not reviewed. Extension authors should minimize privileges, avoid collecting secrets, and clearly disclose external communication or destructive behavior.

## Compatibility identifiers

The user-facing term is **extension**, but API version 1 retains these plugin-named identifiers:

- `.zdp/plugin.json`
- `plugin:invoke` and `plugin:<id>:<event>`
- `ZDP_REGISTER_PLUGIN_RENDERER`
- `data/plugins` and `data/plugin-data`

Treat them as stable wire and storage names. New user-facing labels, documentation, and type names should use **extension**.

# Developing ZCode Desktop Extensions

This guide describes extension API version 1. The public TypeScript contract is [`sdk/index.ts`](../sdk/index.ts), and [Hello Extension](../examples/hello-extension) is a complete buildable example.

Extensions are trusted local code. A main entrypoint runs in ZCode's Electron main process with Node.js access, while an optional renderer entrypoint runs in the ZCode renderer and mounts pages inside the Extensions manager.

## Quick start

From a clone of this repository:

```powershell
bun install --frozen-lockfile
bun run build:example
```

Open **Extensions → Installed → Install extension** and select `examples\hello-extension`. Open **Hello** in the manager and use **Reload** after rebuilding an installed development copy.

For a separate project, copy the example and `sdk/index.ts` together or reproduce the documented structural types. There is no npm SDK package in API version 1.

## Extension layout

```text
hello-extension/
├── .zdp/
│   └── plugin.json
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
    "host": ">=0.1.2 <1",
    "zcode": ">=3.3.6"
  },
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
| `version` | Extension version. Semantic versioning is recommended. |
| `description` | Optional user-facing description, at most 500 characters. |
| `entrypoints.main` | Optional Node.js entrypoint. Bundle as CommonJS. |
| `entrypoints.renderer` | Optional browser entrypoint. Bundle as a self-registering IIFE. |
| `engines.host` | SemVer range for compatible ZCode Desktop Extensions host versions. |
| `engines.zcode` | SemVer range for compatible ZCode releases. |
| `pages` | Manager navigation entries. Page IDs follow the same identifier pattern and titles are limited to 40 characters. |

The manifest is strict: unknown keys, path traversal, absolute entrypoints, empty entrypoints, and incompatible engine ranges are rejected.

## Main entrypoint

Export `activate(context)`. It may return a cleanup function or an object with `dispose()`. An optional `deactivate()` export is also supported.

```typescript
import type {ExtensionContext, ExtensionDisposable} from "./sdk/index.ts";

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
| `zcode.readWorkspaceState(path)` | Read ZCode's current stored workspace state through the task protocol. |
| `zcode.tasks.run(spec)` | Start a normal ZCode task and receive a run handle. |

IPC method and event names use the identifier pattern. Duplicate handlers are rejected.

## Renderer entrypoint

Renderer bundles register once through the compatibility global `window.ZDP_REGISTER_PLUGIN_RENDERER`. The registration `id` must equal the extension manifest ID.

```typescript
import type {ExtensionBridge} from "./sdk/index.ts";

window.ZDP_REGISTER_PLUGIN_RENDERER?.({
  id: "hello-extension",
  mount(container, bridge) {
    const button = document.createElement("button");
    button.textContent = "Check status";
    container.replaceChildren(button);

    const click = async () => {
      const result = await invoke<{ready: boolean}>(bridge, "status");
      button.textContent = result.ready ? "Ready" : "Not ready";
    };
    button.addEventListener("click", click);

    return () => {
      button.removeEventListener("click", click);
      container.replaceChildren();
    };
  },
});

function invoke<T>(bridge: ExtensionBridge, method: string): Promise<T> {
  return bridge.invoke<T>("plugin:invoke", {
    pluginId: "hello-extension",
    method,
  });
}
```

`mount` receives a dedicated container and the preload bridge. Return cleanup that removes DOM listeners, subscriptions, observers, and timers. Namespace CSS selectors because all extension pages share the manager shadow root.

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

`mode` is required by the TypeScript SDK; runtime validation defaults an omitted JavaScript value to `plan`. Model, thought level, timeout, and tool lists are optional. With no explicit model, the host inherits the newest compatible ZCode desktop selection for the workspace and then the most recent global selection.

The completion status is one of `succeeded`, `failed`, `cancelled`, `timed_out`, `lost`, or `needs_attention`. Call `handle.stop()` during extension cleanup when an active run must be cancelled.

The ZCode task protocol is private and can change between ZCode releases. Use conservative engine ranges, handle protocol errors, and test against every ZCode version you claim to support.

## Persistence and scheduling

- Persist only beneath `context.dataDir`.
- Use atomic replacement for state files and append-only or bounded logs for history.
- Treat timers as best-effort application timers: ZCode must remain open.
- Register resume handlers when time-sensitive state must be recalculated after sleep.
- Define missed-run, overlap, cancellation, and retry behavior explicitly.

The Scheduler extension under [`plugins/scheduler`](../plugins/scheduler) is the full reference for persistent jobs, cron timezones, overlap policies, task handles, bounded history, and resume behavior.

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

## Development workflow

1. Build the extension.
2. Validate `.zdp\plugin.json` and its engine ranges.
3. Install the folder through **Extensions → Installed**.
4. Inspect **Health** for activation or protocol errors.
5. Rebuild the installed development copy and choose **Reload**, or uninstall and reinstall the source folder.
6. Disable and re-enable to verify cleanup and cold activation.
7. Close and reopen ZCode to verify persistence.
8. Test safe mode and incompatible host/ZCode ranges before publishing.

## Release checklist

- Bundle both entrypoints and verify their exact manifest paths.
- Increment the extension version.
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

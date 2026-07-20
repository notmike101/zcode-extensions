import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {app, dialog, ipcMain, powerMonitor, protocol, session, type WebContents} from "electron";
import {HOST_NAME, HOST_VERSION, getPaths, resolveZdpRoot} from "../shared/constants.ts";
import {writeJsonAtomic} from "../shared/atomic.ts";
import {JsonLogger} from "../shared/logger.ts";
import type {HostState} from "../shared/schemas.ts";
import {DesktopServicePortBroker} from "../protocol/desktop-service.ts";
import {TaskService} from "../protocol/task-service.ts";
import {PluginManager} from "./plugin-manager.ts";

protocol.registerSchemesAsPrivileged([{
  scheme: "zdp",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    bypassCSP: true,
    codeCache: true,
  },
}]);

const root = resolveZdpRoot();
const paths = getPaths(root);
const runtimeVersionDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const zcodeRoot = process.env.ZDP_ZCODE_ROOT ?? path.dirname(process.execPath);
const zcodeVersion = process.env.ZDP_ZCODE_VERSION ?? app.getVersion();
const logger = new JsonLogger(path.join(paths.logs, "host.jsonl"), "host");
const servicePortBroker = new DesktopServicePortBroker(logger.child("desktop-service"));
servicePortBroker.install();
const renderers = new Set<WebContents>();
let protocolStatus: HostState["health"]["protocol"] = "idle";
let protocolError: string | undefined;
let pluginManager: PluginManager;
let initialized: Promise<void>;
let shutdownStarted = false;
let shutdownComplete = false;

const taskService = new TaskService({
  vendorAsar: path.join(process.resourcesPath, "zcode.original.asar"),
  portBroker: servicePortBroker,
  logger,
  onHealth(status, error) {
    protocolStatus = status;
    protocolError = error;
    emit("host-state-changed");
  },
});

function emit(event: string, payload?: unknown): void {
  for (const contents of [...renderers]) {
    if (contents.isDestroyed()) renderers.delete(contents);
    else contents.send("zdp:event", {event, payload});
  }
}

pluginManager = new PluginManager({
  root,
  runtimeVersionDir,
  zcodeVersion,
  logger,
  taskService,
  emit,
  onResume(handler) {
    powerMonitor.on("resume", handler);
    powerMonitor.on("unlock-screen", handler);
    return {dispose: () => {
      powerMonitor.removeListener("resume", handler);
      powerMonitor.removeListener("unlock-screen", handler);
    }};
  },
});

initialized = (async () => {
  await writeJsonAtomic(paths.bootState, {
    phase: "host-loading",
    pid: process.pid,
    hostVersion: HOST_VERSION,
    zcodeVersion,
    timestamp: new Date().toISOString(),
  });
  await pluginManager.initialize();
  await writeJsonAtomic(paths.bootState, {
    phase: "host-ready",
    pid: process.pid,
    hostVersion: HOST_VERSION,
    zcodeVersion,
    timestamp: new Date().toISOString(),
  });
  await logger.info("Host initialized", {root, runtimeVersionDir, zcodeVersion});
})().catch(async (error) => {
  await logger.error("Host initialization failed", error);
  await writeJsonAtomic(paths.bootState, {
    phase: "host-error",
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
  }).catch(() => undefined);
  throw error;
});

ipcMain.handle("zdp:invoke", async (event, request: unknown) => {
  if (!renderers.has(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Unauthorized ZDP IPC sender");
  if (!request || typeof request !== "object" || !("method" in request)) throw new Error("Invalid ZDP request");
  const {method, payload} = request as {method: string; payload?: unknown};
  await initialized;
  switch (method) {
    case "host:getState": return hostState();
    case "host:getLogs": return logger.tail(200);
    case "host:choosePluginFolder": return chooseDirectory("Choose a ZCode Desktop Extension folder");
    case "host:chooseDirectory": return chooseDirectory("Choose a workspace folder");
    case "extension:checkUpdates": await pluginManager.checkUpdates(); return hostState();
    case "extension:queueUpdate": await pluginManager.queueUpdate(requireString(payload, "pluginId")); return hostState();
    case "extension:cancelUpdate": await pluginManager.cancelQueuedUpdate(requireString(payload, "pluginId")); return hostState();
    case "catalog:install": return pluginManager.installCatalog(requireString(payload, "pluginId"));
    case "plugin:install": return pluginManager.install(requireString(payload, "path"));
    case "plugin:setEnabled": {
      const value = requireRecord(payload);
      await pluginManager.setEnabled(requireString(value, "pluginId"), Boolean(value.enabled));
      return hostState();
    }
    case "plugin:reload": await pluginManager.reload(requireString(payload, "pluginId")); return hostState();
    case "plugin:uninstall": await pluginManager.uninstall(requireString(payload, "pluginId")); return hostState();
    case "plugin:invoke": {
      const value = requireRecord(payload);
      return pluginManager.invoke(requireString(value, "pluginId"), requireString(value, "method"), value.payload);
    }
    default: throw new Error(`Unknown ZDP method: ${method}`);
  }
});

app.once("ready", async () => {
  try {
    session.defaultSession.registerPreloadScript({
      type: "frame",
      filePath: path.join(runtimeVersionDir, "host", "preload.cjs"),
    });
    protocol.handle("zdp", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== "plugin") return new Response("Not found", {status: 404});
        const [pluginId, requestedFile] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (!pluginId || requestedFile !== "renderer.js") return new Response("Not found", {status: 404});
        const filePath = pluginManager.rendererPath(pluginId);
        return new Response(await readFile(filePath), {headers: {"Content-Type": "text/javascript; charset=utf-8"}});
      } catch (error) {
        void logger.warn("Extension protocol request failed", {url: request.url, error});
        return new Response("Extension renderer unavailable", {status: 404});
      }
    });
    startGuardian();
  } catch (error) {
    await logger.error("Electron integration setup failed", error);
  }
});

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "window") return;
  contents.once("did-finish-load", async () => {
    try {
      await initialized;
      renderers.add(contents);
      contents.once("destroyed", () => renderers.delete(contents));
      const rendererCode = await readFile(path.join(runtimeVersionDir, "renderer", "index.js"), "utf8");
      await contents.executeJavaScript(`${rendererCode}\n//# sourceURL=zdp-renderer.js`, true);
      await writeJsonAtomic(paths.bootState, {
        phase: "renderer-ready",
        pid: process.pid,
        hostVersion: HOST_VERSION,
        zcodeVersion,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      await logger.error("Renderer injection failed", error);
    }
  });
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    await Promise.race([
      (async () => {
        await pluginManager.deactivateAll();
        await taskService.shutdown();
      })(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    shutdownComplete = true;
    app.quit();
  })();
});

process.on("uncaughtException", (error) => void logger.error("Uncaught host exception", error));
process.on("unhandledRejection", (error) => void logger.error("Unhandled host rejection", error));

function hostState(): HostState {
  return {
    name: HOST_NAME,
    version: HOST_VERSION,
    zcodeVersion,
    root,
    dataDir: paths.data,
    plugins: pluginManager.list(),
    catalog: pluginManager.catalog(),
    health: {protocol: protocolStatus, ...(protocolError ? {protocolError} : {})},
  };
}

async function chooseDirectory(title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({title, properties: ["openDirectory"]});
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function startGuardian(): void {
  if (process.env.ZDP_DISABLE_GUARD === "1") return;
  const executable = path.join(paths.bin, "zdp.exe");
  const child = spawn(executable, ["guard", "--parent", String(process.pid), "--zcode", zcodeRoot], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {...process.env, ZDP_ROOT: root},
  });
  child.unref();
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object payload");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, key: string): string {
  const record = requireRecord(value);
  const result = record[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`Expected ${key}`);
  return result;
}

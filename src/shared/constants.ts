import path from "node:path";

export const HOST_NAME = "ZCode Desktop Extensions";
export const HOST_VERSION = "0.3.0";
export const API_VERSION = 1;
export const INSTALL_STATE_VERSION = 1;
export const DEFAULT_ZCODE_ROOT = path.join(
  process.env.LOCALAPPDATA ?? "C:\\Users\\me\\AppData\\Local",
  "Programs",
  "ZCode",
);

export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function resolveZdpRoot(): string {
  if (process.env.ZDP_ROOT) return path.resolve(process.env.ZDP_ROOT);
  const executable = path.basename(process.execPath).toLowerCase();
  if (executable === "zdp.exe" || executable === "zdp-launcher.exe") {
    return path.dirname(path.dirname(process.execPath));
  }
  return process.cwd();
}

export function getPaths(root = resolveZdpRoot()) {
  return {
    root,
    bin: path.join(root, "bin"),
    runtime: path.join(root, "runtime"),
    runtimeCurrent: path.join(root, "runtime", "current.json"),
    runtimeBootstrap: path.join(root, "runtime", "bootstrap.mjs"),
    data: path.join(root, "data"),
    logs: path.join(root, "data", "logs"),
    plugins: path.join(root, "data", "plugins"),
    pluginState: path.join(root, "data", "plugins-state.json"),
    staging: path.join(root, "data", ".staging"),
    trash: path.join(root, "data", ".trash"),
    backups: path.join(root, "data", "backups"),
    installState: path.join(root, "data", "install-state.json"),
    bootState: path.join(root, "data", "boot-state.json"),
  };
}

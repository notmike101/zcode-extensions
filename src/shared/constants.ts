import path from "node:path";
import os from "node:os";

export const HOST_NAME = "ZCode Desktop Extensions";
export const HOST_VERSION = "0.3.9";
export const HOST_UPDATE_URL = "https://github.com/notmike101/zcode-extensions/releases/latest/download/host-update.json";
export const API_VERSION = 1;
export const INSTALL_STATE_VERSION = 1;
export const ZDP_EXECUTABLE = process.platform === "win32" ? "zdp.exe" : "zdp";
export const ZDP_LAUNCHER_EXECUTABLE = process.platform === "win32" ? "zdp-launcher.exe" : "zdp-launcher";
export const DEFAULT_ZCODE_ROOT = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? "C:\\Users\\me\\AppData\\Local", "Programs", "ZCode")
  : path.join(os.homedir(), ".local", "opt", "ZCode");

export function getZCodeLayout(root: string) {
  const electronExecutable = path.join(root, process.platform === "win32" ? "ZCode.exe" : "zcode");
  return {
    root,
    resources: path.join(root, "resources"),
    electronExecutable,
    launchExecutable: electronExecutable,
    launchArgs: process.platform === "win32" ? [] : ["--no-sandbox"],
  };
}

export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function resolveZdpRoot(): string {
  if (process.env.ZDP_ROOT) return path.resolve(process.env.ZDP_ROOT);
  const executable = path.basename(process.execPath).toLowerCase();
  if (["zdp", "zdp.exe", "zdp-launcher", "zdp-launcher.exe"].includes(executable)) {
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
    hostUpdateState: path.join(root, "data", "host-update.json"),
    hostUpdateStaging: path.join(root, "data", ".host-update"),
    releaseManifest: path.join(root, "release-manifest.json"),
  };
}

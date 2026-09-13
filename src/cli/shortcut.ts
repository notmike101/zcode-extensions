import {spawn} from "node:child_process";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ShortcutState = {
  path: string;
  originalTarget: string;
  originalArguments: string;
  originalWorkingDirectory: string;
  originalIconLocation: string;
  originalContents?: string;
  created?: boolean;
};

export function defaultShortcutPath(): string {
  if (process.platform !== "win32") return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "applications", "zcode.desktop");
  return path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "ZCode.lnk");
}

export async function readShortcut(shortcutPath = defaultShortcutPath()): Promise<ShortcutState | undefined> {
  if (process.platform !== "win32") {
    const originalContents = await readFile(shortcutPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (originalContents === undefined) return undefined;
    const exec = /^Exec=(.*)$/m.exec(originalContents)?.[1]?.trim() ?? "";
    const parsed = parseDesktopExec(exec);
    return {
      path: shortcutPath,
      originalTarget: parsed.target,
      originalArguments: parsed.arguments,
      originalWorkingDirectory: /^Path=(.*)$/m.exec(originalContents)?.[1]?.trim() ?? "",
      originalIconLocation: /^Icon=(.*)$/m.exec(originalContents)?.[1]?.trim() ?? "",
      originalContents,
    };
  }
  const script = `
$ErrorActionPreference='Stop'
$shortcutPath=$env:ZDP_SHORTCUT_PATH
if(-not (Test-Path -LiteralPath $shortcutPath)){ exit 3 }
$ws=New-Object -ComObject WScript.Shell
$sc=$ws.CreateShortcut($shortcutPath)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
[pscustomobject]@{path=$shortcutPath;originalTarget=$sc.TargetPath;originalArguments=$sc.Arguments;originalWorkingDirectory=$sc.WorkingDirectory;originalIconLocation=$sc.IconLocation}|ConvertTo-Json -Compress
`;
  const result = await powershell(script, {ZDP_SHORTCUT_PATH: shortcutPath}, true);
  if (result.code === 3) return undefined;
  if (result.code !== 0) throw new Error(`Failed to read ZCode shortcut: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim()) as ShortcutState;
}

export async function writeLauncherShortcut(shortcutPath: string, launcher: string, workingDirectory: string, iconPath: string): Promise<void> {
  if (process.platform !== "win32") {
    const existing = await readFile(shortcutPath, "utf8").catch(() => "[Desktop Entry]\nName=ZCode\nType=Application\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/zcode;\n");
    const exec = `Exec=${quoteDesktopValue(launcher)} %U`;
    const tryExec = `TryExec=${launcher}`;
    let contents = /^Exec=.*$/m.test(existing) ? existing.replace(/^Exec=.*$/m, exec) : `${existing.trimEnd()}\n${exec}\n`;
    contents = /^TryExec=.*$/m.test(contents) ? contents.replace(/^TryExec=.*$/m, tryExec) : `${contents.trimEnd()}\n${tryExec}\n`;
    await mkdir(path.dirname(shortcutPath), {recursive: true});
    await writeFile(shortcutPath, contents, "utf8");
    return;
  }
  const script = `
$ErrorActionPreference='Stop'
$ws=New-Object -ComObject WScript.Shell
$sc=$ws.CreateShortcut($env:ZDP_SHORTCUT_PATH)
$sc.TargetPath=$env:ZDP_TARGET
$sc.Arguments=''
$sc.WorkingDirectory=$env:ZDP_WORKING_DIRECTORY
$sc.IconLocation=($env:ZDP_ICON + ',0')
$sc.Save()
`;
  const result = await powershell(script, {
    ZDP_SHORTCUT_PATH: shortcutPath,
    ZDP_TARGET: launcher,
    ZDP_WORKING_DIRECTORY: workingDirectory,
    ZDP_ICON: iconPath,
  });
  if (result.code !== 0) throw new Error(`Failed to create ZDP shortcut: ${result.stderr || result.stdout}`);
}

export async function captureShortcut(shortcutPath: string): Promise<ShortcutState> {
  const existing = await readShortcut(shortcutPath);
  return existing ? {...existing, created: false} : {
    path: shortcutPath,
    originalTarget: "",
    originalArguments: "",
    originalWorkingDirectory: "",
    originalIconLocation: "",
    created: true,
  };
}

export async function removeLauncherShortcut(state: ShortcutState | undefined, launcher: string, shortcutPath = defaultShortcutPath()): Promise<void> {
  if (state && !wasCreatedByLauncher(state, launcher)) {
    await restoreShortcut(state);
    return;
  }
  const pathValue = state?.path ?? shortcutPath;
  if (!state && !await isLauncherEntry(pathValue, launcher)) return;
  await removeLauncherEntry(pathValue);
}

function wasCreatedByLauncher(state: ShortcutState, launcher: string): boolean {
  if (state.created !== undefined) return state.created;
  if (state.originalContents !== undefined) return false;
  return path.resolve(state.originalTarget) === path.resolve(launcher);
}

async function isLauncherEntry(shortcutPath: string, launcher: string): Promise<boolean> {
  const existing = await readShortcut(shortcutPath).catch(() => undefined);
  return Boolean(existing && path.resolve(existing.originalTarget) === path.resolve(launcher));
}

async function removeLauncherEntry(shortcutPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await rm(shortcutPath, {force: true});
    return;
  }
  const script = `
$ErrorActionPreference='Stop'
$path=$env:ZDP_SHORTCUT_PATH
if(-not (Test-Path -LiteralPath $path)){ exit 0 }
Remove-Item -LiteralPath $path -Force
`;
  const result = await powershell(script, {ZDP_SHORTCUT_PATH: shortcutPath});
  if (result.code !== 0) throw new Error(`Failed to remove ZDP shortcut: ${result.stderr || result.stdout}`);
}

export async function restoreShortcut(state: ShortcutState): Promise<void> {
  if (process.platform !== "win32") {
    if (state.originalContents === undefined) throw new Error("The original desktop entry was not preserved");
    await mkdir(path.dirname(state.path), {recursive: true});
    await writeFile(state.path, state.originalContents, "utf8");
    return;
  }
  const script = `
$ErrorActionPreference='Stop'
$ws=New-Object -ComObject WScript.Shell
$sc=$ws.CreateShortcut($env:ZDP_SHORTCUT_PATH)
$sc.TargetPath=$env:ZDP_TARGET
$sc.Arguments=$env:ZDP_ARGUMENTS
$sc.WorkingDirectory=$env:ZDP_WORKING_DIRECTORY
$sc.IconLocation=$env:ZDP_ICON
$sc.Save()
`;
  const result = await powershell(script, {
    ZDP_SHORTCUT_PATH: state.path,
    ZDP_TARGET: state.originalTarget,
    ZDP_ARGUMENTS: state.originalArguments,
    ZDP_WORKING_DIRECTORY: state.originalWorkingDirectory,
    ZDP_ICON: state.originalIconLocation,
  });
  if (result.code !== 0) throw new Error(`Failed to restore ZCode shortcut: ${result.stderr || result.stdout}`);
}

function quoteDesktopValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function parseDesktopExec(value: string): {target: string; arguments: string} {
  if (!value) return {target: "", arguments: ""};
  const quoted = /^"((?:\\.|[^"])*)"\s*(.*)$/.exec(value);
  if (quoted) return {target: quoted[1]!.replace(/\\([\\"])/g, "$1"), arguments: quoted[2] ?? ""};
  const plain = /^(\S+)\s*(.*)$/.exec(value);
  return {target: plain?.[1] ?? "", arguments: plain?.[2] ?? ""};
}

async function powershell(script: string, env: Record<string, string>, allowNonzero = false): Promise<{code: number; stdout: string; stderr: string}> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: {...process.env, ...env}, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {stdout += chunk;});
    child.stderr.on("data", (chunk: string) => {stderr += chunk;});
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {code: code ?? 1, stdout, stderr};
      if (!allowNonzero && result.code !== 0) reject(new Error(stderr || stdout || `PowerShell exited ${result.code}`));
      else resolve(result);
    });
  });
}

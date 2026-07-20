import {spawn} from "node:child_process";
import path from "node:path";

export type ShortcutState = {
  path: string;
  originalTarget: string;
  originalArguments: string;
  originalWorkingDirectory: string;
  originalIconLocation: string;
};

export function defaultShortcutPath(): string {
  return path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "ZCode.lnk");
}

export async function readShortcut(shortcutPath = defaultShortcutPath()): Promise<ShortcutState | undefined> {
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

export async function restoreShortcut(state: ShortcutState): Promise<void> {
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

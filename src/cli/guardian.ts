import {readFile, stat} from "node:fs/promises";
import path from "node:path";
import {installOrRepair, isZCodeRunning} from "./installer.ts";
import {getPaths, resolveZdpRoot} from "../shared/constants.ts";

export async function guard(parentPid: number, zcodeRoot: string): Promise<void> {
  while (isProcessAlive(parentPid)) await delay(1_000);
  if (await hostUpdatePending()) return;
  const appAsar = path.join(zcodeRoot, "resources", "app.asar");
  let stableSamples = 0;
  let previousSize = -1;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (isZCodeRunning()) { await delay(1_000); continue; }
    const size = await stat(appAsar).then((value) => value.size).catch(() => -1);
    if (size === previousSize) stableSamples += 1;
    else stableSamples = 0;
    previousSize = size;
    if (stableSamples >= 2) break;
    await delay(1_000);
  }
  if (!isZCodeRunning()) await installOrRepair(zcodeRoot, {skipProcessCheck: true}).catch(() => undefined);
}

async function hostUpdatePending(): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(getPaths(resolveZdpRoot()).hostUpdateState, "utf8")) as {phase?: unknown};
    return value.phase === "ready" || value.phase === "applying";
  } catch { return false; }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

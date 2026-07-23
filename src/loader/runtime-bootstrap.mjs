import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(await readFile(path.join(runtimeDir, "current.json"), "utf8"));
const validVersion = (value) => typeof value === "string" && /^[0-9A-Za-z.-]+$/.test(value);
if (!validVersion(current.version)) throw new Error("Invalid ZDP runtime version pointer");
try {
  await load(current.version);
} catch (error) {
  if (!validVersion(current.previousVersion) || current.previousVersion === current.version) throw error;
  await writeFile(path.join(runtimeDir, "..", "data", "host-update.json"), `${JSON.stringify({
    schemaVersion: 1,
    phase: "failed",
    currentVersion: current.previousVersion,
    targetVersion: current.version,
    stagingRoot: runtimeDir,
    zcodeRoot: process.env.ZDP_ZCODE_ROOT ?? path.dirname(process.execPath),
    releaseUrl: "https://github.com/notmike101/zcode-extensions/releases",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`, "utf8").catch(() => undefined);
  await load(current.previousVersion);
}

async function load(version) {
  const bootstrap = path.join(runtimeDir, "versions", version, "host", "bootstrap.mjs");
  await import(pathToFileURL(bootstrap).href);
}

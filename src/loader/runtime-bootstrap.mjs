import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(await readFile(path.join(runtimeDir, "current.json"), "utf8"));
if (!current.version || !/^[0-9A-Za-z.-]+$/.test(current.version)) throw new Error("Invalid ZDP runtime version pointer");
const bootstrap = path.join(runtimeDir, "versions", current.version, "host", "bootstrap.mjs");
await import(pathToFileURL(bootstrap).href);

import {access, readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {pathToFileURL} from "node:url";

const root = path.resolve(import.meta.dir, "..");
const sdk = path.join(root, "sdk");
const packageJson = JSON.parse(await readFile(path.join(sdk, "package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, unknown>;
};

if (packageJson.name !== "@notmike101/zcode-extension-sdk" || packageJson.version !== "0.3.2") {
  throw new Error("Unexpected SDK package identity");
}
for (const entry of [".", "./main", "./renderer", "./experimental", "./manifest.schema.json"]) {
  if (!(entry in packageJson.exports)) throw new Error(`Missing SDK export ${entry}`);
}
for (const file of [
  "dist/esm/index.js", "dist/esm/main.js", "dist/esm/renderer.js", "dist/esm/experimental.js",
  "dist/cjs/index.cjs", "dist/cjs/main.cjs", "dist/cjs/renderer.cjs", "dist/cjs/experimental.cjs",
  "dist/types/index.d.ts", "dist/types/main.d.ts", "dist/types/renderer.d.ts", "dist/types/experimental.d.ts",
]) await access(path.join(sdk, file));

const esm = await import(pathToFileURL(path.join(sdk, "dist", "esm", "index.js")).href);
if (typeof esm.validateExtensionManifest !== "function" || typeof esm.defineRendererExtension !== "function") {
  throw new Error("ESM SDK exports are incomplete");
}
const esmMain = await import(pathToFileURL(path.join(sdk, "dist", "esm", "main.js")).href);
const esmRenderer = await import(pathToFileURL(path.join(sdk, "dist", "esm", "renderer.js")).href);
await import(pathToFileURL(path.join(sdk, "dist", "esm", "experimental.js")).href);
if (typeof esmMain.defineMainExtension !== "function"
  || esmMain.ZCODE_EXTENSION_API_VERSION !== esm.ZCODE_EXTENSION_API_VERSION
  || typeof esmRenderer.defineRendererExtension !== "function"
  || !Array.isArray(esmRenderer.UI_CONTRIBUTION_SLOTS)
  || JSON.stringify(esmRenderer.UI_CONTRIBUTION_SLOTS) !== JSON.stringify(esm.UI_CONTRIBUTION_SLOTS)) {
  throw new Error("ESM SDK subpath exports are incomplete");
}
const require = createRequire(import.meta.url);
const cjs = require(path.join(sdk, "dist", "cjs", "index.cjs")) as Record<string, unknown>;
if (typeof cjs.assertExtensionManifest !== "function" || typeof cjs.defineMainExtension !== "function") {
  throw new Error("CommonJS SDK exports are incomplete");
}
const cjsMain = require(path.join(sdk, "dist", "cjs", "main.cjs")) as Record<string, unknown>;
const cjsRenderer = require(path.join(sdk, "dist", "cjs", "renderer.cjs")) as Record<string, unknown>;
require(path.join(sdk, "dist", "cjs", "experimental.cjs"));
if (typeof cjsMain.defineMainExtension !== "function"
  || cjsMain.ZCODE_EXTENSION_API_VERSION !== cjs.ZCODE_EXTENSION_API_VERSION
  || typeof cjsRenderer.defineRendererExtension !== "function"
  || !Array.isArray(cjsRenderer.UI_CONTRIBUTION_SLOTS)
  || JSON.stringify(cjsRenderer.UI_CONTRIBUTION_SLOTS) !== JSON.stringify(cjs.UI_CONTRIBUTION_SLOTS)) {
  throw new Error("CommonJS SDK subpath exports are incomplete");
}

await runNode([
  "--input-type=module",
  "-e",
  `const root = await import(${JSON.stringify(pathToFileURL(path.join(sdk, "dist", "esm", "index.js")).href)});
const main = await import(${JSON.stringify(pathToFileURL(path.join(sdk, "dist", "esm", "main.js")).href)});
const renderer = await import(${JSON.stringify(pathToFileURL(path.join(sdk, "dist", "esm", "renderer.js")).href)});
await import(${JSON.stringify(pathToFileURL(path.join(sdk, "dist", "esm", "experimental.js")).href)});
if (root.ZCODE_EXTENSION_API_VERSION !== 1 || main.ZCODE_EXTENSION_API_VERSION !== 1
  || typeof main.defineMainExtension !== "function" || typeof renderer.defineRendererExtension !== "function") {
  throw new Error("Node ESM SDK subpath exports are incomplete");
}`,
], "Node ESM SDK check");
await runNode([
  "-e",
  `const root = require(${JSON.stringify(path.join(sdk, "dist", "cjs", "index.cjs"))});
const main = require(${JSON.stringify(path.join(sdk, "dist", "cjs", "main.cjs"))});
const renderer = require(${JSON.stringify(path.join(sdk, "dist", "cjs", "renderer.cjs"))});
require(${JSON.stringify(path.join(sdk, "dist", "cjs", "experimental.cjs"))});
if (root.ZCODE_EXTENSION_API_VERSION !== 1 || main.ZCODE_EXTENSION_API_VERSION !== 1
  || typeof main.defineMainExtension !== "function" || typeof renderer.defineRendererExtension !== "function") {
  throw new Error("Node CommonJS SDK subpath exports are incomplete");
}`,
], "Node CommonJS SDK check");

const typecheck = Bun.spawn([
  process.execPath,
  "x",
  "tsc",
  "-p",
  path.join(root, "tests", "fixtures", "sdk-consumer", "tsconfig.json"),
], {cwd: root, stdout: "inherit", stderr: "inherit"});
if (await typecheck.exited !== 0) throw new Error("SDK consumer typecheck failed");

console.log("Verified SDK ESM, CommonJS, declaration, subpath, and consumer exports");

async function runNode(args: string[], label: string): Promise<void> {
  const child = Bun.spawn(["node", ...args], {cwd: root, stdout: "inherit", stderr: "inherit"});
  if (await child.exited !== 0) throw new Error(`${label} failed`);
}

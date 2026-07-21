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

if (packageJson.name !== "@notmike101/zcode-extension-sdk" || packageJson.version !== "0.3.0") {
  throw new Error("Unexpected SDK package identity");
}
for (const entry of [".", "./main", "./renderer", "./experimental", "./manifest.schema.json"]) {
  if (!(entry in packageJson.exports)) throw new Error(`Missing SDK export ${entry}`);
}
for (const file of [
  "dist/esm/index.js", "dist/esm/renderer.js", "dist/cjs/index.cjs", "dist/cjs/main.cjs",
  "dist/types/index.d.ts", "dist/types/main.d.ts", "dist/types/renderer.d.ts", "dist/types/experimental.d.ts",
]) await access(path.join(sdk, file));

const esm = await import(pathToFileURL(path.join(sdk, "dist", "esm", "index.js")).href);
if (typeof esm.validateExtensionManifest !== "function" || typeof esm.defineRendererExtension !== "function") {
  throw new Error("ESM SDK exports are incomplete");
}
const require = createRequire(import.meta.url);
const cjs = require(path.join(sdk, "dist", "cjs", "index.cjs")) as Record<string, unknown>;
if (typeof cjs.assertExtensionManifest !== "function" || typeof cjs.defineMainExtension !== "function") {
  throw new Error("CommonJS SDK exports are incomplete");
}

const typecheck = Bun.spawn([
  process.execPath,
  "x",
  "tsc",
  "-p",
  path.join(root, "tests", "fixtures", "sdk-consumer", "tsconfig.json"),
], {cwd: root, stdout: "inherit", stderr: "inherit"});
if (await typecheck.exited !== 0) throw new Error("SDK consumer typecheck failed");

console.log("Verified SDK ESM, CommonJS, declaration, subpath, and consumer exports");

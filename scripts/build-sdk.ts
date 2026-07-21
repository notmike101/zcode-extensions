import {mkdir, rm} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const sdk = path.join(root, "sdk");
const dist = path.join(sdk, "dist");
const entrypoints = ["index.ts", "main.ts", "renderer.ts", "experimental.ts"].map((file) => path.join(sdk, file));

await rm(dist, {recursive: true, force: true});
await Promise.all([mkdir(path.join(dist, "esm"), {recursive: true}), mkdir(path.join(dist, "cjs"), {recursive: true})]);

await bundle("esm", path.join(dist, "esm"), "[name].js");
await bundle("cjs", path.join(dist, "cjs"), "[name].cjs");

const declarations = Bun.spawn([
  process.execPath,
  "x",
  "tsc",
  "-p",
  path.join(sdk, "tsconfig.build.json"),
], {cwd: root, stdout: "inherit", stderr: "inherit"});
if (await declarations.exited !== 0) throw new Error("SDK declaration build failed");

console.log(`Built public SDK to ${dist}`);

async function bundle(format: "esm" | "cjs", outdir: string, naming: string): Promise<void> {
  const result = await Bun.build({entrypoints, outdir, format, target: "browser", naming, sourcemap: "external", minify: false});
  if (!result.success) throw new AggregateError(result.logs, `SDK ${format} build failed`);
}

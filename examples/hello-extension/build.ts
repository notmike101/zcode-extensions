import {mkdir, rm} from "node:fs/promises";
import path from "node:path";

const root = import.meta.dir;
const dist = path.join(root, "dist");

await rm(dist, {recursive: true, force: true});
await mkdir(dist, {recursive: true});

await bundle({
  entrypoints: [path.join(root, "src", "main.ts")],
  outdir: dist,
  target: "node",
  format: "cjs",
  naming: "main.cjs",
});

await bundle({
  entrypoints: [path.join(root, "src", "renderer.ts")],
  outdir: dist,
  target: "browser",
  format: "iife",
  naming: "renderer.js",
});

console.log(`Built Hello Extension to ${dist}`);

async function bundle(options: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build({...options, minify: false, sourcemap: "external"});
  if (!result.success) throw new AggregateError(result.logs, "Hello Extension build failed");
}

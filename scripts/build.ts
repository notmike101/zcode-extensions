import {cp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {HOST_VERSION} from "../src/shared/constants.ts";

const root = path.resolve(import.meta.dir, "..");
const runtime = path.join(root, "runtime");
const versionDir = path.join(runtime, "versions", HOST_VERSION);
const bin = path.join(root, "bin");

await Promise.all([
  rm(path.join(root, "dist"), {recursive: true, force: true}),
  rm(versionDir, {recursive: true, force: true}),
  rm(bin, {recursive: true, force: true}),
]);
await Promise.all([
  mkdir(path.join(versionDir, "host"), {recursive: true}),
  mkdir(path.join(versionDir, "renderer"), {recursive: true}),
  mkdir(path.join(versionDir, "builtin-plugins", "scheduler", "dist"), {recursive: true}),
  mkdir(path.join(versionDir, "builtin-plugins", "scheduler", ".zdp"), {recursive: true}),
  mkdir(bin, {recursive: true}),
]);

await build({
  entrypoints: [path.join(root, "src", "host", "bootstrap.ts")],
  outdir: path.join(versionDir, "host"),
  target: "node",
  format: "esm",
  naming: "[name].mjs",
  external: ["electron"],
});
await build({
  entrypoints: [path.join(root, "src", "host", "preload.ts")],
  outdir: path.join(versionDir, "host"),
  target: "node",
  format: "cjs",
  naming: "[name].cjs",
  external: ["electron"],
});
await build({
  entrypoints: [path.join(root, "src", "renderer", "index.tsx")],
  outdir: path.join(versionDir, "renderer"),
  target: "browser",
  format: "iife",
  naming: "[name].js",
  loader: {".css": "text"},
});
await build({
  entrypoints: [path.join(root, "plugins", "scheduler", "src", "main.ts")],
  outdir: path.join(versionDir, "builtin-plugins", "scheduler", "dist"),
  target: "node",
  format: "cjs",
  naming: "[name].cjs",
  external: ["electron"],
});
await build({
  entrypoints: [path.join(root, "plugins", "scheduler", "src", "renderer.tsx")],
  outdir: path.join(versionDir, "builtin-plugins", "scheduler", "dist"),
  target: "browser",
  format: "iife",
  naming: "[name].js",
  loader: {".css": "text"},
});

await cp(path.join(root, "plugins", "scheduler", ".zdp", "plugin.json"), path.join(versionDir, "builtin-plugins", "scheduler", ".zdp", "plugin.json"));
await mkdir(runtime, {recursive: true});
await cp(path.join(root, "src", "loader", "runtime-bootstrap.mjs"), path.join(runtime, "bootstrap.mjs"));
await writeFile(path.join(runtime, "current.json"), `${JSON.stringify({version: HOST_VERSION}, null, 2)}\n`, "utf8");

await runBunBuild([
  "build", path.join(root, "src", "cli", "index.ts"), "--compile", "--minify", "--sourcemap", "--outfile", path.join(bin, "zdp.exe"),
]);
await runBunBuild([
  "build", path.join(root, "src", "cli", "launcher.ts"), "--compile", "--minify", "--windows-hide-console", "--outfile", path.join(bin, "zdp-launcher.exe"),
]);

console.log(`Built ${HOST_VERSION} to ${versionDir}`);

async function build(options: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build({
    sourcemap: "external",
    minify: false,
    ...options,
  });
  if (!result.success) throw new AggregateError(result.logs, "Bun build failed");
}

async function runBunBuild(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {cwd: root, stdout: "inherit", stderr: "inherit"});
  const code = await child.exited;
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited ${code}`);
}

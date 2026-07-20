import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {HOST_VERSION} from "../src/shared/constants.ts";
import {pluginManifestSchema} from "../src/shared/schemas.ts";
import {assertReleaseVersion, releaseBaseName, resolveReleaseTag} from "./release-helpers.ts";

const root = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {version?: unknown};
if (typeof packageJson.version !== "string") throw new Error("package.json has no version");
const tag = resolveReleaseTag(
  valueAfter("--tag"),
  process.env.GITHUB_REF_TYPE,
  process.env.GITHUB_REF_NAME,
  packageJson.version,
);
const version = assertReleaseVersion(tag, packageJson.version, HOST_VERSION);

if (args.includes("--verify-only")) {
  console.log(`Release metadata is consistent for ${tag}.`);
  process.exit(0);
}

if (process.platform !== "win32") throw new Error("Release packaging currently requires Windows");

const current = JSON.parse(await readFile(path.join(root, "runtime", "current.json"), "utf8")) as {version?: unknown};
if (current.version !== version) throw new Error(`runtime/current.json points to ${String(current.version)} instead of ${version}`);

const exampleRoot = path.join(root, "examples", "hello-extension");
const exampleManifest = pluginManifestSchema.parse(
  JSON.parse(await readFile(path.join(exampleRoot, ".zdp", "plugin.json"), "utf8")),
);
for (const entrypoint of [exampleManifest.entrypoints.main, exampleManifest.entrypoints.renderer]) {
  if (entrypoint) await requireFile(path.join(exampleRoot, entrypoint));
}

const baseName = releaseBaseName(version);
const outputRoot = path.resolve(valueAfter("--output") ?? path.join(root, "dist", "release"));
const stage = path.join(outputRoot, "zcode-extensions");
const archive = path.join(outputRoot, `${baseName}.zip`);
const checksum = `${archive}.sha256`;

await rm(outputRoot, {recursive: true, force: true});
await mkdir(stage, {recursive: true});

await Promise.all([
  copyRequired(path.join(root, "bin", "zdp.exe"), path.join(stage, "bin", "zdp.exe")),
  copyRequired(path.join(root, "bin", "zdp-launcher.exe"), path.join(stage, "bin", "zdp-launcher.exe")),
  copyRequired(path.join(root, "runtime", "bootstrap.mjs"), path.join(stage, "runtime", "bootstrap.mjs")),
  copyRequired(path.join(root, "runtime", "current.json"), path.join(stage, "runtime", "current.json")),
  copyRequired(path.join(root, "README.md"), path.join(stage, "README.md")),
  copyRequired(path.join(root, "LICENSE"), path.join(stage, "LICENSE")),
]);

await copyTree(
  path.join(root, "runtime", "versions", version),
  path.join(stage, "runtime", "versions", version),
  (filePath) => !filePath.endsWith(".map"),
);
await copyTree(path.join(root, "docs"), path.join(stage, "docs"));
await copyTree(path.join(root, "sdk"), path.join(stage, "sdk"));
await copyTree(
  path.join(root, "examples", "hello-extension"),
  path.join(stage, "examples", "hello-extension"),
  (filePath) => !filePath.endsWith(".map") && !filePath.includes(`${path.sep}node_modules${path.sep}`),
);

await compress(stage, archive);
const digest = await sha256(archive);
await writeFile(checksum, `${digest} *${path.basename(archive)}\n`, "utf8");

console.log(JSON.stringify({tag, version, stage, archive, checksum, sha256: digest}, null, 2));

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function copyRequired(source: string, destination: string): Promise<void> {
  await requireFile(source);
  await mkdir(path.dirname(destination), {recursive: true});
  await copyFile(source, destination);
}

async function requireFile(filePath: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Required release file is missing: ${filePath}`);
}

async function copyTree(
  source: string,
  destination: string,
  include: (filePath: string) => boolean = () => true,
): Promise<void> {
  const info = await stat(source).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Required release directory is missing: ${source}`);
  await mkdir(destination, {recursive: true});
  for (const entry of await readdir(source, {withFileTypes: true})) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath, include);
    else if (entry.isFile() && include(sourcePath)) await copyRequired(sourcePath, destinationPath);
  }
}

async function compress(source: string, destination: string): Promise<void> {
  const command = `Compress-Archive -LiteralPath ${quotePowerShell(source)} -DestinationPath ${quotePowerShell(destination)} -CompressionLevel Optimal -Force`;
  const child = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Compress-Archive exited ${code}`);
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

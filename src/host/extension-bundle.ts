import {lstat, readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";
import {pluginManifestSchema, type PluginManifest} from "../shared/schemas.ts";

export async function readExtensionManifest(root: string): Promise<PluginManifest> {
  const manifestPath = path.join(root, ".zdp", "plugin.json");
  const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  for (const entrypoint of [manifest.entrypoints.main, manifest.entrypoints.renderer]) {
    if (!entrypoint) continue;
    const target = containedExtensionPath(root, entrypoint);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Extension entrypoint is not a file: ${entrypoint}`);
  }
  return manifest;
}

export function containedExtensionPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (target !== resolvedRoot) throw new Error(`Path escapes extension root: ${relativePath}`);
  }
  return target;
}

export async function rejectExtensionLinks(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Extension bundles cannot contain links: ${path.relative(root, target)}`);
      if (entry.isDirectory()) await walk(target);
    }
  };
  await walk(root);
}

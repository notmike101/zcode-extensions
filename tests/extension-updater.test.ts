import {createHash} from "node:crypto";
import {afterEach, describe, expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {ExtensionUpdater, validateArchiveEntryPath} from "../src/host/extension-updater.ts";
import {readExtensionManifest} from "../src/host/extension-bundle.ts";
import {JsonLogger} from "../src/shared/logger.ts";
import type {PluginManifest} from "../src/shared/schemas.ts";

const roots: string[] = [];
const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe("extension updater", () => {
  test("verifies, queues, and applies an extension update on the next launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zdp-updater-"));
    roots.push(root);
    const installedRoot = path.join(root, "data", "plugins", "scheduler");
    const privateData = path.join(root, "data", "plugin-data", "scheduler");
    await writeBundle(installedRoot, "0.1.2", "old");
    await mkdir(privateData, {recursive: true});
    await writeFile(path.join(privateData, "keep.txt"), "preserved", "utf8");

    const archive = path.join(root, "scheduler.zip");
    const archiveStage = path.join(root, "archive-stage", "scheduler");
    await writeBundle(archiveStage, "0.1.3", "new");
    await compress(archiveStage, archive);
    const bytes = Buffer.from(await Bun.file(archive).arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");

    let server!: Bun.Server<unknown>;
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/scheduler.zip") return new Response(bytes, {headers: {"content-type": "application/zip"}});
        if (url.pathname === "/feed.json") return Response.json({
          schemaVersion: 1,
          id: "scheduler",
          apiVersion: 1,
          version: "0.1.3",
          engines: {host: ">=0.2.0 <1", zcode: ">=3.3.6"},
          archive: {url: `${server.url}scheduler.zip`, sha256: digest, size: bytes.byteLength},
          releaseUrl: `${server.url}release`,
          publishedAt: "2026-07-19T12:00:00.000Z",
        });
        return new Response("not found", {status: 404});
      },
    });
    servers.push(server);

    let installedManifest = await readExtensionManifest(installedRoot);
    const catalog = [{
      id: "scheduler",
      name: "Scheduler",
      description: "Schedules tasks",
      repositoryUrl: `${server.url}`,
      manifestUrl: `${server.url}feed.json`,
    }];
    const updater = createUpdater(root, catalog, () => [{root: installedRoot, manifest: installedManifest}]);
    expect((await updater.initialize()).size).toBe(0);
    await updater.checkForUpdates();
    expect(updater.status(installedManifest)).toMatchObject({state: "available", currentVersion: "0.1.2", latestVersion: "0.1.3"});
    await updater.queueUpdate("scheduler");
    expect(updater.status(installedManifest)).toMatchObject({state: "queued", queuedVersion: "0.1.3"});
    updater.dispose();

    const restarted = createUpdater(root, catalog, () => [{root: installedRoot, manifest: installedManifest}]);
    const applied = await restarted.initialize();
    expect(applied.get("scheduler")).toMatchObject({pluginId: "scheduler", version: "0.1.3", destination: installedRoot});
    installedManifest = await readExtensionManifest(installedRoot);
    expect(installedManifest.version).toBe("0.1.3");
    expect(await readFile(path.join(installedRoot, "dist", "main.cjs"), "utf8")).toContain("new");
    expect(await readFile(path.join(privateData, "keep.txt"), "utf8")).toBe("preserved");
    await restarted.commitApplied("scheduler");
    const state = JSON.parse(await readFile(path.join(root, "data", "extension-updates.json"), "utf8")) as {pending: object};
    expect(state.pending).toEqual({});
    const trash = await readdir(path.join(root, "data", ".trash"));
    expect(trash.some((name) => name.startsWith("scheduler-"))).toBe(true);
    restarted.dispose();
  });

  test("rejects archive paths that can escape or alias the extraction root", () => {
    for (const value of [
      "../escape",
      "folder/../escape",
      "C:/escape",
      "/escape",
      "folder\\escape",
      "folder//escape",
      "./escape",
      "\0bad",
      "scheduler/file:stream",
      "scheduler/CON.txt",
      "scheduler/trailing.",
      "scheduler/trailing ",
    ]) {
      expect(() => validateArchiveEntryPath(value)).toThrow("Unsafe extension archive path");
    }
    expect(validateArchiveEntryPath("scheduler/.zdp/plugin.json")).toBe("scheduler/.zdp/plugin.json");
    expect(validateArchiveEntryPath("scheduler/dist/")).toBe("scheduler/dist");
  });

  test("rejects insecure redirects before following them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zdp-updater-redirect-"));
    roots.push(root);
    let server!: Bun.Server<unknown>;
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {status: 302, headers: {location: "http://example.com/feed.json"}});
      },
    });
    servers.push(server);
    const manifest = manifestFor("0.1.2");
    const updater = createUpdater(root, [{
      id: "scheduler",
      name: "Scheduler",
      description: "Schedules tasks",
      repositoryUrl: `${server.url}`,
      manifestUrl: `${server.url}redirect`,
    }], () => [{root, manifest}]);
    await updater.initialize();
    await updater.checkForUpdates();
    expect(updater.status(manifest)).toMatchObject({state: "error", error: expect.stringContaining("require HTTPS")});
    updater.dispose();
  });

  test("bounds streamed update feeds without a content length", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zdp-updater-feed-limit-"));
    roots.push(root);
    const oversized = new Uint8Array(257 * 1024).fill(0x20);
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }), {headers: {"content-type": "application/json"}});
      },
    });
    servers.push(server);
    const manifest = manifestFor("0.1.2");
    const updater = createUpdater(root, [{
      id: "scheduler",
      name: "Scheduler",
      description: "Schedules tasks",
      repositoryUrl: `${server.url}`,
      manifestUrl: `${server.url}feed.json`,
    }], () => [{root, manifest}]);
    await updater.initialize();
    await updater.checkForUpdates();
    expect(updater.status(manifest)).toMatchObject({state: "error", error: "Update feed is too large"});
    updater.dispose();
  });

  test("ignores persisted update transactions outside managed directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zdp-updater-state-"));
    roots.push(root);
    const sentinel = path.join(root, "do-not-touch.txt");
    await mkdir(path.join(root, "data"), {recursive: true});
    await writeFile(sentinel, "preserved", "utf8");
    await writeFile(path.join(root, "data", "extension-updates.json"), JSON.stringify({
      schemaVersion: 1,
      pending: {
        scheduler: {
          pluginId: "scheduler",
          version: "0.1.3",
          stagingRoot: root,
          stagingContainer: root,
          queuedAt: "2026-07-20T00:00:00.000Z",
          phase: "queued",
        },
      },
    }), "utf8");
    const updater = createUpdater(root, [], () => []);
    expect((await updater.initialize()).size).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("preserved");
    updater.dispose();
  });

  test("reports invalid installed versions instead of throwing from status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zdp-updater-version-"));
    roots.push(root);
    const manifest = manifestFor("development");
    const updater = createUpdater(root, [], () => [{root, manifest}]);
    await updater.initialize();
    expect(updater.status(manifest)).toMatchObject({state: "unknown", currentVersion: "development"});
    updater.dispose();
  });
});

function createUpdater(
  root: string,
  catalog: Array<{id: string; name: string; description: string; repositoryUrl: string; manifestUrl: string}>,
  getInstalled: () => Array<{root: string; manifest: PluginManifest}>,
) {
  return new ExtensionUpdater({
    root,
    zcodeVersion: "3.3.6",
    logger: new JsonLogger(path.join(root, "updater.log"), "test"),
    getInstalled,
    onStateChanged() {},
    catalog,
    allowHttpLocalhost: true,
  });
}

async function writeBundle(root: string, version: string, marker: string): Promise<void> {
  await mkdir(path.join(root, ".zdp"), {recursive: true});
  await mkdir(path.join(root, "dist"), {recursive: true});
  await writeFile(path.join(root, ".zdp", "plugin.json"), `${JSON.stringify(manifestFor(version), null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "dist", "main.cjs"), `exports.marker = ${JSON.stringify(marker)}; exports.activate = async () => ({dispose() {}});\n`, "utf8");
}

function manifestFor(version: string): PluginManifest {
  return {
    apiVersion: 1,
    id: "scheduler",
    name: "Scheduler",
    version,
    entrypoints: {main: "dist/main.cjs"},
    engines: {host: ">=0.2.0 <1", zcode: ">=3.3.6"},
    pages: [],
  };
}

async function compress(source: string, destination: string): Promise<void> {
  const command = `Compress-Archive -LiteralPath ${quote(source)} -DestinationPath ${quote(destination)} -CompressionLevel Optimal -Force`;
  const child = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error("Could not create updater test archive");
  expect((await stat(destination)).isFile()).toBe(true);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

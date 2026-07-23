import {createHash} from "node:crypto";
import {afterEach, describe, expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HostUpdater, type ReleaseManifest} from "../src/host/host-updater.ts";
import {JsonLogger} from "../src/shared/logger.ts";

const roots: string[] = [];
const servers: Bun.Server<unknown>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe("host updater", () => {
  test("notifies source checkouts without allowing an in-place update", async () => {
    const root = await tempRoot("zdp-host-dev-");
    const server = serveRelease(Buffer.from("unused"), "0".repeat(64), "9.9.9", 6);
    const updater = createUpdater(root, `${server.url}host-update.json`);
    await updater.initialize();
    await updater.check();
    expect(updater.status()).toMatchObject({state: "available", latestVersion: "9.9.9", installable: false});
    await expect(updater.prepareAndRestart(123)).rejects.toThrow("packaged installs");
    updater.dispose();
  });

  test("verifies and stages a packaged update before launching the detached helper", async () => {
    const root = await tempRoot("zdp-host-package-");
    await mkdir(path.join(root, "bin"), {recursive: true});
    await mkdir(path.join(root, "data"), {recursive: true});
    await writeFile(path.join(root, "bin", "zdp.exe"), "old helper");
    await writeFile(path.join(root, "data", "keep.txt"), "preserved");
    await writeManifest(root, "0.3.6", [{path: "bin/zdp.exe", bytes: Buffer.from("old helper")}]);

    const archiveStage = path.join(root, "archive-stage", "zcode-extensions");
    const incoming = Buffer.from("new helper");
    await mkdir(path.join(archiveStage, "bin"), {recursive: true});
    await writeFile(path.join(archiveStage, "bin", "zdp.exe"), incoming);
    await writeManifest(archiveStage, "0.3.7", [{path: "bin/zdp.exe", bytes: incoming}]);
    const archive = path.join(root, "host.zip");
    await compress(archiveStage, archive);
    const bytes = Buffer.from(await Bun.file(archive).arrayBuffer());
    const digest = hash(bytes);
    const server = serveRelease(bytes, digest, "0.3.7", bytes.length);
    let launched: {executable: string; args: string[]} | undefined;
    const updater = createUpdater(root, `${server.url}host-update.json`, (executable, args) => { launched = {executable, args}; });
    await updater.initialize();
    await updater.check();
    expect(updater.status()).toMatchObject({state: "available", installable: true});
    await updater.prepareAndRestart(4242);
    expect(updater.status().state).toBe("applying");
    expect(launched?.args).toContain("apply-update");
    expect(launched?.args).toContain("4242");
    expect((await stat(launched!.executable)).isFile()).toBe(true);
    const transaction = JSON.parse(await readFile(path.join(root, "data", "host-update.json"), "utf8")) as {phase: string; targetVersion: string};
    expect(transaction).toMatchObject({phase: "ready", targetVersion: "0.3.7"});
    expect(await readFile(path.join(root, "data", "keep.txt"), "utf8")).toBe("preserved");
    updater.dispose();
  });

  test("reports a newer release as incompatible with the installed ZCode", async () => {
    const root = await tempRoot("zdp-host-incompatible-");
    const server = serveRelease(Buffer.from("unused"), "0".repeat(64), "9.9.9", 6, ">=99");
    const updater = createUpdater(root, `${server.url}host-update.json`);
    await updater.initialize();
    await updater.check();
    expect(updater.status()).toMatchObject({state: "incompatible", latestVersion: "9.9.9", error: "Requires ZCode >=99"});
    updater.dispose();
  });
});

function createUpdater(root: string, feedUrl: string, launchHelper?: (executable: string, args: string[]) => void): HostUpdater {
  return new HostUpdater({
    root, zcodeRoot: path.join(root, "ZCode"), zcodeVersion: "3.4.2", feedUrl,
    logger: new JsonLogger(path.join(root, "host-update-test.log"), "test"),
    onStateChanged() {}, allowHttpLocalhost: true, launchHelper,
  });
}

function serveRelease(bytes: Buffer, digest: string, version: string, size: number, zcode = ">=3.3.6"): Bun.Server<unknown> {
  let server!: Bun.Server<unknown>;
  server = Bun.serve({port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/host.zip") return new Response(new Uint8Array(bytes));
    if (url.pathname === "/host-update.json") return Response.json({
      schemaVersion: 1, version, engines: {zcode},
      archive: {url: `${server.url}host.zip`, sha256: digest, size},
      releaseUrl: `${server.url}release`, publishedAt: "2026-07-22T12:00:00.000Z",
    });
    return new Response("not found", {status: 404});
  }});
  servers.push(server);
  return server;
}

async function writeManifest(root: string, version: string, files: Array<{path: string; bytes: Buffer}>): Promise<void> {
  const manifest: ReleaseManifest = {schemaVersion: 1, version, files: files.map((file) => ({path: file.path, sha256: hash(file.bytes), size: file.bytes.length}))};
  await writeFile(path.join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function tempRoot(prefix: string): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root; }
function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function compress(source: string, destination: string): Promise<void> {
  const command = `Compress-Archive -LiteralPath '${source.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`;
  const child = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {stdout: "ignore", stderr: "inherit"});
  if (await child.exited !== 0) throw new Error("Could not create host updater test archive");
}

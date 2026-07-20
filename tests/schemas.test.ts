import {describe, expect, test} from "bun:test";
import {
  extensionReleaseManifestSchema,
  extensionUpdateSourceSchema,
  pluginManifestSchema,
  taskSpecSchema,
} from "../src/shared/schemas.ts";

describe("public schemas", () => {
  test("accepts a desktop extension manifest", () => {
    expect(pluginManifestSchema.parse({
      apiVersion: 1,
      id: "example.plugin",
      name: "Example",
      version: "1.0.0",
      entrypoints: {main: "dist/main.cjs"},
    }).engines.host).toBe(">=0.1.0");
  });

  test("rejects entrypoint traversal and empty extensions", () => {
    expect(() => pluginManifestSchema.parse({apiVersion: 1, id: "bad", name: "Bad", version: "1", entrypoints: {main: "../main.js"}})).toThrow();
    expect(() => pluginManifestSchema.parse({apiVersion: 1, id: "bad", name: "Bad", version: "1", entrypoints: {}})).toThrow();
  });

  test("task spec defaults to plan mode and accepts a native sidebar title", () => {
    expect(taskSpecSchema.parse({workspacePath: "D:\\project", prompt: "Review it", title: "⏰ Morning review"}))
      .toMatchObject({mode: "plan", title: "⏰ Morning review"});
  });

  test("accepts a checksum-verified extension release feed contract", () => {
    expect(extensionUpdateSourceSchema.parse({
      schemaVersion: 1,
      manifestUrl: "https://example.com/extension-update.json",
    }).manifestUrl).toBe("https://example.com/extension-update.json");
    expect(extensionReleaseManifestSchema.parse({
      schemaVersion: 1,
      id: "scheduler",
      apiVersion: 1,
      version: "0.1.3",
      engines: {host: ">=0.2.0 <1", zcode: ">=3.3.6"},
      archive: {
        url: "https://example.com/scheduler.zip",
        sha256: "a".repeat(64),
        size: 1024,
      },
      releaseUrl: "https://example.com/releases/v0.1.3",
      publishedAt: "2026-07-19T12:00:00.000Z",
    })).toMatchObject({id: "scheduler", version: "0.1.3"});
  });
});

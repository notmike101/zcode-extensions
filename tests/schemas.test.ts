import {describe, expect, test} from "bun:test";
import {
  extensionReleaseManifestSchema,
  extensionUpdateSourceSchema,
  pluginManifestSchema,
  taskSpecSchema,
} from "../src/shared/schemas.ts";
import {assertExtensionManifest, validateExtensionManifest} from "../sdk/index.ts";

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

  test("accepts declared capabilities while retaining legacy manifests", () => {
    const declared = pluginManifestSchema.parse({
      apiVersion: 1,
      id: "telemetry",
      name: "Telemetry",
      version: "1.0.0",
      entrypoints: {renderer: "dist/renderer.js"},
      capabilities: ["zcode.usage.read", "zcode.sessions.events", "ui.chat"],
    });
    expect(declared.capabilities).toEqual(["zcode.usage.read", "zcode.sessions.events", "ui.chat"]);
    const legacy = pluginManifestSchema.parse({
      apiVersion: 1,
      id: "legacy",
      name: "Legacy",
      version: "1.0.0",
      entrypoints: {main: "dist/main.cjs"},
    });
    expect(legacy.capabilities).toBeUndefined();
    expect(() => pluginManifestSchema.parse({...declared, capabilities: ["zcode.everything"]})).toThrow();
    expect(() => pluginManifestSchema.parse({...declared, capabilities: ["zcode.usage.read", "zcode.usage.read"]})).toThrow("Capabilities must be unique");
  });

  test("ships a browser-safe manifest validator with host-compatible defaults", () => {
    const result = validateExtensionManifest({
      apiVersion: 1,
      id: "usage-panel",
      name: "Usage Panel",
      version: "0.1.0",
      entrypoints: {renderer: "dist/renderer.js"},
      capabilities: ["zcode.usage.read", "ui.pages"],
    });
    expect(result).toMatchObject({
      success: true,
      manifest: {engines: {host: ">=0.1.0", zcode: ">=3.3.6"}, pages: []},
    });
    expect(() => assertExtensionManifest({
      apiVersion: 1,
      id: "usage-panel",
      name: "Usage Panel",
      version: "0.1.0",
      entrypoints: {renderer: "../renderer.js"},
      capabilities: ["zcode.usage.read", "zcode.usage.read"],
    })).toThrow("Entrypoints must be relative");
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

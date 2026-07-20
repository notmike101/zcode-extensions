import {expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {pluginManifestSchema} from "../src/shared/schemas.ts";

test("the Hello Extension manifest matches API version 1", async () => {
  const root = path.resolve(import.meta.dir, "..", "examples", "hello-extension");
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(path.join(root, ".zdp", "plugin.json"), "utf8")),
  );
  expect(manifest.id).toBe("hello-extension");
  expect(manifest.entrypoints).toEqual({
    main: "dist/main.cjs",
    renderer: "dist/renderer.js",
  });
  expect(manifest.pages).toEqual([{id: "hello", title: "Hello"}]);
});

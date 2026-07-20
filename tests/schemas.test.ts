import {describe, expect, test} from "bun:test";
import {pluginManifestSchema, taskSpecSchema} from "../src/shared/schemas.ts";
import {editableJobSchema, jobSchema} from "../plugins/scheduler/src/schemas.ts";

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

  test("task spec defaults to plan mode", () => {
    expect(taskSpecSchema.parse({workspacePath: "D:\\project", prompt: "Review it"}).mode).toBe("plan");
  });

  test("job contract constrains parallelism and missed policy", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "b87724c4-cfb2-46af-9b57-02d10dc31401",
      name: "Daily",
      enabled: true,
      cron: "0 9 * * *",
      timezone: "UTC",
      workspacePath: "D:\\project",
      prompt: "Review",
      mode: "plan" as const,
      overlapPolicy: "parallel" as const,
      maxParallel: 5,
      missedPolicy: "skip" as const,
      graceMs: 60_000,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    expect(() => jobSchema.parse(base)).toThrow();
    expect(jobSchema.parse({...base, maxParallel: 4}).maxParallel).toBe(4);
  });

  test("accepts an existing job id when editing", () => {
    expect(editableJobSchema.parse({
      id: "b87724c4-cfb2-46af-9b57-02d10dc31401",
      name: "Daily",
      enabled: true,
      cron: "0 9 * * *",
      timezone: "UTC",
      workspacePath: "D:\\project",
      prompt: "Review",
      mode: "plan",
      overlapPolicy: "skip",
      maxParallel: 4,
      missedPolicy: "skip",
      graceMs: 60_000,
    }).id).toBe("b87724c4-cfb2-46af-9b57-02d10dc31401");
  });
});

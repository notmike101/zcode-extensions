import {describe, expect, test} from "bun:test";
import {buildRuntimeModelFromProviderCache, parseStoredModelRef} from "../src/protocol/desktop-model.ts";

describe("desktop model inheritance", () => {
  test("preserves model IDs containing an at-sign from the task index", () => {
    expect(parseStoredModelRef(
      "glm",
      "837d3793-a6ae-4241-8bd8-073e4551fced/qwen3.6-35b-a3b@q3_k_m",
    )).toEqual({
      providerId: "837d3793-a6ae-4241-8bd8-073e4551fced",
      modelId: "qwen3.6-35b-a3b@q3_k_m",
    });
  });

  test("uses the task provider when the stored model has no provider prefix", () => {
    expect(parseStoredModelRef("builtin:zai", "GLM-5-Turbo")).toEqual({
      providerId: "builtin:zai",
      modelId: "GLM-5-Turbo",
    });
  });

  test("decodes URL-encoded model IDs and rejects incomplete records", () => {
    expect(parseStoredModelRef("glm", "custom/model%40fast")).toEqual({
      providerId: "custom",
      modelId: "model@fast",
    });
    expect(parseStoredModelRef(undefined, "model-only")).toBeUndefined();
    expect(parseStoredModelRef("glm", "")).toBeUndefined();
  });

  test("projects the desktop provider cache into a protocol runtime model", () => {
    const runtime = buildRuntimeModelFromProviderCache({
      updatedAt: 123,
      providers: [{
        id: "custom-provider",
        name: "Local model server",
        source: "custom",
        defaultKind: "anthropic",
        apiFormat: "anthropic-messages",
        apiKeyRequired: false,
        apiKey: "local-key",
        endpoints: {baseURL: "http://127.0.0.1:8080", paths: {anthropic: "/v1/messages"}},
        models: [{
          id: "model@quant",
          contextWindow: 32_000,
          modalities: {input: ["text"], output: ["text"]},
        }],
      }],
    }, {providerId: "custom-provider", modelId: "model@quant"});

    expect(runtime).toMatchObject({
      generatedAt: 123,
      model: {providerId: "custom-provider", modelId: "model@quant"},
      provider: {
        providerId: "custom-provider",
        kind: "anthropic",
        apiFormat: "anthropic-messages",
        baseURL: "http://127.0.0.1:8080",
        apiKey: {source: "inline", value: "local-key"},
        models: [{modelId: "model@quant", contextWindow: 32_000}],
      },
    });
    expect(runtime?.revision).toMatch(/^model-runtime:[a-f0-9]{24}$/);
  });
});

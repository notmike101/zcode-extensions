import {describe, expect, test} from "bun:test";
import type {ExtensionManifest} from "../sdk/index.ts";
import {
  ExtensionZCodeService,
  normalizeModelRequestEvent,
  normalizeSessionEvent,
} from "../src/protocol/extension-service.ts";

describe("extension ZCode service", () => {
  test("grants legacy defaults and enforces declared capabilities", async () => {
    const service = createService();
    expect(service.capabilities(manifest()).granted).toEqual([
      "zcode.workspaces.read",
      "zcode.tasks.run",
      "ui.pages",
    ]);
    const restricted = manifest(["zcode.usage.read"]);
    await expect(service.invoke(restricted, "sessions.list", {})).rejects.toThrow("zcode.sessions.read");
  });

  test("sanitizes model trajectory history without prompt or response text", async () => {
    const service = createService({
      async getModelTrajectory() {
        return {
          available: true,
          truncated: false,
          records: [{
            requestId: "request-1",
            attempt: 1,
            turnId: "turn-1",
            durationMs: 2_000,
            callSource: {kind: "main", querySource: "main_turn"},
            model: {providerId: "openai", modelId: "gpt-test"},
            request: {messages: [{role: "user", parts: [{kind: "text", text: "secret prompt"}]}]},
            response: {text: "secret response", usage: {inputTokens: 10, outputTokens: 40, totalTokens: 50}},
          }, {
            requestId: "request-2",
            attempt: 1,
            turnId: "turn-1",
            durationMs: 500,
            status: "failed",
            model: {providerId: "openai", modelId: "gpt-test"},
            error: {name: "ProviderError", message: "secret provider response body"},
          }],
        };
      },
    });
    const history = await service.invoke<{
      records: Array<Record<string, unknown>>;
    }>(manifest(["zcode.usage.read"]), "usage.listModelRequests", {sessionId: "session-1"});
    expect(history.records[0]).toMatchObject({
      requestId: "request-1",
      sessionId: "session-1",
      durationMs: 2_000,
      status: "completed",
      usage: {outputTokens: 40},
    });
    expect(JSON.stringify(history)).not.toContain("secret prompt");
    expect(JSON.stringify(history)).not.toContain("secret response");
    expect(history.records[1]).toMatchObject({status: "failed", error: {name: "ProviderError"}});
    expect(JSON.stringify(history)).not.toContain("secret provider response body");
  });

  test("preserves known and unknown session events and derives request completion usage", () => {
    const known = normalizeSessionEvent({
      type: "session.event",
      event: {eventId: "event-1", sessionId: "session-1", turnId: "turn-1", seq: 7, type: "session.updated", payload: {
        type: "model_request_completed", requestId: "request-1", providerId: "openai", modelId: "gpt-test",
        durationMs: 2_000, usage: {outputTokens: 40},
      }},
    });
    expect(known).toMatchObject({known: true, type: "session.updated", seq: 7});
    const modelEvent = normalizeModelRequestEvent(known!);
    expect(modelEvent).toMatchObject({
      type: "completed", requestId: "request-1", sessionId: "session-1", turnId: "turn-1",
      durationMs: 2_000, usage: {outputTokens: 40},
    });
    expect(modelEvent).not.toHaveProperty("raw");
    expect(normalizeSessionEvent({type: "session.event", event: {type: "future.event", payload: {value: 1}}}, "session-2"))
      .toMatchObject({known: false, type: "future.event", sessionId: "session-2", payload: {value: 1}});
    expect(normalizeSessionEvent({type: "permission.request", sessionId: "session-3", request: {requestId: "p-1"}}))
      .toMatchObject({known: true, type: "permission.requested", sessionId: "session-3", payload: {requestId: "p-1"}});
    expect(normalizeSessionEvent({type: "future.envelope", sessionId: "session-4", payload: {value: 2}}))
      .toMatchObject({known: false, type: "future.envelope", sessionId: "session-4", payload: {value: 2}});
  });

  test("gates raw RPC and renderer task visibility behind declared capabilities", async () => {
    const calls: unknown[] = [];
    const ensured: unknown[] = [];
    const service = createService({}, {
      async call(channel: string, command: string, payload: unknown) {
        calls.push({channel, command, payload});
        return {ok: true};
      },
    }, ensured);
    const experimental = manifest(["experimental.zcode.rpc", "zcode.tasks.run"]);
    await expect(service.invoke(experimental, "experimental.call", {
      channel: "private-service", command: "inspect", payload: {id: 1},
    })).resolves.toEqual({ok: true});
    await expect(service.invoke(experimental, "tasks.ensureVisible", {
      sessionId: "session-1", workspacePath: "D:\\project", title: "Visible",
    })).resolves.toBeUndefined();
    expect(calls).toEqual([{channel: "private-service", command: "inspect", payload: {id: 1}}]);
    expect(ensured).toEqual([{sessionId: "session-1", workspacePath: "D:\\project", title: "Visible"}]);
    await expect(service.invoke(manifest([]), "experimental.call", {
      channel: "private-service", command: "inspect",
    })).rejects.toThrow("experimental.zcode.rpc");
  });

  test("maps stable APIs to the installed ZCode 3.3.6 service surface", async () => {
    const methods: string[] = [];
    const session = {
      async readWorkspaceState() {
        methods.push("readWorkspaceState");
        return {modelCatalog: {providers: [{id: "openai"}]}, settings: {mode: {current: "build"}}};
      },
      async goalSession() { methods.push("goalSession"); },
      async generateWorkspaceText() { methods.push("generateWorkspaceText"); return {text: "ok"}; },
      async listMcpServerStatuses() { methods.push("listMcpServerStatuses"); return []; },
    };
    const task = {
      async getTaskSnapshot() { methods.push("getTaskSnapshot"); return {}; },
      async setTaskPinned(payload: Record<string, unknown>) { methods.push(`setTaskPinned:${payload.pinned}`); },
      async branchTaskFromPrompt() { methods.push("branchTaskFromPrompt"); },
    };
    const service = createService({}, {
      async service(name: string) { return name === "zcode-session" ? session : task; },
    }, [], (sessionId) => ({workspacePath: "D:\\project", sessionId}));
    const allowed = manifest([
      "zcode.workspaces.read", "zcode.sessions.read", "zcode.sessions.write", "zcode.tasks.read", "zcode.tasks.write",
      "zcode.models.read", "zcode.models.generate",
    ]);
    await expect(service.invoke(allowed, "workspaces.readProviderRegistry", {workspacePath: "D:\\project"}))
      .resolves.toMatchObject({providers: [{id: "openai"}]});
    await expect(service.invoke(allowed, "sessions.resolveTarget", {sessionId: "s"}))
      .resolves.toEqual({workspacePath: "D:\\project", sessionId: "s"});
    await service.invoke(allowed, "sessions.setGoal", {workspacePath: "D:\\project", sessionId: "s"});
    await service.invoke(allowed, "tasks.getSnapshot", {workspacePath: "D:\\project", taskId: "s"});
    await service.invoke(allowed, "tasks.pin", {workspacePath: "D:\\project", taskId: "s"});
    await service.invoke(allowed, "tasks.branch", {workspacePath: "D:\\project", taskId: "s"});
    await service.invoke(allowed, "models.generateText", {workspacePath: "D:\\project", prompt: "hi"});
    await service.invoke(allowed, "mcp.list", {workspacePath: "D:\\project"});
    expect(methods).toEqual([
      "readWorkspaceState", "goalSession", "getTaskSnapshot", "setTaskPinned:true",
      "branchTaskFromPrompt", "generateWorkspaceText", "listMcpServerStatuses",
    ]);
  });

  test("normalizes task, workspace, and broadcast streams without discarding raw envelopes", () => {
    const subscriptions: Array<{channel: string; event: string}> = [];
    const service = createService({}, {
      subscribe(channel: string, event: string, _payload: unknown, listener: (value: unknown) => void) {
        subscriptions.push({channel, event});
        listener({type: "future.changed", taskId: "task-1", workspacePath: "D:\\project", payload: {value: 1}});
        return {dispose() {}};
      },
    });
    const values: Array<Record<string, unknown>> = [];
    const allowed = manifest(["zcode.tasks.read", "zcode.workspaces.read", "zcode.broadcast"]);
    service.subscribe(allowed, "tasks.events", {}, (value) => values.push(value as never));
    service.subscribe(allowed, "workspaces.events", {}, (value) => values.push(value as never));
    service.subscribe(allowed, "broadcast.events", {}, (value) => values.push(value as never));
    expect(subscriptions).toEqual([
      {channel: "zcode-task", event: "onDynamicTaskEvent"},
      {channel: "zcode-task", event: "onDynamicWorkspaceEvent"},
      {channel: "broadcast", event: "onMessage"},
    ]);
    expect(values.map((value) => value.source)).toEqual(["task", "workspace", "broadcast"]);
    expect(values.every((value) => value.name === "future.changed" && value.raw !== undefined)).toBe(true);
  });
});

function manifest(capabilities?: ExtensionManifest["capabilities"]): ExtensionManifest {
  return {
    apiVersion: 1,
    id: "test-extension",
    name: "Test",
    version: "1.0.0",
    entrypoints: {renderer: "dist/renderer.js"},
    engines: {host: ">=0.3.0", zcode: ">=3.3.6"},
    pages: [],
    ...(capabilities ? {capabilities} : {}),
  };
}

function createService(
  taskMethods: Record<string, unknown> = {},
  gatewayOverrides: Record<string, unknown> = {},
  ensured: unknown[] = [],
  resolveSessionTarget?: (sessionId: string) => {workspacePath: string; workspaceIdentity?: string; sessionId: string} | undefined,
) {
  const gateway = {
    async service(name: string) {
      if (name === "zcode-task") return taskMethods;
      return {};
    },
    async call() { return undefined; },
    subscribe() { return {dispose() {}}; },
    ...gatewayOverrides,
  };
  const taskService = {
    async readWorkspaceState() { return {}; },
    async run() { throw new Error("unused"); },
    async ensureVisible(spec: unknown) { ensured.push(spec); },
  };
  return new ExtensionZCodeService({
    gateway: gateway as never,
    taskService: taskService as never,
    hostVersion: "0.3.0",
    zcodeVersion: "3.3.6",
    resolveSessionTarget,
  });
}

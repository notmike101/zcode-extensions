import {describe, expect, test} from "bun:test";
import type {DesktopServiceConnection, DesktopServicePort} from "../src/protocol/desktop-service.ts";
import {TaskService} from "../src/protocol/task-service.ts";
import {JsonLogger} from "../src/shared/logger.ts";

describe("native desktop task service", () => {
  test("creates, titles, and completes a persistent native sidebar task", async () => {
    const harness = createHarness();
    const service = harness.service;
    const handle = await service.run({
      workspacePath: "D:\\project",
      prompt: "Review open work",
      title: "⏰ Morning review",
      mode: "plan",
    });

    expect(handle.sessionId).toBe("session-1");
    expect(harness.created[0]).toMatchObject({
      workspacePath: "D:\\project",
      mode: "plan",
    });
    expect(harness.sent[0]).toMatchObject({
      workspacePath: "D:\\project",
      sessionId: "session-1",
      content: "Review open work",
    });
    expect(harness.renamed).toHaveLength(2);
    expect(harness.renamed[0]).toMatchObject({taskId: "session-1", title: "⏰ Morning review"});
    expect(harness.broadcasts.slice(0, 2).map((entry) => entry.payload.event)).toEqual(["created", "prompt_sent"]);
    expect(harness.broadcasts[0]).toMatchObject({
      channel: "bots:task",
      payload: {
        workspacePath: "D:\\project",
        taskId: "session-1",
        event: "created",
        task: {title: "⏰ Morning review"},
      },
    });

    harness.emit({
      type: "session.event",
      event: {type: "turn.completed", payload: {inputId: harness.sent[0]!.inputId, resultType: "success"}},
    });
    await expect(handle.completion).resolves.toEqual({sessionId: "session-1", status: "succeeded"});
    expect(harness.broadcasts.at(-1)?.payload.event).toBe("completed");
    expect(harness.subscriptionDisposed).toBe(1);
    expect(harness.stopped).toHaveLength(0);
    await service.shutdown();
  });

  test("restores missing tasks and marks interactive runs as needing attention", async () => {
    const harness = createHarness();
    await harness.service.ensureVisible({
      sessionId: "session-old",
      workspacePath: "D:\\project",
      title: "⏰ Legacy review",
    });
    expect(harness.resumed[0]).toMatchObject({
      sessionId: "session-old",
      workspacePath: "D:\\project",
      broadcastSnapshot: true,
    });
    expect(harness.created[0]).toMatchObject({
      draftSessionId: "session-old",
      workspacePath: "D:\\project",
      mode: "plan",
    });
    expect(harness.renamed.at(-1)).toMatchObject({taskId: "session-old", title: "⏰ Legacy review"});
    expect(harness.broadcasts[0]?.payload.event).toBe("created");

    const run = await harness.service.run({workspacePath: "D:\\project", prompt: "Ask if needed", mode: "plan"});
    harness.emit({type: "session.event", event: {type: "permission.requested", payload: {inputId: harness.sent[0]!.inputId}}});
    harness.emit({
      type: "session.event",
      event: {type: "turn.completed", payload: {inputId: harness.sent[0]!.inputId, resultType: "success"}},
    });
    await expect(run.completion).resolves.toEqual({sessionId: "session-1", status: "needs_attention"});
    await harness.service.shutdown();
  });
});

function createHarness() {
  const created: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const resumed: Array<Record<string, unknown>> = [];
  const renamed: Array<Record<string, unknown>> = [];
  const stopped: Array<Record<string, unknown>> = [];
  const broadcasts: Array<{channel: string; payload: Record<string, unknown>}> = [];
  let listener: (event: unknown) => void = () => undefined;
  let subscriptionDisposed = 0;
  const session = {
    async resumeSession(input: Record<string, unknown>) { resumed.push(input); return {session: {sessionId: input.sessionId}}; },
    async readWorkspaceState() { return {}; },
    async sendPrompt(input: Record<string, unknown>) { sent.push(input); },
    async stopSession(input: Record<string, unknown>) { stopped.push(input); },
    onDynamicSessionEvent() {
      return (next: (event: unknown) => void) => {
        listener = next;
        return {dispose: () => { subscriptionDisposed += 1; }};
      };
    },
  };
  const task = {
    async createTask(input: Record<string, unknown>) {
      created.push(input);
      return {taskId: input.draftSessionId ?? "session-1", workspacePath: input.workspacePath, title: "Untitled"};
    },
    async getTaskMeta() { return undefined; },
    async renameTask(input: Record<string, unknown>) {
      renamed.push(input);
      return {taskId: input.taskId, workspacePath: input.workspacePath, title: input.title};
    },
  };
  const broadcast = {
    async send(input: {channel: string; payload: Record<string, unknown>}) { broadcasts.push(input); },
  };
  const entry = {port: {} as DesktopServicePort["port"], process: {} as DesktopServicePort["process"]};
  const broker = {
    current: () => entry,
    onChange: () => ({dispose() {}}),
    waitForPort: async () => entry,
    dispose() {},
  };
  const services = {broadcast, "zcode-session": session, "zcode-task": task};
  const connection = {
    broadcast,
    session,
    task,
    service: (name: keyof typeof services) => services[name],
    channel: (name: keyof typeof services) => ({
      async call() { return undefined; },
      listen(event: string, argument?: unknown) {
        if (name !== "zcode-session" || event !== "onDynamicSessionEvent") throw new Error(`Unexpected listener ${name}:${event}`);
        void argument;
        return session.onDynamicSessionEvent();
      },
    }),
    dispose() {},
  } as unknown as DesktopServiceConnection;
  const service = new TaskService({
    vendorAsar: "unused",
    portBroker: broker,
    logger: new JsonLogger("unused-task-service-test.log", "test"),
    connect: async () => connection,
  });
  return {
    service,
    created,
    sent,
    resumed,
    renamed,
    stopped,
    broadcasts,
    get subscriptionDisposed() { return subscriptionDisposed; },
    emit: (event: unknown) => listener(event),
  };
}

import {describe, expect, test} from "bun:test";
import os from "node:os";
import path from "node:path";
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
    expect(harness.subscriptions[0]).toMatchObject({
      channel: "zcode-session",
      event: "onDynamicSessionEvent",
      argument: {sessionId: "session-1", deliveryKind: "desktop-continuous", includeSnapshot: true},
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

  test("uses the ZCode 3.4.2 V4 task facade and accepts direct terminal events", async () => {
    const harness = createHarness("3.4.2");
    const handle = await harness.service.run({
      workspacePath: "D:\\project",
      prompt: "Reply with ready",
      title: "V4 task",
      mode: "plan",
    });

    expect(harness.created[0]).toMatchObject({workspacePath: "D:\\project", mode: "plan", v4Create: true});
    expect(harness.sentVia).toEqual(["task"]);
    expect(harness.sent[0]).toMatchObject({
      taskId: "session-1",
      traceId: "trace-1",
      content: "Reply with ready",
    });
    expect(harness.sent[0]).not.toHaveProperty("sessionId");
    expect(harness.subscriptions).toEqual([{
      channel: "zcode-task",
      event: "onDynamicTaskEvent",
      argument: {
        workspacePath: "D:\\project",
        taskId: "session-1",
        deliveryKind: "desktop-continuous",
      },
    }]);

    harness.emit({type: "task_complete", inputId: "trace-1", stopReason: "complete"});
    await expect(handle.completion).resolves.toEqual({sessionId: "session-1", status: "succeeded"});
    expect(harness.subscriptionDisposed).toBe(1);
    await harness.service.shutdown();
  });

  test("returns the V4 run handle immediately after prompt acceptance", async () => {
    const harness = createHarness("3.4.2", true);
    const handle = await Promise.race([
      harness.service.run({workspacePath: "D:\\project", prompt: "Reply with ready", title: "V4 task", mode: "plan"}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run handle did not return")), 100)),
    ]);

    expect(handle.sessionId).toBe("session-1");
    expect(harness.sentVia).toEqual(["task"]);
    harness.emit({type: "task_complete", inputId: "trace-1", stopReason: "complete"});
    await expect(handle.completion).resolves.toEqual({sessionId: "session-1", status: "succeeded"});
    await harness.service.shutdown();
  });

  test("maps direct V4 interaction, failure, and cancellation outcomes", async () => {
    const attention = createHarness("3.4.2");
    const attentionRun = await attention.service.run({workspacePath: "D:\\project", prompt: "Ask", mode: "plan"});
    attention.emit({type: "permission_request"});
    attention.emit({type: "task_complete", inputId: "trace-1", stopReason: "complete"});
    await expect(attentionRun.completion).resolves.toEqual({sessionId: "session-1", status: "needs_attention"});
    await attention.service.shutdown();

    const failed = createHarness("3.4.2");
    const failedRun = await failed.service.run({workspacePath: "D:\\project", prompt: "Fail", mode: "plan"});
    failed.emit({type: "task_error", inputId: "trace-1", error: "provider unavailable"});
    await expect(failedRun.completion).resolves.toEqual({
      sessionId: "session-1",
      status: "failed",
      error: "provider unavailable",
    });
    await failed.service.shutdown();

    const cancelled = createHarness("3.4.2");
    const cancelledRun = await cancelled.service.run({workspacePath: "D:\\project", prompt: "Wait", mode: "plan"});
    cancelled.emit({type: "task_complete", inputId: "trace-1", stopReason: "cancelled"});
    await expect(cancelledRun.completion).resolves.toEqual({sessionId: "session-1", status: "cancelled"});

    const stopped = createHarness("3.4.2");
    const stoppedRun = await stopped.service.run({workspacePath: "D:\\project", prompt: "Wait", mode: "plan"});
    await stoppedRun.stop();
    await expect(stoppedRun.completion).resolves.toEqual({sessionId: "session-1", status: "cancelled"});
    expect(stopped.stopped[0]).toMatchObject({sessionId: "session-1", workspacePath: "D:\\project"});
    await cancelled.service.shutdown();
    await stopped.service.shutdown();
  });

  test("stops and cleans up a V4 run after its timeout", async () => {
    const harness = createHarness("3.4.2");
    const run = await harness.service.run({
      workspacePath: "D:\\project",
      prompt: "Wait",
      mode: "plan",
      timeoutMs: 5,
    });

    await expect(run.completion).resolves.toEqual({
      sessionId: "session-1",
      status: "timed_out",
      error: "Task exceeded 5 ms",
    });
    expect(harness.stopped[0]).toMatchObject({sessionId: "session-1", workspacePath: "D:\\project"});
    expect(harness.subscriptionDisposed).toBe(1);
    await harness.service.shutdown();
  });
});

function createHarness(zcodeVersion = "3.3.6", blockPostAcceptanceCalls = false) {
  const created: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const resumed: Array<Record<string, unknown>> = [];
  const renamed: Array<Record<string, unknown>> = [];
  const stopped: Array<Record<string, unknown>> = [];
  const broadcasts: Array<{channel: string; payload: Record<string, unknown>}> = [];
  const sentVia: string[] = [];
  const subscriptions: Array<{channel: string; event: string; argument: unknown}> = [];
  let listener: (event: unknown) => void = () => undefined;
  let subscriptionDisposed = 0;
  const session = {
    async resumeSession(input: Record<string, unknown>) { resumed.push(input); return {session: {sessionId: input.sessionId}}; },
    async readWorkspaceState() { return {}; },
    async sendPrompt(input: Record<string, unknown>) { sentVia.push("session"); sent.push(input); },
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
      return {taskId: input.draftSessionId ?? "session-1", traceId: "trace-1", workspacePath: input.workspacePath, title: "Untitled"};
    },
    async sendPrompt(input: Record<string, unknown>) { sentVia.push("task"); sent.push(input); },
    async getTaskMeta() { return undefined; },
    async renameTask(input: Record<string, unknown>) {
      renamed.push(input);
      return {taskId: input.taskId, workspacePath: input.workspacePath, title: input.title};
    },
  };
  const broadcast = {
    async send(input: {channel: string; payload: Record<string, unknown>}) {
      broadcasts.push(input);
      if (blockPostAcceptanceCalls && input.payload.event === "prompt_sent") {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
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
        const supported = (name === "zcode-session" && event === "onDynamicSessionEvent")
          || (name === "zcode-task" && event === "onDynamicTaskEvent");
        if (!supported) throw new Error(`Unexpected listener ${name}:${event}`);
        subscriptions.push({channel: name, event, argument});
        return session.onDynamicSessionEvent();
      },
    }),
    dispose() {},
  } as unknown as DesktopServiceConnection;
  const service = new TaskService({
    vendorAsar: "unused",
    portBroker: broker,
    logger: new JsonLogger(path.join(os.tmpdir(), "zdp-tests", "task-service.log"), "test"),
    zcodeVersion,
    connect: async () => connection,
  });
  return {
    service,
    created,
    sent,
    sentVia,
    subscriptions,
    resumed,
    renamed,
    stopped,
    broadcasts,
    get subscriptionDisposed() { return subscriptionDisposed; },
    emit: (event: unknown) => listener(event),
  };
}

import {randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import path from "node:path";
import type {JsonLogger} from "../shared/logger.ts";
import {taskSpecSchema, type TaskSpec} from "../shared/schemas.ts";
import type {
  DesktopServiceConnection,
  DesktopServicePort,
  DesktopServicePortBroker,
  Disposable,
} from "./desktop-service.ts";
import {ZCodeGateway} from "./zcode-gateway.ts";

export type TaskResultStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "lost" | "needs_attention";

export type TaskResult = {
  sessionId: string;
  status: TaskResultStatus;
  error?: string;
};

export type TaskRunHandle = {
  sessionId: string;
  completion: Promise<TaskResult>;
  stop: () => Promise<void>;
};

export type VisibleTaskSpec = {
  sessionId: string;
  workspacePath: string;
  title?: string;
};

type TaskServiceOptions = {
  gateway?: Pick<ZCodeGateway, "service" | "subscribe" | "on" | "removeListener">;
  vendorAsar?: string;
  portBroker?: Pick<DesktopServicePortBroker, "current" | "onChange" | "waitForPort" | "dispose">;
  logger: JsonLogger;
  onHealth?: (status: "idle" | "starting" | "ready" | "error", error?: string) => void;
  connect?: (port: DesktopServicePort["port"], vendorAsar: string) => Promise<DesktopServiceConnection>;
};

type SessionSnapshot = {
  session?: {
    sessionId?: string;
    status?: string;
    workspace?: {workspacePath?: string; workspaceIdentity?: string};
  };
  runtime?: {mainActive?: boolean; activeTurnId?: string};
};

type SessionService = {
  resumeSession: (input: Record<string, unknown>) => Promise<SessionSnapshot>;
  readWorkspaceState: (input: Record<string, unknown>) => Promise<unknown>;
  sendPrompt: (input: Record<string, unknown>) => Promise<unknown>;
  stopSession: (input: Record<string, unknown>) => Promise<unknown>;
  onDynamicSessionEvent: (input: Record<string, unknown>) => (listener: (event: unknown) => void) => Disposable;
};

type TaskIndexService = {
  createTask: (input: Record<string, unknown>) => Promise<unknown>;
  getTaskMeta: (input: Record<string, unknown>) => Promise<unknown>;
  renameTask: (input: Record<string, unknown>) => Promise<unknown>;
};

type BroadcastService = {
  send: (input: {channel: string; payload: Record<string, unknown>}) => Promise<unknown>;
};

type ActiveRun = {
  sessionId: string;
  inputId: string;
  title?: string;
  target: Record<string, unknown>;
  broadcast: BroadcastService;
  interactionBlocked: boolean;
  finish: (result: TaskResult) => void;
  subscription: Disposable;
  timeout?: NodeJS.Timeout;
};

export class TaskService extends EventEmitter {
  readonly #options: TaskServiceOptions;
  readonly #runs = new Map<string, ActiveRun>();
  readonly #gateway: Pick<ZCodeGateway, "service" | "subscribe" | "on" | "removeListener">;
  readonly #ownedGateway?: ZCodeGateway;
  readonly #disconnected = () => {
    for (const run of [...this.#runs.values()]) {
      run.finish({sessionId: run.sessionId, status: "lost", error: "The ZCode desktop service host exited"});
    }
  };

  constructor(options: TaskServiceOptions) {
    super();
    this.#options = options;
    if (options.gateway) this.#gateway = options.gateway;
    else {
      if (!options.vendorAsar || !options.portBroker) throw new Error("TaskService requires a shared gateway or legacy port options");
      this.#ownedGateway = new ZCodeGateway({
        vendorAsar: options.vendorAsar,
        portBroker: options.portBroker,
        logger: options.logger,
        onHealth: options.onHealth,
        connect: options.connect,
      });
      this.#gateway = this.#ownedGateway;
    }
    this.#gateway.on("disconnected", this.#disconnected);
  }

  async readWorkspaceState(workspacePath: string): Promise<unknown> {
    const {session} = await this.#services();
    return session.readWorkspaceState(workspaceTarget(workspacePath));
  }

  async ensureVisible(input: VisibleTaskSpec): Promise<void> {
    const {broadcast, session, task} = await this.#services();
    const target = workspaceTarget(input.workspacePath);
    const taskTarget = {...target, taskId: input.sessionId};
    const current = await task.getTaskMeta(taskTarget);
    if (!current) {
      await session.resumeSession({...target, sessionId: input.sessionId, broadcastSnapshot: true});
    }
    const materialized = asRecord(await task.createTask({
      ...target,
      draftSessionId: input.sessionId,
      mode: "plan",
    }));
    const materializedTaskId = stringValue(materialized.taskId);
    if (materializedTaskId !== input.sessionId) {
      throw new Error(`ZCode rematerialized ${input.sessionId} as unexpected task ${materializedTaskId ?? "<missing>"}`);
    }
    const title = input.title?.trim();
    const visibleTask = title
      ? await this.#rename(task, target, input.sessionId, title) ?? materialized
      : materialized;
    await this.#broadcastTaskChange(broadcast, target, input.sessionId, "created", {task: visibleTask});
  }

  async run(input: TaskSpec): Promise<TaskRunHandle> {
    const spec = taskSpecSchema.parse(input);
    const {broadcast, session, task} = await this.#services();
    const target = workspaceTarget(spec.workspacePath);
    const createdTask = asRecord(await task.createTask({
      ...target,
      mode: spec.mode,
      ...(spec.model ? {model: spec.model} : {}),
      ...(spec.thoughtLevel ? {thoughtLevel: spec.thoughtLevel} : {}),
      ...(spec.toolAllowlist ? {toolAllowlist: spec.toolAllowlist} : {}),
      ...(spec.toolDenylist ? {toolDenylist: spec.toolDenylist} : {}),
    }));
    const sessionId = stringValue(createdTask.taskId);
    if (!sessionId) throw new Error("ZCode did not return a task ID");

    const inputId = randomUUID();
    const queryId = randomUUID();
    const messageId = randomUUID();
    let resolveCompletion!: (result: TaskResult) => void;
    const completion = new Promise<TaskResult>((resolve) => { resolveCompletion = resolve; });
    let settled = false;

    const subscriptionTarget = {
      ...target,
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: true,
    };
    const run = {} as ActiveRun;
    const finish = (result: TaskResult) => {
      if (settled) return;
      settled = true;
      this.#runs.delete(sessionId);
      run.subscription?.dispose();
      if (run.timeout) clearTimeout(run.timeout);
      const finalization = result.status === "lost" ? Promise.resolve() : this.#finalizeTask(run, result);
      void finalization.finally(() => {
        resolveCompletion(result);
        this.emit("task-finished", result);
      });
    };
    Object.assign(run, {
      sessionId,
      inputId,
      title: spec.title?.trim() || undefined,
      target,
      broadcast,
      interactionBlocked: false,
      finish,
      subscription: this.#gateway.subscribe(
        "zcode-session",
        "onDynamicSessionEvent",
        subscriptionTarget,
        (value) => this.#onSessionEvent(run, value),
      ),
    } satisfies ActiveRun);
    this.#runs.set(sessionId, run);

    try {
      const visibleTask = run.title
        ? await this.#rename(task, target, sessionId, run.title) ?? createdTask
        : createdTask;
      await this.#broadcastTaskChange(broadcast, target, sessionId, "created", {task: visibleTask});
      await session.sendPrompt({
        ...target,
        sessionId,
        inputId,
        queryId,
        messageId,
        content: spec.prompt,
      });
      if (run.title) await this.#rename(task, target, sessionId, run.title);
      await this.#broadcastTaskChange(broadcast, target, sessionId, "prompt_sent", {
        prompt: {content: spec.prompt, messageId, sentAt: Date.now()},
      });
    } catch (error) {
      this.#runs.delete(sessionId);
      run.subscription.dispose();
      throw error;
    }

    if (spec.timeoutMs) {
      run.timeout = setTimeout(() => {
        void this.#stopSession(target, sessionId);
        finish({sessionId, status: "timed_out", error: `Task exceeded ${spec.timeoutMs} ms`});
      }, spec.timeoutMs);
    }
    this.emit("task-started", {sessionId, spec});

    return {
      sessionId,
      completion,
      stop: async () => {
        if (settled) return;
        await this.#stopSession(target, sessionId);
        finish({sessionId, status: "cancelled"});
      },
    };
  }

  async shutdown(): Promise<void> {
    const session = await this.#gateway.service<SessionService & Record<string, unknown>>("zcode-session").catch(() => undefined);
    if (session) await Promise.all([...this.#runs.values()].map((run) =>
      session.stopSession({...run.target, sessionId: run.sessionId}).catch(() => undefined),
    ));
    for (const run of [...this.#runs.values()]) run.finish({sessionId: run.sessionId, status: "cancelled"});
    this.#gateway.removeListener("disconnected", this.#disconnected);
    await this.#ownedGateway?.shutdown();
  }

  async #services(): Promise<{broadcast: BroadcastService; session: SessionService; task: TaskIndexService}> {
    const [broadcast, session, task] = await Promise.all([
      this.#gateway.service<BroadcastService & Record<string, unknown>>("broadcast"),
      this.#gateway.service<SessionService & Record<string, unknown>>("zcode-session"),
      this.#gateway.service<TaskIndexService & Record<string, unknown>>("zcode-task"),
    ]);
    return {broadcast, session, task};
  }

  async #stopSession(target: Record<string, unknown>, sessionId: string): Promise<void> {
    const session = await this.#gateway.service<SessionService & Record<string, unknown>>("zcode-session").catch(() => undefined);
    await session?.stopSession({...target, sessionId}).catch(() => undefined);
  }

  async #finalizeTask(run: ActiveRun, result: TaskResult): Promise<void> {
    try {
      const {broadcast, task} = await this.#services();
      if (run.title) await this.#rename(task, run.target, run.sessionId, run.title);
      await this.#broadcastTaskChange(
        broadcast,
        run.target,
        run.sessionId,
        result.status === "failed" || result.status === "timed_out" || result.status === "lost" ? "error" : "completed",
        result.error ? {error: result.error} : {},
      );
    } catch (error) {
      await this.#options.logger.warn("Could not finalize the native task after a service reconnect", {
        sessionId: run.sessionId,
        error,
      });
    }
  }

  #onSessionEvent(run: ActiveRun, value: unknown): void {
    const envelope = asRecord(value);
    const envelopeType = stringValue(envelope.type);
    if (envelopeType === "permission.request" || envelopeType === "userInput.request" || envelopeType === "providerRuntimeHeaders.request") {
      run.interactionBlocked = true;
      return;
    }
    if (envelopeType !== "session.event") return;
    const event = asRecord(envelope.event);
    const eventType = stringValue(event.type);
    const payload = asRecord(event.payload);
    const eventInputId = stringValue(payload.inputId);
    if (eventInputId && eventInputId !== run.inputId) return;
    if (eventType === "permission.requested" || eventType === "elicitation.requested") {
      run.interactionBlocked = true;
      return;
    }
    if (eventType === "session.titleUpdated" && run.title) {
      void this.#services().then(({task}) => this.#rename(task, run.target, run.sessionId, run.title!));
      return;
    }
    if (eventType === "turn.completed") {
      const resultType = stringValue(payload.resultType) ?? "success";
      if (resultType === "cancelled") run.finish({sessionId: run.sessionId, status: "cancelled"});
      else if (resultType !== "success") run.finish({sessionId: run.sessionId, status: "failed", error: resultType});
      else run.finish({sessionId: run.sessionId, status: run.interactionBlocked ? "needs_attention" : "succeeded"});
    } else if (eventType === "turn.failed") {
      const error = asRecord(payload.error);
      run.finish({
        sessionId: run.sessionId,
        status: run.interactionBlocked ? "needs_attention" : "failed",
        error: stringValue(error.message) ?? stringValue(error.detail) ?? "ZCode session turn failed",
      });
    }
  }

  async #rename(
    task: TaskIndexService,
    target: Record<string, unknown>,
    sessionId: string,
    title: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return asRecord(await task.renameTask({...target, taskId: sessionId, title}));
    } catch (error) {
      await this.#options.logger.warn("Could not assign the scheduled task title", {sessionId, title, error});
      return undefined;
    }
  }

  async #broadcastTaskChange(
    broadcast: BroadcastService,
    target: Record<string, unknown>,
    sessionId: string,
    event: "created" | "prompt_sent" | "completed" | "error",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const task = asRecord(extra.task);
    const workspacePath = stringValue(task.workspacePath) ?? stringValue(target.workspacePath);
    if (!workspacePath) return;
    const workspaceIdentity = stringValue(task.workspaceIdentity) ?? stringValue(target.workspaceIdentity);
    try {
      await broadcast.send({
        channel: "bots:task",
        payload: {
          workspacePath,
          ...(workspaceIdentity ? {workspaceIdentity} : {}),
          taskId: sessionId,
          event,
          updatedAt: Date.now(),
          ...extra,
        },
      });
    } catch (error) {
      await this.#options.logger.warn("Could not broadcast the scheduled task sidebar update", {
        sessionId,
        event,
        error,
      });
    }
  }
}

function workspaceTarget(workspacePath: string): Record<string, unknown> {
  return {workspacePath: path.resolve(workspacePath)};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

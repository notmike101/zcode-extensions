import {randomUUID} from "node:crypto";
import {appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {writeJsonAtomic} from "../../../src/shared/atomic.ts";
import type {PluginContext} from "../../../src/host/plugin-manager.ts";
import type {TaskRunHandle} from "../../../src/protocol/task-service.ts";
import {editableJobSchema, jobSchema, runRecordSchema, type EditableJob, type RunRecord, type SchedulerJob} from "./schemas.ts";
import {nextRun, preview, systemTimezone, validateCron, validateTimezone} from "./cron.ts";

type Schedule = {timer: NodeJS.Timeout; nextAt: Date};
type ActiveRun = {record: RunRecord; handle: TaskRunHandle};

class SchedulerPlugin {
  readonly #context: PluginContext;
  readonly #jobsFile: string;
  readonly #historyFile: string;
  readonly #jobs = new Map<string, SchedulerJob>();
  readonly #schedules = new Map<string, Schedule>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #queued = new Map<string, Date>();
  #history: RunRecord[] = [];
  #disposed = false;
  #resumeHandler = () => void this.#reconcileAfterResume();
  #resumeDisposable?: {dispose: () => unknown | Promise<unknown>};

  constructor(context: PluginContext) {
    this.#context = context;
    this.#jobsFile = path.join(context.dataDir, "jobs.json");
    this.#historyFile = path.join(context.dataDir, "history.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(this.#context.dataDir, {recursive: true});
    await this.#load();
    for (const job of this.#jobs.values()) this.#arm(job);
    this.#resumeDisposable = this.#context.lifecycle.onResume(this.#resumeHandler);
    this.#registerIpc();
    await this.#context.logger.info("Scheduler initialized", {jobCount: this.#jobs.size});
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#resumeDisposable?.dispose();
    this.#resumeDisposable = undefined;
    for (const schedule of this.#schedules.values()) clearTimeout(schedule.timer);
    this.#schedules.clear();
    await Promise.all([...this.#active.values()].map((run) => run.handle.stop().catch(() => undefined)));
  }

  #registerIpc(): void {
    this.#context.ipc.handle("get-state", () => this.#state());
    this.#context.ipc.handle("preview", (payload) => {
      const value = payload as {cron?: string; timezone?: string};
      return preview(value.cron ?? "", value.timezone ?? systemTimezone());
    });
    this.#context.ipc.handle("save-job", (payload) => this.#saveJob(payload as EditableJob));
    this.#context.ipc.handle("delete-job", (payload) => this.#deleteJob(requireId(payload)));
    this.#context.ipc.handle("set-enabled", (payload) => {
      const value = payload as {id?: string; enabled?: boolean};
      return this.#setEnabled(requireId(value), Boolean(value.enabled));
    });
    this.#context.ipc.handle("run-now", (payload) => this.#runNow(requireId(payload)));
    this.#context.ipc.handle("cancel-run", (payload) => this.#cancelRun(requireId(payload)));
    this.#context.ipc.handle("choose-workspace", () => this.#context.ipc.emit("choose-workspace-request"));
    this.#context.ipc.handle("workspace-state", (payload) => {
      const value = payload as {workspacePath?: string};
      if (!value.workspacePath) throw new Error("workspacePath is required");
      return this.#context.zcode.readWorkspaceState(value.workspacePath);
    });
  }

  #state() {
    return {
      jobs: [...this.#jobs.values()].map((job) => ({...job, nextRuns: preview(job.cron, job.timezone).nextRuns})),
      history: this.#history.slice(-250).reverse(),
      active: [...this.#active.values()].map(({record}) => record),
      timezone: systemTimezone(),
      limits: {perJob: 4, global: 8},
    };
  }

  async #saveJob(input: EditableJob) {
    const editable = editableJobSchema.parse(input);
    validateCron(editable.cron);
    validateTimezone(editable.timezone);
    const current = input.id ? this.#jobs.get(input.id) : undefined;
    if (input.id && !current) throw new Error(`Unknown job: ${input.id}`);
    const now = new Date().toISOString();
    const job = jobSchema.parse({
      ...current,
      ...editable,
      schemaVersion: 1,
      id: current?.id ?? randomUUID(),
      enabled: editable.enabled ?? current?.enabled ?? true,
      mode: editable.mode ?? current?.mode ?? "plan",
      overlapPolicy: editable.overlapPolicy ?? current?.overlapPolicy ?? "skip",
      maxParallel: editable.maxParallel ?? current?.maxParallel ?? 4,
      missedPolicy: "skip",
      graceMs: editable.graceMs ?? current?.graceMs ?? 60_000,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    this.#jobs.set(job.id, job);
    await this.#persistJobs();
    this.#arm(job);
    this.#changed();
    return this.#state();
  }

  async #deleteJob(id: string) {
    if (this.#activeForJob(id).length) throw new Error("Cancel active runs before deleting this job");
    const schedule = this.#schedules.get(id);
    if (schedule) clearTimeout(schedule.timer);
    this.#schedules.delete(id);
    this.#queued.delete(id);
    if (!this.#jobs.delete(id)) throw new Error(`Unknown job: ${id}`);
    await this.#persistJobs();
    this.#changed();
    return this.#state();
  }

  async #setEnabled(id: string, enabled: boolean) {
    const current = this.#requireJob(id);
    const job = {...current, enabled, updatedAt: new Date().toISOString()};
    this.#jobs.set(id, job);
    await this.#persistJobs();
    this.#arm(job);
    this.#changed();
    return this.#state();
  }

  async #runNow(id: string) {
    const job = this.#requireJob(id);
    await this.#trigger(job, new Date(), "manual");
    return this.#state();
  }

  async #cancelRun(runId: string) {
    const active = this.#active.get(runId);
    if (!active) throw new Error(`Run is not active: ${runId}`);
    await active.handle.stop();
    return this.#state();
  }

  #arm(job: SchedulerJob, nextAt?: Date): void {
    const existing = this.#schedules.get(job.id);
    if (existing) clearTimeout(existing.timer);
    this.#schedules.delete(job.id);
    if (this.#disposed || !job.enabled) return;
    const next = nextAt ?? nextRun(job.cron, job.timezone, new Date());
    if (!next) return;
    const delay = Math.max(20, Math.min(next.getTime() - Date.now(), 60_000));
    const timer = setTimeout(() => {
      if (Date.now() + 25 < next.getTime()) this.#arm(job, next);
      else void this.#onTick(job.id, next);
    }, delay);
    this.#schedules.set(job.id, {timer, nextAt: next});
  }

  async #onTick(jobId: string, scheduledAt: Date): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job?.enabled || this.#disposed) return;
    this.#arm(job, nextRun(job.cron, job.timezone, new Date(scheduledAt.getTime() + 1_000)) ?? undefined);
    const lateness = Date.now() - scheduledAt.getTime();
    if (lateness > job.graceMs) {
      await this.#recordTerminal(job, scheduledAt, "cron", "skipped_missed", `Run was ${lateness} ms late`);
      return;
    }
    await this.#trigger(job, scheduledAt, "cron");
  }

  async #trigger(job: SchedulerJob, scheduledAt: Date, source: RunRecord["source"]): Promise<void> {
    const activeForJob = this.#activeForJob(job.id);
    if (activeForJob.length) {
      if (job.overlapPolicy === "skip") {
        await this.#recordTerminal(job, scheduledAt, source, "skipped_overlap", "A previous run is still active");
        return;
      }
      if (job.overlapPolicy === "queue-one") {
        this.#queued.set(job.id, scheduledAt);
        this.#changed();
        return;
      }
      if (activeForJob.length >= job.maxParallel || this.#active.size >= 8) {
        await this.#recordTerminal(job, scheduledAt, source, "skipped_capacity", "Scheduler concurrency limit reached");
        return;
      }
    } else if (this.#active.size >= 8) {
      await this.#recordTerminal(job, scheduledAt, source, "skipped_capacity", "Scheduler concurrency limit reached");
      return;
    }

    const record: RunRecord = {
      id: randomUUID(), jobId: job.id, jobName: job.name, source,
      scheduledAt: scheduledAt.toISOString(), startedAt: new Date().toISOString(), status: "running",
    };
    try {
      const handle = await this.#context.zcode.tasks.run({
        workspacePath: job.workspacePath,
        prompt: job.prompt,
        mode: job.mode,
        ...(job.model ? {model: job.model} : {}),
        ...(job.thoughtLevel ? {thoughtLevel: job.thoughtLevel} : {}),
        ...(job.toolAllowlist ? {toolAllowlist: job.toolAllowlist} : {}),
        ...(job.toolDenylist ? {toolDenylist: job.toolDenylist} : {}),
        ...(job.timeoutMs ? {timeoutMs: job.timeoutMs} : {}),
      });
      record.sessionId = handle.sessionId;
      this.#active.set(record.id, {record, handle});
      this.#changed();
      void handle.completion.then(async (result) => {
        this.#active.delete(record.id);
        const final = runRecordSchema.parse({
          ...record,
          status: result.status,
          finishedAt: new Date().toISOString(),
          ...(result.error ? {error: result.error} : {}),
        });
        await this.#appendHistory(final);
        this.#changed();
        const queuedAt = this.#queued.get(job.id);
        if (queuedAt && this.#activeForJob(job.id).length === 0) {
          this.#queued.delete(job.id);
          const current = this.#jobs.get(job.id);
          if (current?.enabled) await this.#trigger(current, queuedAt, "queued");
        }
      });
    } catch (error) {
      await this.#appendHistory(runRecordSchema.parse({
        ...record,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }));
      this.#changed();
    }
  }

  async #recordTerminal(job: SchedulerJob, scheduledAt: Date, source: RunRecord["source"], status: RunRecord["status"], error?: string) {
    await this.#appendHistory(runRecordSchema.parse({
      id: randomUUID(), jobId: job.id, jobName: job.name, source,
      scheduledAt: scheduledAt.toISOString(), finishedAt: new Date().toISOString(), status,
      ...(error ? {error} : {}),
    }));
    this.#changed();
  }

  async #appendHistory(record: RunRecord): Promise<void> {
    this.#history.push(record);
    if (this.#history.length > 1_000) this.#history = this.#history.slice(-1_000);
    await appendFile(this.#historyFile, `${JSON.stringify(record)}\n`, "utf8");
    const info = await stat(this.#historyFile).catch(() => null);
    if (info && info.size > 10 * 1024 * 1024) {
      const rotated = `${this.#historyFile}.${Date.now()}.jsonl`;
      await rename(this.#historyFile, rotated);
      await writeFile(this.#historyFile, `${this.#history.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
      const rotatedFiles = (await readdir(this.#context.dataDir))
        .filter((name) => /^history\.jsonl\.\d+\.jsonl$/.test(name))
        .sort()
        .reverse();
      for (const old of rotatedFiles.slice(3)) await rm(path.join(this.#context.dataDir, old), {force: true});
    }
  }

  async #load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#jobsFile, "utf8")) as {jobs?: unknown[]};
      for (const value of parsed.jobs ?? []) {
        const job = jobSchema.parse(value);
        this.#jobs.set(job.id, job);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await this.#context.logger.error("Failed to read jobs", error);
    }
    try {
      const lines = (await readFile(this.#historyFile, "utf8")).split(/\r?\n/).filter(Boolean).slice(-1_000);
      this.#history = lines.flatMap((line) => {
        try { return [runRecordSchema.parse(JSON.parse(line))]; } catch { return []; }
      });
    } catch { this.#history = []; }
  }

  async #persistJobs(): Promise<void> {
    await writeJsonAtomic(this.#jobsFile, {schemaVersion: 1, jobs: [...this.#jobs.values()]});
  }

  #activeForJob(jobId: string): ActiveRun[] {
    return [...this.#active.values()].filter(({record}) => record.jobId === jobId);
  }

  #requireJob(id: string): SchedulerJob {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  #reconcileAfterResume(): void {
    const now = Date.now();
    for (const job of this.#jobs.values()) {
      const schedule = this.#schedules.get(job.id);
      if (schedule && schedule.nextAt.getTime() < now - job.graceMs) {
        void this.#recordTerminal(job, schedule.nextAt, "cron", "skipped_missed", "ZCode was suspended during the scheduled time");
      }
      this.#arm(job);
    }
  }

  #changed(): void {
    this.#context.ipc.emit("state-changed", this.#state());
  }
}

let scheduler: SchedulerPlugin | undefined;

export async function activate(context: PluginContext) {
  scheduler = new SchedulerPlugin(context);
  await scheduler.initialize();
  return {dispose: () => scheduler?.dispose()};
}

export async function deactivate() {
  await scheduler?.dispose();
  scheduler = undefined;
}

function requireId(value: unknown): string {
  if (!value || typeof value !== "object" || !("id" in value) || typeof (value as {id: unknown}).id !== "string") throw new Error("id is required");
  return (value as {id: string}).id;
}

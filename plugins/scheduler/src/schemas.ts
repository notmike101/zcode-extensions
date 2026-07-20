import {z} from "zod";
import {modelRefSchema} from "../../../src/shared/schemas.ts";

export const jobSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  enabled: z.boolean(),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  workspacePath: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.enum(["plan", "build", "edit", "yolo"]),
  model: modelRefSchema.optional(),
  thoughtLevel: z.string().min(1).optional(),
  toolAllowlist: z.array(z.string().min(1)).optional(),
  toolDenylist: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().optional(),
  overlapPolicy: z.enum(["skip", "queue-one", "parallel"]),
  maxParallel: z.number().int().min(1).max(4).default(4),
  missedPolicy: z.literal("skip"),
  graceMs: z.number().int().min(0).max(300_000).default(60_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type SchedulerJob = z.infer<typeof jobSchema>;

export const editableJobSchema = jobSchema.omit({
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
}).partial({id: true, enabled: true, mode: true, overlapPolicy: true, maxParallel: true, missedPolicy: true, graceMs: true});

export type EditableJob = z.infer<typeof editableJobSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "needs_attention",
  "skipped_missed",
  "skipped_overlap",
  "skipped_capacity",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runRecordSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  jobName: z.string(),
  source: z.enum(["cron", "manual", "queued"]),
  scheduledAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  status: runStatusSchema,
  sessionId: z.string().optional(),
  error: z.string().optional(),
}).strict();

export type RunRecord = z.infer<typeof runRecordSchema>;

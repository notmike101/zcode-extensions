import {render} from "preact";
import {useEffect, useMemo, useState} from "preact/hooks";
import type {ZdpBridge} from "../../../src/renderer/globals.d.ts";
import type {RunRecord, SchedulerJob} from "./schemas.ts";
import styles from "./scheduler.css";

type SchedulerState = {
  jobs: Array<SchedulerJob & {nextRuns: string[]}>;
  history: RunRecord[];
  active: RunRecord[];
  timezone: string;
};

type JobDraft = {
  id?: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  workspacePath: string;
  prompt: string;
  mode: "plan" | "build" | "edit" | "yolo";
  providerId: string;
  modelId: string;
  variant: string;
  thoughtLevel: string;
  timeoutMinutes: string;
  overlapPolicy: "skip" | "queue-one" | "parallel";
  maxParallel: number;
};

const emptyDraft = (timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): JobDraft => ({
  name: "",
  enabled: true,
  cron: "0 9 * * 1-5",
  timezone,
  workspacePath: "",
  prompt: "",
  mode: "plan",
  providerId: "",
  modelId: "",
  variant: "",
  thoughtLevel: "",
  timeoutMinutes: "",
  overlapPolicy: "skip",
  maxParallel: 4,
});

window.ZDP_REGISTER_PLUGIN_RENDERER?.({
  id: "scheduler",
  mount(container, bridge) {
    const style = document.createElement("style");
    style.textContent = styles;
    container.replaceChildren(style);
    const mount = document.createElement("div");
    mount.className = "scheduler-root";
    container.append(mount);
    render(<SchedulerPage bridge={bridge}/>, mount);
    return () => render(null, mount);
  },
});

function SchedulerPage({bridge}: {bridge: ZdpBridge}) {
  const [state, setState] = useState<SchedulerState>();
  const [draft, setDraft] = useState<JobDraft>(emptyDraft());
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"jobs" | "history">("jobs");
  const [preview, setPreview] = useState<{nextRuns: string[]; description: string}>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const invoke = <T,>(method: string, payload?: unknown) => bridge.invoke<T>("plugin:invoke", {pluginId: "scheduler", method, payload});
  const refresh = () => invoke<SchedulerState>("get-state").then(setState).catch((cause) => setError(errorText(cause)));

  useEffect(() => {
    void refresh();
    const listener = () => void refresh();
    window.addEventListener("plugin:scheduler:state-changed", listener);
    return () => window.removeEventListener("plugin:scheduler:state-changed", listener);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void invoke<{nextRuns: string[]; description: string}>("preview", {cron: draft.cron, timezone: draft.timezone})
        .then((value) => {setPreview(value); setError(undefined);})
        .catch((cause) => {setPreview(undefined); setError(errorText(cause));});
    }, 250);
    return () => clearTimeout(timer);
  }, [draft.cron, draft.timezone]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); await refresh(); } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (draft.mode === "yolo" && !window.confirm("Yolo mode permits unattended workspace changes. Save this job with Yolo permissions?")) return;
    const model = draft.providerId.trim() && draft.modelId.trim()
      ? {providerId: draft.providerId.trim(), modelId: draft.modelId.trim(), ...(draft.variant.trim() ? {variant: draft.variant.trim()} : {})}
      : undefined;
    await run(async () => {
      await invoke("save-job", {
        ...(draft.id ? {id: draft.id} : {}),
        name: draft.name.trim(), enabled: draft.enabled, cron: draft.cron.trim(), timezone: draft.timezone.trim(),
        workspacePath: draft.workspacePath.trim(), prompt: draft.prompt, mode: draft.mode,
        ...(model ? {model} : {}),
        ...(draft.thoughtLevel.trim() ? {thoughtLevel: draft.thoughtLevel.trim()} : {}),
        ...(draft.timeoutMinutes ? {timeoutMs: Math.round(Number(draft.timeoutMinutes) * 60_000)} : {}),
        overlapPolicy: draft.overlapPolicy,
        maxParallel: draft.maxParallel,
        missedPolicy: "skip",
        graceMs: 60_000,
      });
      setDraft(emptyDraft(state?.timezone)); setEditing(false);
    });
  };

  const edit = (job: SchedulerJob & {nextRuns: string[]}, duplicate = false) => {
    setDraft({
      ...emptyDraft(job.timezone),
      ...(duplicate ? {} : {id: job.id}),
      name: duplicate ? `${job.name} copy` : job.name,
      enabled: duplicate ? false : job.enabled,
      cron: job.cron,
      timezone: job.timezone,
      workspacePath: job.workspacePath,
      prompt: job.prompt,
      mode: job.mode,
      providerId: job.model?.providerId ?? "",
      modelId: job.model?.modelId ?? "",
      variant: job.model?.variant ?? "",
      thoughtLevel: job.thoughtLevel ?? "",
      timeoutMinutes: job.timeoutMs ? String(job.timeoutMs / 60_000) : "",
      overlapPolicy: job.overlapPolicy,
      maxParallel: job.maxParallel,
    });
    setEditing(true); setTab("jobs");
  };

  const activeByJob = useMemo(() => new Map((state?.active ?? []).map((run) => [run.jobId, run])), [state]);

  return <div>
    <div class="scheduler-heading"><div><h2>Scheduled ZCode tasks</h2><p>Five-field cron schedules run while ZCode remains open. Missed executions are skipped.</p></div>
      <div class="scheduler-heading-actions"><button class={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>Jobs</button><button class={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History</button>
      {tab === "jobs" && <button class="primary" onClick={() => {setDraft(emptyDraft(state?.timezone)); setEditing(true);}}>New job</button>}</div></div>
    {error && <div class="scheduler-error">{error}</div>}
    {editing && tab === "jobs" && <JobEditor draft={draft} setDraft={setDraft} preview={preview} busy={busy} bridge={bridge} save={save} cancel={() => {setEditing(false); setDraft(emptyDraft(state?.timezone));}}/>}
    {!editing && tab === "jobs" && <div class="scheduler-jobs">
      {state?.jobs.map((job) => <article class="scheduler-job">
        <div class="scheduler-job-top"><div><h3>{job.name}</h3><p><code>{job.cron}</code> · {job.timezone}</p></div><span class={job.enabled ? "enabled" : "disabled"}>{job.enabled ? "Enabled" : "Paused"}</span></div>
        <p class="scheduler-prompt">{job.prompt}</p>
        <dl><dt>Workspace</dt><dd>{job.workspacePath}</dd><dt>Mode</dt><dd>{job.mode}{job.model ? ` · ${job.model.modelId}` : " · inherit model"}</dd><dt>Next</dt><dd>{job.nextRuns[0] ? formatDate(job.nextRuns[0], job.timezone) : "No future run"}</dd></dl>
        <div class="scheduler-actions">
          <button disabled={busy} onClick={() => void run(() => invoke("run-now", {id: job.id}))}>Run now</button>
          <button disabled={busy} onClick={() => edit(job)}>Edit</button><button disabled={busy} onClick={() => edit(job, true)}>Duplicate</button>
          <button disabled={busy} onClick={() => void run(() => invoke("set-enabled", {id: job.id, enabled: !job.enabled}))}>{job.enabled ? "Pause" : "Enable"}</button>
          {activeByJob.get(job.id) && <button class="warn" disabled={busy} onClick={() => void run(() => invoke("cancel-run", {id: activeByJob.get(job.id)!.id}))}>Cancel active</button>}
          <button class="danger" disabled={busy || Boolean(activeByJob.get(job.id))} onClick={() => {
            if (window.confirm(`Delete scheduled job “${job.name}”?`)) void run(() => invoke("delete-job", {id: job.id}));
          }}>Delete</button>
        </div>
      </article>)}
      {state && state.jobs.length === 0 && <div class="scheduler-empty">No scheduled jobs yet.</div>}
    </div>}
    {tab === "history" && <RunHistory state={state} busy={busy} run={run} invoke={invoke}/>} 
  </div>;
}

function JobEditor({draft, setDraft, preview, busy, bridge, save, cancel}: {
  draft: JobDraft; setDraft: (value: JobDraft) => void; preview?: {nextRuns: string[]; description: string}; busy: boolean;
  bridge: ZdpBridge; save: () => Promise<void>; cancel: () => void;
}) {
  const set = <K extends keyof JobDraft>(key: K, value: JobDraft[K]) => setDraft({...draft, [key]: value});
  return <section class="scheduler-editor"><div class="scheduler-grid">
    <label>Name<input value={draft.name} onInput={(e) => set("name", e.currentTarget.value)} placeholder="Morning repository review"/></label>
    <label>Cron expression<input value={draft.cron} onInput={(e) => set("cron", e.currentTarget.value)} placeholder="0 9 * * 1-5"/></label>
    <label>Timezone<input value={draft.timezone} onInput={(e) => set("timezone", e.currentTarget.value)} placeholder="America/Chicago"/></label>
    <label>Permission mode<select value={draft.mode} onChange={(e) => set("mode", e.currentTarget.value as JobDraft["mode"])}><option value="plan">Plan</option><option value="build">Build</option><option value="edit">Edit</option><option value="yolo">Yolo</option></select></label>
    <label class="wide">Workspace<div class="scheduler-input-button"><input value={draft.workspacePath} onInput={(e) => set("workspacePath", e.currentTarget.value)} placeholder="D:\\project"/><button type="button" onClick={async () => {const folder = await bridge.invoke<string | null>("host:chooseDirectory"); if (folder) set("workspacePath", folder);}}>Browse</button></div></label>
    <label class="wide">Prompt<textarea value={draft.prompt} onInput={(e) => set("prompt", e.currentTarget.value)} rows={6} placeholder="Describe the task ZCode should perform…"/></label>
    <label>Overlap<select value={draft.overlapPolicy} onChange={(e) => set("overlapPolicy", e.currentTarget.value as JobDraft["overlapPolicy"])}><option value="skip">Skip</option><option value="queue-one">Queue one</option><option value="parallel">Parallel</option></select></label>
    {draft.overlapPolicy === "parallel" && <label>Max parallel<input type="number" min="1" max="4" value={draft.maxParallel} onInput={(e) => set("maxParallel", Number(e.currentTarget.value))}/></label>}
    <label>Timeout minutes<input type="number" min="0.1" step="0.1" value={draft.timeoutMinutes} onInput={(e) => set("timeoutMinutes", e.currentTarget.value)} placeholder="No timeout"/></label>
    <label>Thought level<input value={draft.thoughtLevel} onInput={(e) => set("thoughtLevel", e.currentTarget.value)} placeholder="Inherit"/></label>
    <fieldset class="wide"><legend>Optional pinned model</legend><div class="scheduler-model-grid"><label>Provider<input value={draft.providerId} onInput={(e) => set("providerId", e.currentTarget.value)} placeholder="Inherit workspace"/></label><label>Model<input value={draft.modelId} onInput={(e) => set("modelId", e.currentTarget.value)} placeholder="Inherit workspace"/></label><label>Variant<input value={draft.variant} onInput={(e) => set("variant", e.currentTarget.value)} placeholder="Optional"/></label></div></fieldset>
  </div>
  {preview && <div class="scheduler-preview"><strong>{preview.description}</strong><ol>{preview.nextRuns.map((date) => <li>{formatDate(date, draft.timezone)}</li>)}</ol></div>}
  <div class="scheduler-editor-actions"><button onClick={cancel}>Cancel</button><button class="primary" disabled={busy || !draft.name.trim() || !draft.workspacePath.trim() || !draft.prompt.trim() || !preview} onClick={() => void save()}>{draft.id ? "Save changes" : "Create job"}</button></div>
  </section>;
}

function RunHistory({state, busy, run, invoke}: {state?: SchedulerState; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void>; invoke: <T>(method: string, payload?: unknown) => Promise<T>}) {
  const rows = [...(state?.active ?? []), ...(state?.history ?? [])];
  return <div class="scheduler-history"><table><thead><tr><th>Job</th><th>Status</th><th>Scheduled</th><th>Task</th><th></th></tr></thead><tbody>
    {rows.map((record) => <tr><td>{record.jobName}<small>{record.source}</small></td><td><span class={`run-status ${record.status}`}>{record.status.replaceAll("_", " ")}</span>{record.error && <small title={record.error}>{record.error}</small>}</td><td>{new Date(record.scheduledAt).toLocaleString()}</td><td><code>{record.sessionId ?? "—"}</code></td><td>{record.status === "running" && <button disabled={busy} onClick={() => void run(() => invoke("cancel-run", {id: record.id}))}>Cancel</button>}</td></tr>)}
  </tbody></table>{rows.length === 0 && <div class="scheduler-empty">No runs recorded.</div>}</div>;
}

function formatDate(value: string, timezone: string): string {
  try { return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "medium", timeZone: timezone}).format(new Date(value)); }
  catch { return new Date(value).toLocaleString(); }
}

function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }

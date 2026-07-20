import {Cron} from "croner";

export function validateCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must have exactly five fields: minute hour day month weekday");
  if (!fields.every((field) => /^[0-9A-Za-z*,\/-]+$/.test(field))) throw new Error("Cron expression contains unsupported syntax");
  new Cron(expression, {paused: true});
}

export function validateTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat("en-US", {timeZone: timezone}).format(); }
  catch { throw new Error(`Invalid IANA timezone: ${timezone}`); }
}

export function preview(expression: string, timezone: string, from = new Date()): {nextRuns: string[]; description: string} {
  validateCron(expression);
  validateTimezone(timezone);
  const cron = new Cron(expression, {timezone, paused: true});
  return {
    nextRuns: cron.nextRuns(5, from).map((date) => date.toISOString()),
    description: `Runs on ${expression} in ${timezone}`,
  };
}

export function nextRun(expression: string, timezone: string, after: Date): Date | null {
  validateCron(expression);
  validateTimezone(timezone);
  return new Cron(expression, {timezone, paused: true}).nextRun(after);
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

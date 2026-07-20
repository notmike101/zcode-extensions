import {describe, expect, test} from "bun:test";
import {nextRun, preview, validateCron, validateTimezone} from "../plugins/scheduler/src/cron.ts";

describe("scheduler cron contract", () => {
  test("accepts standard five-field expressions and returns stable UTC runs", () => {
    const result = preview("0 9 * * 1-5", "UTC", new Date("2026-07-17T12:00:00.000Z"));
    expect(result.nextRuns).toEqual([
      "2026-07-20T09:00:00.000Z",
      "2026-07-21T09:00:00.000Z",
      "2026-07-22T09:00:00.000Z",
      "2026-07-23T09:00:00.000Z",
      "2026-07-24T09:00:00.000Z",
    ]);
  });

  test("rejects seconds and Quartz-only syntax", () => {
    expect(() => validateCron("0 0 9 * * 1-5")).toThrow("exactly five fields");
    expect(() => validateCron("0 9 ? * MON")).toThrow("unsupported syntax");
  });

  test("validates IANA timezones", () => {
    expect(() => validateTimezone("America/Chicago")).not.toThrow();
    expect(() => validateTimezone("Not/A_Zone")).toThrow("Invalid IANA timezone");
  });

  test("honors timezone offsets", () => {
    const run = nextRun("0 9 * * *", "America/Chicago", new Date("2026-07-19T00:00:00.000Z"));
    expect(run?.toISOString()).toBe("2026-07-19T14:00:00.000Z");
  });
});

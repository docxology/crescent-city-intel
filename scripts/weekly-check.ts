#!/usr/bin/env bun
/** Thin weekly CLI; durable stage orchestration lives in src/weekly_pipeline.ts. */
import { runWeeklyCheck } from "../src/weekly_pipeline.ts";
import { withTerminationSignal } from "../src/shared/orchestration.ts";
export { classifyCalendarRefresh, type CalendarRefreshResult } from "../src/weekly_pipeline.ts";
if (import.meta.main) {
  try { process.exitCode = await withTerminationSignal(signal => runWeeklyCheck({ signal })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

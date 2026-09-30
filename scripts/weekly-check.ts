#!/usr/bin/env bun
/** Thin weekly CLI; durable stage orchestration lives in src/weekly_pipeline.ts. */
import { runWeeklyCheck } from "../src/weekly_pipeline.ts";
export { classifyCalendarRefresh, type CalendarRefreshResult } from "../src/weekly_pipeline.ts";
if (import.meta.main) process.exitCode = await runWeeklyCheck();

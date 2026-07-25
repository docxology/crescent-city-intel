#!/usr/bin/env bun
/**
 * scripts/run-meetings.ts — Thin orchestrator: government meeting monitor.
 *
 * Imports and runs the government meeting tracking pipeline from
 * src/gov_meeting_monitor.ts. Fetches city council, planning commission,
 * and harbor commission agendas and saves to output/gov_meetings/.
 *
 * Usage:
 *   bun run scripts/run-meetings.ts
 *   bun run gov-meetings
 */
import { monitorGovMeetings } from "../src/gov_meeting_monitor.ts";
import { createLogger } from "../src/logger.ts";
import { readFile } from "fs/promises";
import { paths } from "../src/shared/paths.ts";

const logger = createLogger("run-meetings");

logger.info("=== Government Meeting Monitoring ===");
const items = await monitorGovMeetings();
let health: Array<{ source: string; status: string }> = [];
try {
  const report = JSON.parse(await readFile(paths.govMeetingsHealth, "utf-8")) as { sources?: Array<{ source: string; status: string }> };
  health = report.sources ?? [];
} catch { /* monitor already logged the fetch failure */ }
const missing = health.filter(source => source.status === "unavailable" || source.status === "stale");
logger.info(`Meeting monitor complete: ${items.length} item(s) saved to output/gov_meetings/`, {
  sourceHealth: health.map(source => `${source.source}:${source.status}`),
});
if (missing.length > 0) {
  logger.warn(`${missing.length} meeting source(s) are unavailable or stale; this is recorded as a coverage gap, not a failed run`, {
    sources: missing.map(source => source.source),
  });
}

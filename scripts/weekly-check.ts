#!/usr/bin/env bun
/**
 * scripts/weekly-check.ts — Thin orchestrator: weekly automated health check.
 *
 * A cron-friendly script that:
 *   1. Runs the municipal code change detection monitor
 *   2. Runs all 8 real-time alert monitors
 *   3. Runs news + meeting monitors
 *   4. Computes composite 8-monitor alert severity
 *   5. Summarizes results and exits non-zero if any issues found
 *
 * Usage:
 *   bun run scripts/weekly-check.ts
 *   bun run weekly-check
 *
 * Cron example (every Sunday at 2 AM):
 *   0 2 * * 0 cd /path/to/crescent-city-intel && bun run weekly-check >> output/weekly-check.log 2>&1
 */
import { runMonitor } from "../src/monitor.ts";
import { runAllAlertMonitors } from "./run-alerts.ts";
import { monitorNews } from "../src/news_monitor.ts";
import { monitorGovMeetings } from "../src/gov_meeting_monitor.ts";
import { monitorYouTube } from "../src/youtube_monitor.ts";
import { monitorTriplicate } from "../src/triplicate_monitor.ts";
import { runCuration } from "../src/curation.ts";
import { generateMonthlyReport } from "../src/monthly_report.ts";
import { createLogger } from "../src/logger.ts";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { paths } from "../src/shared/paths.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";
import type { SourceHealth } from "../src/types.ts";

const logger = createLogger("weekly-check");
const startedAt = new Date().toISOString();

logger.info(`=== Weekly Check: ${startedAt} ===`);

// Ensure output/ exists
await mkdir(join(process.cwd(), "output"), { recursive: true });

let exitCode = 0;

// 1. Municipal code change detection
logger.info("Step 1/5: Running municipal code change detection...");
const report = await runMonitor().catch((err: Error) => {
  logger.error("Monitor failed", { error: err.message });
  return null;
});

if (!report) {
  exitCode = Math.max(exitCode, 2);
} else if (report.overallStatus === "changed") {
  logger.warn("⚠️  Municipal code changes detected — review output/monitor-report.json");
  exitCode = Math.max(exitCode, 1);
} else if (report.overallStatus === "error") {
  logger.error("Monitor errored — has the scraper been run? Try: bun run scrape");
  exitCode = Math.max(exitCode, 2);
} else {
  logger.info("✅ Municipal code: no changes detected");
}

// 2. All 8 real-time alert monitors (run concurrently, retain per-task failures)
logger.info("Step 2/5: Polling all 8 real-time alert feeds...");
const alertResult = await runAllAlertMonitors().then(
  sources => ({ status: "fulfilled" as const, value: sources }),
  reason => ({ status: "rejected" as const, reason }),
);
const alertFailures = alertResult.status === "rejected" ? [alertResult] : [];
const degradedAlerts = alertResult.status === "fulfilled"
  ? alertResult.value.filter(source => source.status === "unavailable" || source.status === "stale")
  : [];
if (alertFailures.length > 0) {
  exitCode = Math.max(exitCode, 2);
  logger.error(`${alertFailures.length} alert monitor(s) failed`, { errors: alertFailures.map(result => String(result.reason)) });
} else if (degradedAlerts.length > 0) {
  exitCode = Math.max(exitCode, 1);
  logger.warn(`${degradedAlerts.length} alert source(s) are unavailable or stale`, {
    sources: degradedAlerts.map(source => `${source.source}: ${source.status}`),
  });
} else {
  logger.info("✅ All 8 alert monitors complete");
}

// 3. News + meeting monitors (non-fatal on failure)
logger.info("Step 3/5: Running news and meeting monitors...");
const feedResults = await Promise.allSettled([monitorNews(), monitorGovMeetings()]);
const feedFailures = feedResults.filter(result => result.status === "rejected");
if (feedFailures.length > 0) {
  exitCode = Math.max(exitCode, 2);
  logger.error(`${feedFailures.length} news/meeting monitor(s) failed`, { errors: feedFailures.map(result => String(result.reason)) });
} else {
  logger.info("✅ News and meeting monitors complete; inspect source-health artifacts for empty/unavailable feeds");
}

async function readHealth(path: string): Promise<SourceHealth[]> {
  try {
    const report = JSON.parse(await readFile(path, "utf-8")) as { sources?: SourceHealth[] };
    return Array.isArray(report.sources) ? report.sources : [];
  } catch {
    return [];
  }
}

const feedHealth = (await Promise.all([
  readHealth(paths.newsHealth),
  readHealth(paths.govMeetingsHealth),
])).flat();
const degradedFeeds = feedHealth.filter(source => source.status === "unavailable" || source.status === "stale");
if (degradedFeeds.length > 0) {
  exitCode = Math.max(exitCode, 1);
  logger.warn(`${degradedFeeds.length} news/meeting source(s) are unavailable or stale`, {
    sources: degradedFeeds.map(source => `${source.source}: ${source.status}`),
  });
}

// 4. Compute composite alert severity
logger.info("Step 4/5: Computing composite alert severity and analytics...");
try {
  const { buildAlertAnalytics } = await import("../src/alert_analytics.ts");
  const analytics = buildAlertAnalytics();
  logger.info(`📊 Alert analytics: ${analytics.totalEvents} total events, most active: ${analytics.mostActiveType ?? "none"}`);

  if (analytics.mostRecentAlert) {
    logger.info(`Most recent alert: [${analytics.mostRecentAlert.type}] ${analytics.mostRecentAlert.description}`);
  }
} catch (err: any) {
  logger.warn("Alert analytics failed (non-fatal)", { error: err.message });
}
logger.info("✅ Composite severity computed");

// 5. Transcript, curation, and report surfaces are part of the same health run.
// The source monitors may run concurrently with each other, but curation must
// observe their newly written batches and reporting must observe curation's
// output. Running all four in one Promise.allSettled previously made a healthy
// run silently report the prior cycle's downstream state.
logger.info("Step 5/5: Running transcript, curation, and monthly reporting surfaces...");
const sourceResults = await Promise.allSettled([
  monitorYouTube(10),
  monitorTriplicate(),
]);
const curationResult = await Promise.allSettled([runCuration()]);
const reportResult = await Promise.allSettled([generateMonthlyReport()]);
const downstreamFailures = [
  ...sourceResults,
  ...curationResult,
  ...reportResult,
].filter(result => result.status === "rejected");
if (downstreamFailures.length > 0) {
  exitCode = Math.max(exitCode, 2);
  logger.error(`${downstreamFailures.length} downstream health task(s) failed`, { errors: downstreamFailures.map(result => String(result.reason)) });
}

const downstreamHealth = (await Promise.all([
  readHealth(paths.youtubeHealth),
  readHealth(paths.triplicateHealth),
])).flat();
const degradedDownstream = downstreamHealth.filter(source => source.status === "unavailable" || source.status === "stale");
if (degradedDownstream.length > 0) {
  exitCode = Math.max(exitCode, 1);
  logger.warn(`${degradedDownstream.length} downstream source(s) are unavailable or stale`, {
    sources: degradedDownstream.map(source => `${source.source}: ${source.status}`),
  });
}

// Summary
const completedAt = new Date().toISOString();
const summary = {
  startedAt,
  completedAt,
  monitorStatus: report?.overallStatus ?? "error",
  alertFailures: alertFailures.length,
  degradedAlerts: degradedAlerts.length,
  feedFailures: feedFailures.length,
  degradedFeeds: degradedFeeds.length,
  downstreamFailures: downstreamFailures.length,
  degradedDownstream: degradedDownstream.length,
  exitCode,
};
logger.info("=== Weekly Check Complete ===", summary);

// Write summary to disk for external tooling
const summaryPath = join(process.cwd(), "output", "weekly-check-summary.json");
await writeJsonAtomic(summaryPath, summary);

if (exitCode !== 0) {
  logger.warn(`Exiting with code ${exitCode} — review logs above.`);
}
process.exit(exitCode);

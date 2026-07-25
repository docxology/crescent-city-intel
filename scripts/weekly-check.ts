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
import { writeAnalyticsOverview } from "../src/analytics_backend.ts";
import { createLogger } from "../src/logger.ts";
import { existsSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { paths } from "../src/shared/paths.ts";
import { completeSourceHealth, writeJsonAtomic } from "../src/shared/source_health.ts";
import { writeSourceDiscoveryArtifacts } from "../src/source_registry.ts";
import { buildPipelineRun, createRunId, executePipelineStep, writePipelineRun } from "../src/shared/orchestration.ts";
import type { PipelineStepReport, SourceHealth } from "../src/types.ts";

const logger = createLogger("weekly-check");
const startedAt = new Date().toISOString();
const runId = createRunId("weekly-check", startedAt);
const steps: PipelineStepReport[] = [];

logger.info(`=== Weekly Check: ${startedAt} ===`);

// Ensure output/ exists
await mkdir(join(process.cwd(), "output"), { recursive: true });

let exitCode = 0;

// 1. Municipal code change detection
logger.info("Stage 1/8: Running municipal code change detection...");
const pagesSeedMode = process.env.PAGES_BUILD === "1" && (!existsSync(paths.toc) || !existsSync(paths.manifest));
const monitorExecution = await executePipelineStep("municipal-code-monitor", async () => {
  if (pagesSeedMode) {
    const seedReport = {
      timestamp: new Date().toISOString(),
      articlesChecked: 0,
      hashMismatches: [],
      missingSections: [],
      newSections: [],
      overallStatus: "clean" as const,
      summary: "Live code monitor not run in Pages seed mode; reviewed pages-data is the export baseline.",
    };
    await writeJsonAtomic(paths.monitorReport, seedReport);
    logger.info("✅ Municipal code: live monitor skipped in Pages seed mode; reviewed seed will be exported");
    return seedReport;
  }
  return runMonitor();
}, {
  classify: result => result.overallStatus === "error" ? "failed" : result.overallStatus === "changed" ? "degraded" : "ok",
  outputPaths: [paths.monitorReport],
  ...(pagesSeedMode ? { metadata: { mode: "pages-seed", liveCodeMonitor: "not-run" } } : {}),
});
steps.push(monitorExecution.report);
const report = monitorExecution.value;
if (monitorExecution.report.error) logger.error("Monitor failed", { error: monitorExecution.report.error });

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
logger.info("Stage 2/8: Polling all 8 real-time alert feeds...");
const alertExecution = await executePipelineStep("alert-monitors", () => runAllAlertMonitors(), {
  // A reachable empty source and a missing source are facts about coverage,
  // not failures of this completed monitoring stage.
  classify: _sources => "ok",
  itemCount: sources => sources.length,
  outputPaths: [paths.alertsHealth, "output/alerts/composite/current.json"],
});
steps.push(alertExecution.report);
const alertSources = alertExecution.value ?? [];
const alertFailures = alertExecution.report.status === "failed" ? [alertExecution.report] : [];
const missingAlerts = alertSources.filter(source => source.status === "unavailable" || source.status === "stale");
if (alertFailures.length > 0) {
  exitCode = Math.max(exitCode, 2);
  logger.error(`${alertFailures.length} alert monitor(s) failed`, { errors: alertFailures.map(result => result.error ?? "unknown failure") });
} else if (missingAlerts.length > 0) {
  logger.warn(`${missingAlerts.length} alert source(s) are unavailable or stale; coverage is recorded without failing the run`, {
    sources: missingAlerts.map(source => `${source.source}: ${source.status}`),
  });
} else {
  logger.info("✅ All 8 alert monitors complete");
}

// 3. News + meeting monitors (non-fatal on failure)
logger.info("Stage 3/8: Running news and meeting monitors...");
const feedExecution = await executePipelineStep("news-and-meeting-monitors", () => Promise.allSettled([monitorNews(), monitorGovMeetings()]), {
  classify: results => results.some(result => result.status === "rejected") ? "failed" : "ok",
  outputPaths: [paths.newsHealth, paths.govMeetingsHealth],
});
steps.push(feedExecution.report);
const feedResults = feedExecution.value ?? [];
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
const missingFeeds = feedHealth.filter(source => source.status === "unavailable" || source.status === "stale");
if (missingFeeds.length > 0) {
  logger.warn(`${missingFeeds.length} news/meeting source(s) are unavailable or stale; coverage is recorded without failing the run`, {
    sources: missingFeeds.map(source => `${source.source}: ${source.status}`),
  });
}

// 4. Compute composite alert severity
logger.info("Stage 4/8: Computing composite alert severity and analytics...");
const analyticsExecution = await executePipelineStep("alert-analytics", async () => {
  const { buildAlertAnalytics } = await import("../src/alert_analytics.ts");
  const analytics = buildAlertAnalytics();
  logger.info(`📊 Alert analytics: ${analytics.totalEvents} total events, most active: ${analytics.mostActiveType ?? "none"}`);
  if (analytics.mostRecentAlert) logger.info(`Most recent alert: [${analytics.mostRecentAlert.type}] ${analytics.mostRecentAlert.description}`);
  return analytics;
});
steps.push(analyticsExecution.report);
if (analyticsExecution.report.error) logger.warn("Alert analytics failed (non-fatal)", { error: analyticsExecution.report.error });
logger.info("✅ Composite severity computed");

// 5. Transcript, curation, and report surfaces are part of the same health run.
// The source monitors may run concurrently with each other, but curation must
// observe their newly written batches and reporting must observe curation's
// output. Running all four in one Promise.allSettled previously made a healthy
// run silently report the prior cycle's downstream state.
logger.info("Stages 5–9/9: Running transcript, curation, source discovery, reporting, and unified analytics surfaces...");
const sourceExecution = await executePipelineStep("transcript-and-reference-monitors", () => Promise.all([monitorYouTube(10), monitorTriplicate()]), {
  itemCount: results => results.reduce((sum, result) => sum + result.length, 0),
  outputPaths: [paths.youtubeHealth, paths.triplicateHealth],
});
steps.push(sourceExecution.report);
const curationExecution = await executePipelineStep("llm-curation", () => runCuration(), {
  itemCount: items => items.length,
  outputPaths: [paths.curationReport, paths.curated],
});
steps.push(curationExecution.report);
const sourceDiscoveryExecution = await executePipelineStep("source-discovery", () => writeSourceDiscoveryArtifacts({
  probe: process.env.SOURCE_DISCOVERY_LIVE_CHECK === "1",
}), {
  classify: _result => "ok",
  itemCount: result => result.sourceCount,
  outputPaths: [paths.sourceRegistry, paths.sourceDiscovery, paths.sourceDiscoverySeen],
});
steps.push(sourceDiscoveryExecution.report);
const reportExecution = await executePipelineStep("monthly-report", () => generateMonthlyReport(), {
  outputPaths: [paths.reports, paths.latestReportMetadata],
});
steps.push(reportExecution.report);
const overviewExecution = await executePipelineStep("analytics-overview", () => writeAnalyticsOverview({ summarize: true }), {
  // A provider outage is retained in the analytics LLM envelope and falls
  // back to the deterministic summary; it is not a failed pipeline stage.
  classify: overview => overview.status === "unavailable" ? "failed" : overview.status === "degraded" ? "degraded" : "ok",
  outputPaths: [paths.analyticsOverview],
  metadata: { contract: "shared-local-pages", promptVersion: "2026-07-24-analytics-overview-v1" },
});
steps.push(overviewExecution.report);
if (overviewExecution.report.error) logger.warn("Unified analytics overview failed", { error: overviewExecution.report.error });
const failedSteps = steps.filter(step => step.status === "failed");
if (failedSteps.length > 0) {
  exitCode = Math.max(exitCode, 2);
  logger.error(`${failedSteps.length} pipeline stage(s) failed`, { errors: failedSteps.map(result => result.error ?? "unknown failure") });
}

const downstreamHealth = (await Promise.all([
  readHealth(paths.youtubeHealth),
  readHealth(paths.triplicateHealth),
])).flat();
const missingDownstream = downstreamHealth.filter(source => source.status === "unavailable" || source.status === "stale");
if (missingDownstream.length > 0) {
  logger.warn(`${missingDownstream.length} downstream source(s) are unavailable or stale; coverage is recorded without failing the run`, {
    sources: missingDownstream.map(source => `${source.source}: ${source.status}`),
  });
}

// Summary
const completedAt = new Date().toISOString();
const summary = {
  schemaVersion: "1.0.0",
  runId,
  pipeline: "weekly-check",
  startedAt,
  completedAt,
  monitorStatus: report?.overallStatus ?? "error",
  alertFailures: alertFailures.length,
  missingAlerts: missingAlerts.length,
  degradedAlerts: missingAlerts.length,
  feedFailures: feedFailures.length,
  missingFeeds: missingFeeds.length,
  degradedFeeds: missingFeeds.length,
  downstreamFailures: failedSteps.length,
  missingDownstream: missingDownstream.length,
  degradedDownstream: missingDownstream.length,
  stepCount: steps.length,
  steps: steps.map(step => ({ name: step.name, status: step.status, durationMs: step.durationMs, error: step.error })),
  exitCode,
};
const allHealth = [...alertSources, ...feedHealth, ...downstreamHealth];
const completeHealth = completeSourceHealth(allHealth, completedAt);
const pipelineRun = buildPipelineRun("weekly-check", runId, startedAt, steps, completeHealth, exitCode, completedAt);
logger.info("=== Weekly Check Complete ===", summary);

// Write summary to disk for external tooling
const summaryPath = paths.weeklyCheckSummary;
await writeJsonAtomic(summaryPath, { ...summary, status: pipelineRun.status, sourceHealth: pipelineRun.sourceHealth, metadata: pipelineRun.metadata });
await writePipelineRun(paths.pipelineRun, pipelineRun);

if (exitCode !== 0) {
  logger.warn(`Exiting with code ${exitCode} — review logs above.`);
}
process.exit(exitCode);

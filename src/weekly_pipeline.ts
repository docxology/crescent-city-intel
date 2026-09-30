#!/usr/bin/env bun
/**
 * scripts/weekly-check.ts — Thin orchestrator: weekly automated health check.
 *
 * A cron-friendly script that:
 *   1. Runs the municipal code change detection monitor
 *   2. Runs all 20 real-time alert monitors (8 core + 12 extended)
 *   3. Runs news + meeting monitors
 *   4. Computes composite 20-monitor alert severity
 *   5. Summarizes results and exits non-zero if any issues found
 *
 * Usage:
 *   bun run scripts/weekly-check.ts
 *   bun run weekly-check
 *
 * Cron example (every Sunday at 2 AM):
 *   0 2 * * 0 cd /path/to/crescent-city-intel && bun run weekly-check >> output/weekly-check.log 2>&1
 */
import { runMonitor } from "./monitor.ts";
import { refreshEvents } from "./events.ts";
import { runAllAlertMonitors } from "./alerts/batch.ts";
import { monitorNews } from "./news_monitor.ts";
import { monitorGovMeetings } from "./gov_meeting_monitor.ts";
import { monitorYouTube } from "./youtube_monitor.ts";
import { monitorTriplicate } from "./triplicate_monitor.ts";
import { closeBrowser } from "./browser.ts";
import { runCuration } from "./curation.ts";
import { generateMonthlyReport } from "./monthly_report.ts";
import { writeAnalyticsOverview } from "./analytics_backend.ts";
import { createLogger } from "./logger.ts";
import { existsSync } from "fs";
import { mkdir, readdir, readFile } from "fs/promises";
import { join } from "path";
import { acquireFileLease } from "./shared/storage.ts";
import { paths, outputRoot } from "./shared/paths.ts";
import { completeSourceHealth, writeJsonAtomic } from "./shared/source_health.ts";
import { writeSourceDiscoveryArtifacts } from "./source_registry.ts";
import { buildPipelineRun, createRunId, executePipelineStep, writePipelineRun } from "./shared/orchestration.ts";
import type { PipelineStepReport, SourceHealth } from "./types.ts";

const logger = createLogger("weekly-check");
/** What a completed community-calendar refresh produced, as read back from disk. */
export type CalendarRefreshResult = { artifactRead: boolean; eventCount: number; inputItems: number };

/**
 * Classify a community-calendar refresh (R3 P2 — this replaced
 * `classify: () => "ok"`, which reported a clean stage for every outcome).
 *
 *   failed   — no readable artifact, or zero events out of a non-empty input
 *              set: the merge is broken, not the week.
 *   degraded — zero events out of zero inputs: an honest empty calendar.
 *   ok       — events were produced.
 *
 * Exported so the honesty rule can be executed by a test instead of read.
 */
export function classifyCalendarRefresh(result: CalendarRefreshResult): "ok" | "degraded" | "failed" {
  if (!result.artifactRead) return "failed";
  if (result.eventCount === 0) return result.inputItems > 0 ? "failed" : "degraded";
  return "ok";
}

export async function runWeeklyCheck(): Promise<number> {
  const release = await acquireFileLease(join(paths.state, "weekly-check.lock"), { waitMs: 1000 });
  const attemptPath = join(paths.state, "latest-pipeline-attempt.json");
  try {
const startedAt = new Date().toISOString();
const runId = createRunId("weekly-check", startedAt);
const steps: PipelineStepReport[] = [];
await writeJsonAtomic(attemptPath, { runId, pipeline: "weekly-check", startedAt, status: "running" });
const step: typeof executePipelineStep = (name, task, options = {}) => executePipelineStep(name, task, { ...options, receiptPath: join(paths.state, "pipeline-runs", runId, `${name}.json`) });

logger.info(`=== Weekly Check: ${startedAt} ===`);

// Ensure output/ exists
await mkdir(outputRoot(), { recursive: true });

let exitCode = 0;

// 1. Municipal code change detection
logger.info("Stage 1/8: Running municipal code change detection...");
const pagesSeedMode = process.env.PAGES_BUILD === "1" && (!existsSync(paths.toc) || !existsSync(paths.manifest));
const monitorExecution = await step("municipal-code-monitor", async () => {
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

// 2. All 20 real-time alert monitors (8 core + 12 extended; run concurrently, retain per-task failures)
logger.info("Stage 2/8: Polling all 20 real-time alert feeds...");
const alertExecution = await step("alert-monitors", () => runAllAlertMonitors({ notifications: !Bun.argv.includes("--no-notifications") }), {
  // A reachable empty source and a missing source are facts about coverage, not
  // failures of this completed monitoring stage — but a stage where NO monitor
  // came back usable is not "ok" either, which is what the old `() => "ok"` said.
  classify: sources => (sources.length === 0 ? "failed" : sources.every(source => source.status === "unavailable" || source.status === "stale") ? "degraded" : "ok"),
  itemCount: sources => sources.length,
  outputPaths: [paths.alertsHealth, join(outputRoot(), "alerts", "composite", "current.json")],
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
  logger.info("✅ All 20 alert monitors complete");
}

// 3. News + meeting monitors (non-fatal on failure)
logger.info("Stage 3/8: Running news and meeting monitors...");
const feedExecution = await step("news-and-meeting-monitors", () => Promise.allSettled([
  Promise.resolve().then(() => monitorNews()).catch((error: unknown) => { throw error; }),
  Promise.resolve().then(() => monitorGovMeetings()).catch((error: unknown) => { throw error; }),
]), {
  classify: results => results.some(result => result.status === "rejected") ? "failed" : "ok",
  outputPaths: [paths.newsHealth, paths.govMeetingsHealth],
});
steps.push(feedExecution.report);
const feedResults = feedExecution.value ?? [];
// Conditional-expression narrowing keeps `result` a rejected result inside the
// true branch — no type predicate needed (predicate narrowing did not survive
// the allSettled tuple union here).
const feedFailureReasons = feedResults.flatMap(result =>
  result.status === "rejected" ? [String(result.reason)] : [],
);
if (feedFailureReasons.length > 0) {
  exitCode = Math.max(exitCode, 2);
  logger.error(`${feedFailureReasons.length} news/meeting monitor(s) failed`, { errors: feedFailureReasons });
} else {
  logger.info("✅ News and meeting monitors complete; inspect source-health artifacts for empty/unavailable feeds");
}

/**
 * Count the records in a monitor's batch directory. Used to tell an honest empty
 * calendar (no inputs) apart from a broken merge (inputs present, no output).
 */
async function countBatchItems(directory: string): Promise<number> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".json") || name === "source-health.json") continue;
    const parsed = await readFile(join(directory, name), "utf-8").then(text => JSON.parse(text) as { items?: unknown }, () => null);
    if (parsed && Array.isArray(parsed.items)) total += parsed.items.length;
  }
  return total;
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
const analyticsExecution = await step("alert-analytics", async () => {
  const { buildAlertAnalytics } = await import("./alert_analytics.ts");
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
const sourceExecution = await step("transcript-and-reference-monitors", () => Promise.all([monitorYouTube(10), monitorTriplicate()]), {
  itemCount: results => results.reduce((sum, result) => sum + result.length, 0),
  outputPaths: [paths.youtubeHealth, paths.triplicateHealth],
});
steps.push(sourceExecution.report);
const curationExecution = await step("llm-curation", () => runCuration(), {
  itemCount: items => items.length,
  outputPaths: [paths.curationReport, paths.curated],
});
steps.push(curationExecution.report);
const sourceDiscoveryExecution = await step("source-discovery", () => writeSourceDiscoveryArtifacts({
  probe: process.env.SOURCE_DISCOVERY_LIVE_CHECK === "1",
}), {
  // `classify: () => "ok"` reported a completed discovery stage even when the
  // registry came back empty — the one outcome that means discovery did not work.
  classify: result => (result.sourceCount > 0 ? "ok" : "failed"),
  itemCount: result => result.sourceCount,
  outputPaths: [paths.sourceRegistry, paths.sourceDiscovery, paths.sourceDiscoverySeen],
});
steps.push(sourceDiscoveryExecution.report);
// Community-calendar refresh: merge monitor artifacts + discovered calendar
// feeds into output/events/events.json (+ events.ics) so the published
// snapshot's events slice is regenerated on every weekly cycle, not stale.
const eventsArtifactPath = join(paths.output ?? "output", "events", "events.json");
const eventsExecution = await step("community-calendar-events", async () => {
  await refreshEvents([]);
  // The step's success is what the run produced, not that the process returned.
  // `classify: () => "ok"` and `itemCount: () => 1` reported a green stage with
  // one item even when the refresh wrote no calendar at all, so the artifact it
  // claims to have written is read back and counted here.
  const artifact = await readFile(eventsArtifactPath, "utf-8").then(
    text => JSON.parse(text) as { events?: unknown },
    () => null,
  );
  const events = artifact && Array.isArray(artifact.events) ? artifact.events : null;
  // Zero events only tells the truth next to the inputs it was built from. The
  // calendar is merged out of the meeting, news and YouTube batches plus the
  // discovery artifact (events.ts provenance.deterministicFrom); an empty
  // calendar built from a non-empty input set is a broken merge, not a quiet
  // week, and must not be recorded as a completed stage.
  const inputCounts = await Promise.all([
    countBatchItems(paths.govMeetings),
    countBatchItems(join(paths.output ?? "output", "news")),
    countBatchItems(join(paths.output ?? "output", "youtube")),
  ]);
  const inputItems = inputCounts.reduce((total, count) => total + count, 0);
  return {
    artifactRead: events !== null,
    eventCount: events ? events.length : 0,
    inputItems,
  };
}, {
  classify: classifyCalendarRefresh,
  itemCount: result => result.eventCount,
  outputPaths: [eventsArtifactPath],
});
steps.push(eventsExecution.report);
if (eventsExecution.report.error) logger.warn("Community calendar refresh failed (non-fatal)", { error: eventsExecution.report.error });
else if (!eventsExecution.value?.artifactRead) logger.error(`Community calendar refresh wrote no readable artifact at ${eventsArtifactPath}`);
else if (eventsExecution.value.eventCount === 0 && eventsExecution.value.inputItems > 0) logger.error(`Community calendar refresh produced zero events from ${eventsExecution.value.inputItems} input record(s) — the merge is broken, not the week`);
else if (eventsExecution.value.eventCount === 0) logger.warn("Community calendar refreshed with zero events; no calendar inputs were collected this cycle");
else logger.info(`✅ Community calendar refreshed: ${eventsExecution.value.eventCount} event(s)`);
const reportExecution = await step("monthly-report", () => generateMonthlyReport(), {
  outputPaths: [paths.reports, paths.latestReportMetadata],
});
steps.push(reportExecution.report);
const overviewExecution = await step("analytics-overview", () => writeAnalyticsOverview({ summarize: true }), {
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
  feedFailures: feedFailureReasons.length,
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
await writeJsonAtomic(attemptPath, { runId, pipeline: "weekly-check", startedAt, completedAt, status: "complete", result: pipelineRun.status });

if (exitCode !== 0) {
  logger.warn(`Exiting with code ${exitCode} — review logs above.`);
}
return exitCode;
  } catch (error) {
    await writeJsonAtomic(attemptPath, { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    // The programmatic Triplicate producer shares a browser with this run.
    // Close it while the run still owns its lease, including early failures.
    try { await closeBrowser(); } finally { await release(); }
  }
}

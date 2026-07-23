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
import { monitorNOAATsunamiAlerts } from "../src/alerts/noaa_tsunami.ts";
import { monitorUSGSEarthquakeAlerts } from "../src/alerts/usgs_earthquake.ts";
import { monitorNWSWeatherAlerts } from "../src/alerts/nws_weather.ts";
import { runAirQualityMonitor } from "../src/alerts/epa_airnow.ts";
import { runWildfireMonitor } from "../src/alerts/calfire_wildfire.ts";
import { runMarineMonitor } from "../src/alerts/ndbc_marine.ts";
import { monitorNews } from "../src/news_monitor.ts";
import { monitorGovMeetings } from "../src/gov_meeting_monitor.ts";
import { createLogger } from "../src/logger.ts";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const logger = createLogger("weekly-check");
const startedAt = new Date().toISOString();

logger.info(`=== Weekly Check: ${startedAt} ===`);

// Ensure output/ exists
await mkdir(join(process.cwd(), "output"), { recursive: true });

let exitCode = 0;

// 1. Municipal code change detection
logger.info("Step 1/4: Running municipal code change detection...");
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

// 2. All 8 real-time alert monitors (run concurrently, non-fatal on failure)
logger.info("Step 2/4: Polling all 8 real-time alert feeds...");
await Promise.allSettled([
  monitorNOAATsunamiAlerts().catch((err: Error) => logger.error("NOAA tsunami monitor failed", { error: err.message })),
  monitorUSGSEarthquakeAlerts().catch((err: Error) => logger.error("USGS earthquake monitor failed", { error: err.message })),
  monitorNWSWeatherAlerts().catch((err: Error) => logger.error("NWS weather monitor failed", { error: err.message })),
  runAirQualityMonitor().catch((err: Error) => logger.error("EPA air quality monitor failed", { error: err.message })),
  runWildfireMonitor().catch((err: Error) => logger.error("CAL FIRE wildfire monitor failed", { error: err.message })),
  runMarineMonitor().catch((err: Error) => logger.error("NDBC marine monitor failed", { error: err.message })),
  import("../src/alerts/noaa_tides.ts").then(() => {}).catch(() => {}),
  import("../src/alerts/cdfw_fishing.ts").then(() => {}).catch(() => {}),
]);
logger.info("✅ All 8 alert monitors complete");

// 3. News + meeting monitors (non-fatal on failure)
logger.info("Step 3/4: Running news and meeting monitors...");
await Promise.allSettled([
  monitorNews().catch((err: Error) => logger.error("News monitor failed", { error: err.message })),
  monitorGovMeetings().catch((err: Error) => logger.error("Gov meeting monitor failed", { error: err.message })),
]);
logger.info("✅ News and meeting monitors complete");

// 4. Compute composite alert severity
logger.info("Step 4/4: Computing composite alert severity...");
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

// Summary
const completedAt = new Date().toISOString();
const summary = {
  startedAt,
  completedAt,
  monitorStatus: report?.overallStatus ?? "error",
  exitCode,
};
logger.info("=== Weekly Check Complete ===", summary);

// Write summary to disk for external tooling
const summaryPath = join(process.cwd(), "output", "weekly-check-summary.json");
await writeFile(summaryPath, JSON.stringify(summary, null, 2));

if (exitCode !== 0) {
  logger.warn(`Exiting with code ${exitCode} — review logs above.`);
}
process.exit(exitCode);

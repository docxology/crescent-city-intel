#!/usr/bin/env bun
/**
 * scripts/run-alerts.ts — Thin orchestrator: run all 8 alert monitors.
 *
 * Imports and calls the alert monitoring functions from src/alerts/*, then
 * delegates ALL composite-input shaping and source-health classification to
 * src/alerts/composite.ts (so this script stays thin per scripts/AGENTS.md —
 * no business logic, just orchestration + persistence). `buildTidesInput`
 * and `buildFishingInput` are re-exported here purely for backward-compatible
 * unit-test imports; their real implementation lives in composite.ts.
 *
 * A single advisory lock prevents overlapping runs (e.g. two cron firings)
 * from double-processing the same alert events across processes.
 *
 * Usage:
 *   bun run scripts/run-alerts.ts
 *   bun run alerts
 *   bun run alerts:all
 */
import { monitorNOAATsunamiAlerts } from "../src/alerts/noaa_tsunami.ts";
import { monitorUSGSEarthquakeAlerts } from "../src/alerts/usgs_earthquake.ts";
import { monitorNWSWeatherAlerts } from "../src/alerts/nws_weather.ts";
import { AIRNOW_PUBLIC_KML_URL, getLastAirQualityError, runAirQualityMonitor } from "../src/alerts/epa_airnow.ts";
import { CALFIRE_API_URL, getLastWildfireError, runWildfireMonitor } from "../src/alerts/calfire_wildfire.ts";
import { runMarineMonitor } from "../src/alerts/ndbc_marine.ts";
import { monitorTides, type TideReport } from "../src/alerts/noaa_tides.ts";
import { monitorFishing, type FishingReport } from "../src/alerts/cdfw_fishing.ts";
import { computeAlertSeverity } from "../src/alerts/severity.ts";
import {
  buildCompositeInput,
  buildTidesInput,
  buildFishingInput,
  classifySourceHealth,
  type AlertMonitorDefinition,
} from "../src/alerts/composite.ts";
import { createLogger } from "../src/logger.ts";
import { readFile, mkdir, unlink, open, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { SourceHealth } from "../src/types.ts";
import { paths } from "../src/shared/paths.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";
import { maybeSendSeverityWebhook } from "../src/alerts/notify.ts";
import { runHealingCycle } from "../src/alerts/healer.ts";
import { sendPushNotification } from "../src/notifications/push.ts";

export { buildTidesInput, buildFishingInput };

const logger = createLogger("alerts");

/** Advisory lock path + staleness for preventing concurrent alert runs. */
const ALERTS_LOCK_PATH = join(process.cwd(), "output", "state", "alerts-run.lock");
const ALERTS_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

/** Acquire an exclusive alert-run lock; stale locks from terminated runs are recoverable. */
async function acquireAlertsLock(): Promise<() => Promise<void>> {
  await mkdir(join(process.cwd(), "output", "state"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(ALERTS_LOCK_PATH, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => { await unlink(ALERTS_LOCK_PATH).catch(() => undefined); };
    } catch (error: any) {
      if (error?.code !== "EEXIST" || attempt > 0) {
        throw new Error("An alert run is already in progress; retry after it completes.");
      }
      const lockStats = await stat(ALERTS_LOCK_PATH).catch(() => null);
      if (!lockStats || Date.now() - lockStats.mtimeMs <= ALERTS_LOCK_STALE_MS) {
        throw new Error("An alert run is already in progress; retry after it completes.");
      }
      await unlink(ALERTS_LOCK_PATH).catch(() => undefined);
    }
  }
  throw new Error("Unable to acquire alert run lock");
}

// Guarded so importing this module (e.g. from a test, to reach the pure
// functions above) never triggers 8 real monitor runs as a side effect.
if (import.meta.main) {
  const health = await runAllAlertMonitors();
  if (health.some(source => source.status === "unavailable" || source.status === "stale")) {
    logger.info("Alert monitors completed with coverage gaps; source states are recorded in output/alerts/source-health.json", {
      missingSources: health.filter(source => source.status === "unavailable" || source.status === "stale").map(source => source.source),
    });
  }
}

export async function runAllAlertMonitors(): Promise<SourceHealth[]> {
  const releaseLock = await acquireAlertsLock();
  try {
    logger.info("=== Running All 8 Alert Monitors ===");

    const monitorErrors = new Map<number, string>();
    function runNullableMonitor<T>(
      index: number,
      label: string,
      monitor: () => Promise<T | null>,
      lastError: () => string | undefined,
    ): Promise<T | null> {
      return monitor()
        .then(report => {
          if (report === null) monitorErrors.set(index, lastError() ?? "Monitor returned no report");
          return report;
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          monitorErrors.set(index, message);
          logger.error(`${label} monitor failed`, { error: message });
          return null;
        });
    }

    const settledResults = await Promise.allSettled([
      monitorNOAATsunamiAlerts().catch((err) => { logger.error("NOAA tsunami monitor failed", { error: err.message }); throw err; }),
      monitorUSGSEarthquakeAlerts().catch((err) => { logger.error("USGS earthquake monitor failed", { error: err.message }); throw err; }),
      monitorNWSWeatherAlerts().catch((err) => { logger.error("NWS weather monitor failed", { error: err.message }); throw err; }),
      runNullableMonitor(3, "EPA air quality", runAirQualityMonitor, getLastAirQualityError),
      runNullableMonitor(4, "CAL FIRE wildfire", runWildfireMonitor, getLastWildfireError),
      runNullableMonitor(5, "NDBC marine", runMarineMonitor, () => undefined),
      monitorTides().catch((err) => { logger.error("NOAA tides monitor failed", { error: err.message }); return null; }),
      monitorFishing().catch((err) => { logger.error("CDFW fishing monitor failed", { error: err.message }); return null; }),
    ]);

    const [tidesResult, fishingResult] = settledResults.slice(6) as [
      PromiseSettledResult<TideReport | null>,
      PromiseSettledResult<FishingReport | null>,
    ];
    const tidesReport: TideReport | null =
      tidesResult.status === "fulfilled" ? tidesResult.value : null;
    const fishingReport: FishingReport | null =
      fishingResult.status === "fulfilled" ? fishingResult.value : null;

    // ─── Compute composite severity ───────────────────────────────────
    logger.info("Computing 8-monitor composite alert severity...");

    // Remove any prior snapshot when a feed failed this run.
    const currentTypes = ["tsunami", "earthquake", "weather", "airquality", "wildfire", "marine"];
    for (const [index, type] of currentTypes.entries()) {
      const result = settledResults[index];
      const failed = result.status === "rejected" ||
        (result.status === "fulfilled" && index >= 3 && result.value === null);
      if (failed) await unlink(join(process.cwd(), "output", "alerts", type, "current.json")).catch(() => {});
    }

    async function readCurrentFile(type: string): Promise<any | null> {
      const filePath = join(process.cwd(), "output", "alerts", type, "current.json");
      if (!existsSync(filePath)) return null;
      try { return JSON.parse(await readFile(filePath, "utf-8")); } catch { return null; }
    }

    const [tsunami, earthquake, weather, airquality, wildfire, marine] = await Promise.all([
      readCurrentFile("tsunami"),
      readCurrentFile("earthquake"),
      readCurrentFile("weather"),
      readCurrentFile("airquality"),
      readCurrentFile("wildfire"),
      readCurrentFile("marine"),
    ]);

    const compositeInput = buildCompositeInput({ tsunami, earthquake, weather, airquality, wildfire, marine, tidesReport, fishingReport });

    const severityReport = computeAlertSeverity(
      compositeInput.tsunami,
      compositeInput.earthquake,
      compositeInput.weather,
      compositeInput.tides,
      compositeInput.fishing,
      compositeInput.airQuality,
      compositeInput.wildfire,
      compositeInput.marine,
    );

    logger.info(`Composite alert severity: ${severityReport.level} — ${severityReport.reason}`);

    const severityDir = join(process.cwd(), "output", "alerts", "composite");
    await mkdir(severityDir, { recursive: true });
    await writeJsonAtomic(join(severityDir, "current.json"), severityReport);

    // Optional high-severity webhook (ALERT_WEBHOOK_URL). Fire-and-forget; a
    // webhook failure never fails the alert run.
    await maybeSendSeverityWebhook(severityReport);

    // ─── Self-healing cycle ─────────────────────────────────────────
    // Run the healing cycle after alerts complete. Never throws.
    const healingResult = await runHealingCycle();
    if (healingResult.monitorsRetried.length > 0) {
      logger.info("Healing cycle triggered retries for monitors", { retried: healingResult.monitorsRetried });
      // Also send a push notification for monitors being retried
      await sendPushNotification(
        "Alert Monitor Healing",
        `Retrying ${healingResult.monitorsRetried.length} monitor(s): ${healingResult.monitorsRetried.join(", ")}`,
      ).catch(() => {});
    }
    if (healingResult.monitorsRecovered.length > 0) {
      logger.info("Healing cycle: monitors recovered", { recovered: healingResult.monitorsRecovered });
    }

    const checkedAt = new Date().toISOString();
    const monitorDefinitions: AlertMonitorDefinition[] = [
      { source: "NOAA Tsunami", index: 0, report: tsunami, itemCount: tsunami?.alerts?.length ?? 0, url: "https://api.weather.gov/alerts/active?area=CA", provenance: "NOAA CAP alerts (tsunami Warning/Watch/Advisory)" },
      { source: "USGS Earthquake", index: 1, report: earthquake, itemCount: earthquake?.events?.length ?? 0, url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson", provenance: "USGS GeoJSON feed" },
      { source: "NWS Weather", index: 2, report: weather, itemCount: weather?.alerts?.length ?? 0, url: "https://api.weather.gov/alerts/active?zone=CAZ006", provenance: "NWS active alerts" },
      { source: "NOAA Tides", index: 6, report: tidesReport, itemCount: tidesReport?.predictions?.length ?? 0, url: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9419750", provenance: "NOAA CO-OPS station 9419750" },
      { source: "CDFW Fishing", index: 7, report: fishingReport, itemCount: fishingReport?.bulletins?.length ?? 0, url: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins", provenance: "CDFW North Coast bulletins" },
      { source: "EPA AirNow", index: 3, report: airquality, itemCount: airquality?.readings?.length ?? 0, url: airquality?.provider === "airnow-public-kml" ? AIRNOW_PUBLIC_KML_URL : "https://www.airnowapi.org/aq/observation/zipCode/current/", provenance: airquality?.provider === "airnow-public-kml" ? "EPA AirNow public KML; keyed ZIP API fallback not required" : "EPA AirNow ZIP 95531 API" },
      { source: "CAL FIRE Wildfire", index: 4, report: wildfire, itemCount: wildfire?.incidents?.length ?? 0, url: CALFIRE_API_URL, provenance: "CAL FIRE current active-incident JSON feed" },
      { source: "NDBC Marine", index: 5, report: marine, itemCount: marine?.observations?.length ?? 0, url: "https://www.ndbc.noaa.gov/data/realtime2/", provenance: "NDBC monitored buoys" },
    ];

    const alertSources: SourceHealth[] = monitorDefinitions.map(definition =>
      classifySourceHealth(definition, settledResults[definition.index], monitorErrors, checkedAt));

    await writeJsonAtomic(paths.alertsHealth, { checkedAt, sources: alertSources });

    logger.info("=== All 8 Alert Monitors Complete ===");
    return alertSources;
  } finally {
    await releaseLock();
  }
}

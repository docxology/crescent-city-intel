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
  MONITOR_KEYS,
  NULL_ON_FAILURE_MONITORS,
  buildCompositeInput,
  buildExtendedCompositeInput,
  buildExtendedMonitorDefinitions,
  buildFishingInput,
  buildTidesInput,
  classifySourceHealth,
  type AlertMonitorDefinition,
  type MonitorKey,
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
import { runDroughtMonitor, getLastDroughtError } from "../src/alerts/usdm_drought.ts";
import { runPSPSMonitor, getLastPspsError } from "../src/alerts/pge_psps.ts";
import { runSmokeMonitor, getLastSmokeError } from "../src/alerts/hrrr_smoke.ts";
import { runRoadClosureMonitor, getLastRoadsError } from "../src/alerts/caltrans_roads.ts";
import { runSchoolClosureMonitor, getLastSchoolsError } from "../src/alerts/dusd_schools.ts";
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
    logger.info("=== Running All 13 Alert Monitors ===");

    const monitorErrors = new Map<MonitorKey, string>();
    function runNullableMonitor<T>(
      key: MonitorKey,
      label: string,
      monitor: () => Promise<T | null>,
      lastError: () => string | undefined,
    ): Promise<T | null> {
      return monitor()
        .then(report => {
          if (report === null) monitorErrors.set(key, lastError() ?? "Monitor returned no report");
          return report;
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          monitorErrors.set(key, message);
          logger.error(`${label} monitor failed`, { error: message });
          return null;
        });
    }

    // Keyed batch: each monitor's identity is its key, not where it sits here.
    const batch: Array<{ key: MonitorKey; run: () => Promise<unknown> }> = [
      { key: "tsunami", run: () => monitorNOAATsunamiAlerts().catch((err) => { logger.error("NOAA tsunami monitor failed", { error: err.message }); throw err; }) },
      { key: "earthquake", run: () => monitorUSGSEarthquakeAlerts().catch((err) => { logger.error("USGS earthquake monitor failed", { error: err.message }); throw err; }) },
      { key: "weather", run: () => monitorNWSWeatherAlerts().catch((err) => { logger.error("NWS weather monitor failed", { error: err.message }); throw err; }) },
      { key: "airquality", run: () => runNullableMonitor("airquality", "EPA air quality", runAirQualityMonitor, getLastAirQualityError) },
      { key: "wildfire", run: () => runNullableMonitor("wildfire", "CAL FIRE wildfire", runWildfireMonitor, getLastWildfireError) },
      { key: "marine", run: () => runNullableMonitor("marine", "NDBC marine", runMarineMonitor, () => undefined) },
      { key: "tides", run: () => monitorTides().catch((err) => { logger.error("NOAA tides monitor failed", { error: err.message }); return null; }) },
      { key: "fishing", run: () => monitorFishing().catch((err) => { logger.error("CDFW fishing monitor failed", { error: err.message }); return null; }) },
      // Phase-12 extended monitors: same graceful-degradation contract —
      // a live-feed failure records source health and never fails the run.
      { key: "drought", run: () => runNullableMonitor("drought", "USDM drought", runDroughtMonitor, getLastDroughtError) },
      { key: "psps", run: () => runNullableMonitor("psps", "PG&E PSPS", runPSPSMonitor, getLastPspsError) },
      { key: "smoke", run: () => runNullableMonitor("smoke", "HRRR smoke", runSmokeMonitor, getLastSmokeError) },
      { key: "roads", run: () => runNullableMonitor("roads", "Caltrans roads", runRoadClosureMonitor, getLastRoadsError) },
      { key: "schools", run: () => runNullableMonitor("schools", "DUSD schools", runSchoolClosureMonitor, getLastSchoolsError) },
    ];
    if (batch.length !== MONITOR_KEYS.length || batch.some((entry, position) => entry.key !== MONITOR_KEYS[position])) {
      throw new Error(`alert batch does not match MONITOR_KEYS: [${batch.map(entry => entry.key).join(", ")}]`);
    }
    const settledResults = await Promise.allSettled(batch.map(entry => entry.run()));
    const resultsByKey = Object.fromEntries(batch.map((entry, position) => [entry.key, settledResults[position]!])) as Record<MonitorKey, PromiseSettledResult<unknown>>;

    /** A monitor's fulfilled value, by key — never by position. */
    const settledValue = (key: MonitorKey): unknown => {
      const result = resultsByKey[key];
      return result && result.status === "fulfilled" ? result.value : null;
    };
    const tidesReport = settledValue("tides") as TideReport | null;
    const fishingReport = settledValue("fishing") as FishingReport | null;

    // ─── Compute composite severity ───────────────────────────────────
    logger.info("Computing 13-monitor composite alert severity...");

    // Remove any prior snapshot when a feed failed this run.
    const currentTypes: MonitorKey[] = ["tsunami", "earthquake", "weather", "airquality", "wildfire", "marine"];
    for (const type of currentTypes) {
      const result = resultsByKey[type];
      const failed = result.status === "rejected" ||
        (result.status === "fulfilled" && NULL_ON_FAILURE_MONITORS.has(type) && result.value === null);
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
    // The five Phase-12 monitors ran in this same batch; their reports are in
    // memory. They used to stop here — computeAlertSeverity takes thirteen
    // inputs and was handed eight, so drought, PSPS, smoke, road closures and
    // school closures defaulted to "nothing happening" in the composite level
    // the front page presents, however loudly their own artifacts said otherwise.
    const extendedInput = buildExtendedCompositeInput({
      drought: settledValue("drought"),
      psps: settledValue("psps"),
      smoke: settledValue("smoke"),
      roads: settledValue("roads"),
      schools: settledValue("schools"),
    });

    const severityReport = computeAlertSeverity(
      compositeInput.tsunami,
      compositeInput.earthquake,
      compositeInput.weather,
      compositeInput.tides,
      compositeInput.fishing,
      compositeInput.airQuality,
      compositeInput.wildfire,
      compositeInput.marine,
      extendedInput.drought as Parameters<typeof computeAlertSeverity>[8],
      extendedInput.psps as Parameters<typeof computeAlertSeverity>[9],
      extendedInput.smoke as Parameters<typeof computeAlertSeverity>[10],
      extendedInput.roads as Parameters<typeof computeAlertSeverity>[11],
      extendedInput.schools as Parameters<typeof computeAlertSeverity>[12],
    );

    logger.info(`Composite alert severity: ${severityReport.level} — ${severityReport.reason}`);

    // Optional high-severity webhook (ALERT_WEBHOOK_URL). Fire-and-forget; a
    // webhook failure never fails the alert run. The composite snapshot is
    // persisted once, after the healing summary is attached below, so the
    // artifact always carries the healer state.
    await maybeSendSeverityWebhook(severityReport);

    // ─── Self-healing cycle ─────────────────────────────────────────
    // Run the healing cycle after alerts complete. Never throws.
    const healingResult = await runHealingCycle();
    // Attach the healing summary the severity contract advertises
    // (AlertSeverityReport.healer was declared but never populated before)
    // and re-persist the composite snapshot so the artifact carries it.
    severityReport.healer = {
      lastCycleRun: healingResult.cycleRun,
      monitorsRetried: healingResult.monitorsRetried,
      monitorsRecovered: healingResult.monitorsRecovered,
      monitorsWithFailures: Object.values(healingResult.state.monitors)
        .filter(entry => entry.consecutiveFailures > 0).length,
    };
    const severityDir = join(process.cwd(), "output", "alerts", "composite");
    await mkdir(severityDir, { recursive: true });
    await writeJsonAtomic(join(severityDir, "current.json"), severityReport);
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
      { source: "NOAA Tsunami", key: "tsunami", report: tsunami, itemCount: tsunami?.alerts?.length ?? 0, url: "https://api.weather.gov/alerts/active?area=CA", provenance: "NOAA CAP alerts (tsunami Warning/Watch/Advisory)" },
      { source: "USGS Earthquake", key: "earthquake", report: earthquake, itemCount: earthquake?.events?.length ?? 0, url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson", provenance: "USGS GeoJSON feed" },
      { source: "NWS Weather", key: "weather", report: weather, itemCount: weather?.alerts?.length ?? 0, url: "https://api.weather.gov/alerts/active?zone=CAZ006", provenance: "NWS active alerts" },
      { source: "NOAA Tides", key: "tides", report: tidesReport, itemCount: tidesReport?.predictions?.length ?? 0, url: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9419750", provenance: "NOAA CO-OPS station 9419750" },
      { source: "CDFW Fishing", key: "fishing", report: fishingReport, itemCount: fishingReport?.bulletins?.length ?? 0, url: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins", provenance: "CDFW North Coast bulletins" },
      { source: "EPA AirNow", key: "airquality", report: airquality, itemCount: airquality?.readings?.length ?? 0, url: airquality?.provider === "airnow-public-kml" ? AIRNOW_PUBLIC_KML_URL : "https://www.airnowapi.org/aq/observation/zipCode/current/", provenance: airquality?.provider === "airnow-public-kml" ? "EPA AirNow public KML; keyed ZIP API fallback not required" : "EPA AirNow ZIP 95531 API" },
      { source: "CAL FIRE Wildfire", key: "wildfire", report: wildfire, itemCount: wildfire?.incidents?.length ?? 0, url: CALFIRE_API_URL, provenance: "CAL FIRE current active-incident JSON feed" },
      { source: "NDBC Marine", key: "marine", report: marine, itemCount: marine?.observations?.length ?? 0, url: "https://www.ndbc.noaa.gov/data/realtime2/", provenance: "NDBC monitored buoys" },
      ...buildExtendedMonitorDefinitions(resultsByKey),
    ];

    const alertSources: SourceHealth[] = monitorDefinitions.map(definition =>
      classifySourceHealth(definition, resultsByKey[definition.key], monitorErrors, checkedAt));

    await writeJsonAtomic(paths.alertsHealth, { checkedAt, sources: alertSources });

    logger.info("=== All 13 Alert Monitors Complete ===");
    return alertSources;
  } finally {
    await releaseLock();
  }
}

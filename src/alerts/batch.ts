#!/usr/bin/env bun
/**
 * scripts/run-alerts.ts — Thin orchestrator: run all 20 alert monitors (15 base
 * monitors + the 2026-09-28 permits/dredging/fuel/pacfin/ais expansion).
 *
 * Imports and calls the alert monitoring functions from src/alerts/*, then
 * delegates ALL composite-input shaping and source-health classification to
 * src/alerts/composite.ts (so this script stays thin per scripts/AGENTS.md —
 * no business logic, just orchestration + persistence).
 *
 * A single advisory lock prevents overlapping runs (e.g. two cron firings)
 * from double-processing the same alert events across processes.
 *
 * Usage:
 *   bun run scripts/run-alerts.ts
 *   bun run alerts
 *   bun run alerts:all
 */
import { monitorNOAATsunamiAlerts } from "./noaa_tsunami.ts";
import { monitorUSGSEarthquakeAlerts } from "./usgs_earthquake.ts";
import { monitorNWSWeatherAlerts } from "./nws_weather.ts";
import { AIRNOW_PUBLIC_KML_URL, getLastAirQualityError, runAirQualityMonitor } from "./epa_airnow.ts";
import { CALFIRE_API_URL, getLastWildfireError, runWildfireMonitor } from "./calfire_wildfire.ts";
import { runMarineMonitor, getLastMarineError } from "./ndbc_marine.ts";
import { monitorTides, type TideReport } from "./noaa_tides.ts";
import { monitorFishing, type FishingReport } from "./cdfw_fishing.ts";
import { computeAlertSeverity } from "./severity.ts";
import {
  MONITOR_KEYS,
  NULL_ON_FAILURE_MONITORS,
  buildCompositeInput,
  buildExtendedCompositeInput,
  buildExtendedMonitorDefinitions,
  classifySourceHealth,
  type AlertMonitorDefinition,
  type MonitorKey,
} from "./composite.ts";
import { runMarineZoneMonitor, getLastMarineZoneError } from "./nws_marine.ts";
import { runUscgBroadcastMonitor, getLastUscgError } from "./uscg_broadcasts.ts";
import { runPermitsMonitor, getLastPermitsError } from "./permits.ts";
import { runDredgingMonitor, getLastDredgingError } from "./dredging.ts";
import { runFuelMonitor, getLastFuelError } from "./fuel.ts";
import { runPacfinMonitor, getLastPacfinError } from "./pacfin.ts";
import { runAisMonitor, getLastAisError } from "./ais.ts";
import { createLogger } from "../logger.ts";
import { readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { SourceHealth } from "../types.ts";
import { paths, outputRoot } from "../shared/paths.ts";
import { acquireFileLease } from "../shared/storage.ts";
import { writeJsonAtomic, sourceHealth } from "../shared/source_health.ts";
import { maybeSendSeverityWebhook } from "./notify.ts";
import { runHealingCycle } from "./healer.ts";
import { runDroughtMonitor, getLastDroughtError } from "./usdm_drought.ts";
import { runPSPSMonitor, getLastPspsError } from "./pge_psps.ts";
import { runSmokeMonitor, getLastSmokeError } from "./hrrr_smoke.ts";
import { runRoadClosureMonitor, getLastRoadsError } from "./caltrans_roads.ts";
import { runSchoolClosureMonitor, getLastSchoolsError } from "./dusd_schools.ts";
import { sendPushNotification } from "../notifications/push.ts";

const logger = createLogger("alerts");

export async function runAllAlertMonitors(options?: { only?: MonitorKey[]; notifications?: boolean }): Promise<SourceHealth[]> {
  const selected = options?.only;
  if (selected && (!selected.length || new Set(selected).size !== selected.length || selected.some(key => !MONITOR_KEYS.includes(key)))) throw new Error("--only requires a nonempty unique set of known monitor keys");
  const releaseLock = await acquireFileLease(join(outputRoot(), "state", "alerts-run.lock"), { waitMs: 1000 });
  const startedAt = new Date().toISOString(); const runId = crypto.randomUUID();
  const attemptPath = join(outputRoot(), "state", "latest-alert-run.json");
  try {
    await writeJsonAtomic(attemptPath, { runId, startedAt, status: "running", requested: selected ?? MONITOR_KEYS });
    logger.info(`=== Running ${selected?.length ?? MONITOR_KEYS.length} Alert Monitors ===`);

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
    const selectedKeys = options?.only;
    if (selectedKeys) {
      const unknown = selectedKeys.filter(key => !MONITOR_KEYS.includes(key));
      if (unknown.length > 0) throw new Error(`unknown monitor key(s): ${unknown.join(", ")}`);
    }
    const batch: Array<{ key: MonitorKey; run: () => Promise<unknown> }> = [
      { key: "tsunami", run: () => monitorNOAATsunamiAlerts().catch((err) => { logger.error("NOAA tsunami monitor failed", { error: err.message }); throw err; }) },
      { key: "earthquake", run: () => monitorUSGSEarthquakeAlerts().catch((err) => { logger.error("USGS earthquake monitor failed", { error: err.message }); throw err; }) },
      { key: "weather", run: () => monitorNWSWeatherAlerts().catch((err) => { logger.error("NWS weather monitor failed", { error: err.message }); throw err; }) },
      { key: "airquality", run: () => runNullableMonitor("airquality", "EPA air quality", runAirQualityMonitor, getLastAirQualityError) },
      { key: "wildfire", run: () => runNullableMonitor("wildfire", "CAL FIRE wildfire", runWildfireMonitor, getLastWildfireError) },
      { key: "marine", run: () => runNullableMonitor("marine", "NDBC marine", runMarineMonitor, getLastMarineError) },
      { key: "marinezone", run: () => runNullableMonitor("marinezone", "NWS marine forecast", runMarineZoneMonitor, getLastMarineZoneError) },
      { key: "tides", run: () => monitorTides().catch((err) => { logger.error("NOAA tides monitor failed", { error: err.message }); return null; }) },
      { key: "fishing", run: () => monitorFishing().catch((err) => { logger.error("CDFW fishing monitor failed", { error: err.message }); return null; }) },
      // Phase-12 extended monitors: same graceful-degradation contract —
      // a live-feed failure records source health and never fails the run.
      { key: "drought", run: () => runNullableMonitor("drought", "USDM drought", runDroughtMonitor, getLastDroughtError) },
      { key: "psps", run: () => runNullableMonitor("psps", "PG&E PSPS", runPSPSMonitor, getLastPspsError) },
      { key: "smoke", run: () => runNullableMonitor("smoke", "NOAA HMS smoke", runSmokeMonitor, getLastSmokeError) },
      { key: "roads", run: () => runNullableMonitor("roads", "Caltrans roads", runRoadClosureMonitor, getLastRoadsError) },
      { key: "schools", run: () => runNullableMonitor("schools", "DUSD schools", runSchoolClosureMonitor, getLastSchoolsError) },
      { key: "uscg", run: () => runNullableMonitor("uscg", "USCG broadcasts", runUscgBroadcastMonitor, getLastUscgError) },
      { key: "permits", run: () => runNullableMonitor("permits", "Permit portal", runPermitsMonitor, getLastPermitsError) },
      { key: "dredging", run: () => runNullableMonitor("dredging", "Harbor dredging", runDredgingMonitor, getLastDredgingError) },
      { key: "fuel", run: () => runNullableMonitor("fuel", "EIA fuel price", runFuelMonitor, getLastFuelError) },
      { key: "pacfin", run: () => runNullableMonitor("pacfin", "PacFIN reports", runPacfinMonitor, getLastPacfinError) },
      { key: "ais", run: () => runNullableMonitor("ais", "AIS vessel traffic", runAisMonitor, getLastAisError) },
    ];
    if (batch.length !== MONITOR_KEYS.length || batch.some((entry, position) => entry.key !== MONITOR_KEYS[position])) {
      throw new Error(`alert batch does not match MONITOR_KEYS: [${batch.map(entry => entry.key).join(", ")}]`);
    }
    const runnableBatch = selectedKeys ? batch.filter(entry => selectedKeys.includes(entry.key)) : batch;
    const settledResults = await Promise.allSettled(runnableBatch.map(entry => entry.run()));
    const resultsByKey = Object.fromEntries(MONITOR_KEYS.map(key => [key, { status: "fulfilled", value: null }])) as Record<MonitorKey, PromiseSettledResult<unknown>>;
    for (let position = 0; position < runnableBatch.length; position++) resultsByKey[runnableBatch[position]!.key] = settledResults[position]!;
    for (const key of MONITOR_KEYS.filter(key => !runnableBatch.some(entry => entry.key === key))) {
      try {
        const directory = join(outputRoot(), key === "tides" || key === "fishing" ? key : `alerts/${key}`);
        const filename = key === "tides" || key === "fishing" ? (await import("node:fs/promises")).readdir(directory).then(names => names.filter(name => name.startsWith(`${key}-`) && name.endsWith(".json")).sort().at(-1)) : Promise.resolve("current.json");
        const latest = await filename;
        if (latest) resultsByKey[key] = { status: "fulfilled", value: JSON.parse(await readFile(join(directory, latest), "utf8")) };
      } catch { /* no prior report remains explicitly unknown */ }
    }

    /** A monitor's fulfilled value, by key — never by position. */
    const settledValue = (key: MonitorKey): unknown => {
      const result = resultsByKey[key];
      return result && result.status === "fulfilled" ? result.value : null;
    };
    const fishingReport = settledValue("fishing") as FishingReport | null;
    // Tides is read from its settled batch result like every other monitor. It
    // was referenced as a bare `tidesReport` identifier that nothing declared,
    // so every live `bun run alerts` / `bun run weekly-check` run died with
    // "tidesReport is not defined" at the composite step. The deterministic
    // suite never exercised that path, so only a real run surfaced it.
    const tidesReport = settledValue("tides") as TideReport | null;

    // ─── Compute composite severity ───────────────────────────────────
    logger.info("Computing 20-monitor composite alert severity...");

    async function readCurrentFile(type: string): Promise<any | null> {
      const result = resultsByKey[type as MonitorKey];
      if (result.status === "rejected" || NULL_ON_FAILURE_MONITORS.has(type as MonitorKey) && result.status === "fulfilled" && result.value === null && runnableBatch.some(entry => entry.key === type)) return null;
      const filePath = join(outputRoot(), "alerts", type, "current.json");
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
    // The extended monitors ran in this same batch; their reports are in
    // memory. They used to stop here — computeAlertSeverity takes fourteen
    // inputs and was handed eight, so the extended monitors defaulted to
    // "nothing happening" in the composite level the front page presents,
    // however loudly their own artifacts said otherwise.
    const extendedInput = buildExtendedCompositeInput({
      drought: settledValue("drought"),
      psps: settledValue("psps"),
      smoke: settledValue("smoke"),
      roads: settledValue("roads"),
      schools: settledValue("schools"),
      marinezone: settledValue("marinezone"),
      uscg: settledValue("uscg"),
      permits: settledValue("permits"),
      dredging: settledValue("dredging"),
      fuel: settledValue("fuel"),
      pacfin: settledValue("pacfin"),
      ais: settledValue("ais"),
    });
    // The composite severity now takes all twenty inputs: the extended
    // reports (shaped by buildExtendedCompositeInput) feed the composite like
    // the core monitors. All advisory-class traffic (BNM, permits, harbor
    // posts, fuel, PacFIN, AIS) can raise the composite to WATCH but never
    // manufacture a WARNING on its own.

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
      extendedInput.marinezone as Parameters<typeof computeAlertSeverity>[13],
      extendedInput.uscg as Parameters<typeof computeAlertSeverity>[14],
      extendedInput.permits as Parameters<typeof computeAlertSeverity>[15],
      extendedInput.dredging as Parameters<typeof computeAlertSeverity>[16],
      extendedInput.fuel as Parameters<typeof computeAlertSeverity>[17],
      extendedInput.pacfin as Parameters<typeof computeAlertSeverity>[18],
      extendedInput.ais as Parameters<typeof computeAlertSeverity>[19],
    );

    logger.info(`Composite alert severity: ${severityReport.level} — ${severityReport.reason}`);

    // Optional high-severity webhook (ALERT_WEBHOOK_URL). Fire-and-forget; a
    // webhook failure never fails the alert run. The composite snapshot is
    // persisted once, after the healing summary is attached below, so the
    // artifact always carries the healer state.
    if (options?.notifications !== false) await maybeSendSeverityWebhook(severityReport);

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

    let previous: SourceHealth[] = [];
    try { previous = JSON.parse(await readFile(paths.alertsHealth, "utf8")).sources ?? []; } catch { /* never checked */ }
    const alertSources: SourceHealth[] = monitorDefinitions.map(definition => {
      if (!runnableBatch.some(entry => entry.key === definition.key)) {
        const prior = previous.find(source => source.source === definition.source);
        if (!prior) return sourceHealth(definition.source, "unavailable", checkedAt, { url: definition.url, error: "Monitor not requested and no prior source-health receipt exists" });
        const { source, status, checkedAt: priorCheckedAt, ...details } = prior;
        return { ...sourceHealth(source, status, checkedAt, details), checkedAt: priorCheckedAt };
      }
      return classifySourceHealth(definition, resultsByKey[definition.key], monitorErrors, checkedAt);
    });

    await writeJsonAtomic(paths.alertsHealth, { checkedAt, sources: alertSources, attempts: MONITOR_KEYS.map(key => ({ key, requested: runnableBatch.some(entry => entry.key === key) })) });
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
    const severityDir = join(outputRoot(), "alerts", "composite");
    await mkdir(severityDir, { recursive: true });
    await writeJsonAtomic(join(severityDir, "current.json"), severityReport);
    if (healingResult.monitorsRetried.length > 0) {
      // The healer marks monitors *eligible* for retry and assigns a backoff
      // window; it does not re-invoke them. Say so, rather than announcing a
      // retry that this run did not perform — the old wording made every 4-hour
      // backoff step read as a fresh recovery attempt.
      logger.info("Healing cycle marked monitors eligible for retry", { eligible: healingResult.monitorsRetried });
      if (options?.notifications !== false) await sendPushNotification(
        "Alert Monitor Healing",
        `${healingResult.monitorsRetried.length} monitor(s) failing and eligible for retry: ${healingResult.monitorsRetried.join(", ")}`,
      ).catch(() => {});
    }
    if (healingResult.monitorsRecovered.length > 0) {
      logger.info("Healing cycle: monitors recovered", { recovered: healingResult.monitorsRecovered });
    }


    await writeJsonAtomic(attemptPath, { runId, startedAt, completedAt: checkedAt, status: "complete", requested: selected ?? MONITOR_KEYS, outcomes: runnableBatch.map(entry => ({ key: entry.key, status: resultsByKey[entry.key].status, error: monitorErrors.get(entry.key) })) });

    logger.info("=== All 20 Alert Monitors Complete ===");
    return alertSources;
  } catch (error) {
    await writeJsonAtomic(attemptPath, { runId, startedAt, completedAt: new Date().toISOString(), status: "failed", requested: selected ?? MONITOR_KEYS, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await releaseLock();
  }
}

#!/usr/bin/env bun
/**
 * scripts/run-alerts.ts — Thin orchestrator: run all 8 alert monitors.
 *
 * Imports and calls the alert monitoring functions from src/alerts/*.
 * Acts as the single CLI entry point for all real-time alert polling.
 *
 * Usage:
 *   bun run scripts/run-alerts.ts
 *   bun run alerts
 *   bun run alerts:all
 *
 * Or run individual monitors:
 *   bun run alerts:tsunami
 *   bun run alerts:earthquake
 *   bun run alerts:weather
 *   bun run alerts:tides
 *   bun run alerts:fishing
 *   bun run alerts:airquality
 *   bun run alerts:wildfire
 *   bun run alerts:marine
 */
import { monitorNOAATsunamiAlerts } from "../src/alerts/noaa_tsunami.ts";
import { monitorUSGSEarthquakeAlerts } from "../src/alerts/usgs_earthquake.ts";
import { monitorNWSWeatherAlerts } from "../src/alerts/nws_weather.ts";
import { AIRNOW_PUBLIC_KML_URL, getLastAirQualityError, runAirQualityMonitor } from "../src/alerts/epa_airnow.ts";
import { CALFIRE_API_URL, getLastWildfireError, runWildfireMonitor } from "../src/alerts/calfire_wildfire.ts";
import { runMarineMonitor } from "../src/alerts/ndbc_marine.ts";
import { monitorTides, type TideReport } from "../src/alerts/noaa_tides.ts";
import { monitorFishing, type FishingReport } from "../src/alerts/cdfw_fishing.ts";
import { computeAlertSeverity, type TidesInput, type FishingInput } from "../src/alerts/severity.ts";
import { createLogger } from "../src/logger.ts";
import { readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { SourceHealth } from "../src/types.ts";
import { paths } from "../src/shared/paths.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";

const logger = createLogger("alerts");

/**
 * Map a live (or null/failed) tides report into the shape `computeAlertSeverity`
 * expects. Exported and pure so a test can assert the mapping directly — this
 * exact logic is what silently fed static `{available:false}` stubs before
 * 2026-07-24 regardless of real conditions (see TODO.md Phase 5.9).
 * waterLevelFt uses maxPredictedLevel — the same predicted-high figure the
 * monitor's own highTideAlert flag is based on, not the instantaneous
 * observed level, which can read low even on a high-tide-alert day.
 */
export function buildTidesInput(report: TideReport | null): TidesInput {
  return {
    waterLevelFt: report?.maxPredictedLevel ?? null,
    available: !!report,
  };
}

/** Same purpose as `buildTidesInput`, for the fishing/crab-closure monitor. */
export function buildFishingInput(report: FishingReport | null): FishingInput {
  return {
    closureActive: report
      ? !report.crabStatus.commercialOpen || !report.crabStatus.recreationalOpen
      : false,
    closureMessage: report?.crabStatus.statusNote,
    available: !!report,
  };
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
  // Correct exported names are monitorTides/monitorFishing (NOT runTidesMonitor/
  // runFishingMonitor — those never existed). The prior version called them via
  // `m.runTidesMonitor?.()` inside a dynamic import + empty `.catch(() => {})`,
  // so the optional call silently evaluated to `undefined` every run: these two
  // monitors never actually executed under `alerts:all`/`bun run alerts`, and
  // the failure was invisible (confirmed live 2026-07-24 — no tides/fishing log
  // lines ever appeared in an `alerts:all` run despite the script claiming
  // "All 8 Alert Monitors Complete"). Kept as real values here (not just
  // fire-and-forget) because the composite severity calc below needs their
  // reports — previously it always fed static `{available:false}` stubs.
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

// Remove any prior snapshot when a feed failed this run. Serving yesterday's
// alert list as current data is worse than a visible unavailable response.
const currentTypes = ["tsunami", "earthquake", "weather", "airquality", "wildfire", "marine"];
for (const [index, type] of currentTypes.entries()) {
  const result = settledResults[index];
  const failed = result.status === "rejected" ||
    (result.status === "fulfilled" && index >= 3 && result.value === null);
  if (failed) await unlink(join(process.cwd(), "output", "alerts", type, "current.json")).catch(() => {});
}

// Tides/fishing use the reports captured directly from monitorTides()/
// monitorFishing() above (those two monitors persist timestamped files under
// output/tides/ and output/fishing/, not output/alerts/<type>/current.json —
// see /api/monitor/alerts in gui/routes.ts, which special-cases the same two
// directories).
const tidesInput = buildTidesInput(tidesReport);
const fishingInput = buildFishingInput(fishingReport);

// Read current.json from each alert type to feed composite severity
async function readCurrentFile(type: string): Promise<any | null> {
  const filePath = join(process.cwd(), "output", "alerts", type, "current.json");
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(await readFile(filePath, "utf-8")); } catch { return null; }
}

/** A prior successful snapshot is stale once it is older than one hour. */
function isFreshCurrent(report: any | null): boolean {
  const timestamp = report?.fetchedAt ?? report?.timestamp;
  if (!timestamp) return false;
  const ageMs = Date.now() - Date.parse(timestamp);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 60 * 60 * 1000;
}

const [tsunami, earthquake, weather, airquality, wildfire, marine] = await Promise.all([
  readCurrentFile("tsunami"),
  readCurrentFile("earthquake"),
  readCurrentFile("weather"),
  readCurrentFile("airquality"),
  readCurrentFile("wildfire"),
  readCurrentFile("marine"),
]);

const compositeInput = {
  tsunami: {
    warningCount: tsunami?.alerts?.filter((a: any) => a.severity === "Warning").length ?? 0,
    watchCount: tsunami?.alerts?.filter((a: any) => a.severity === "Watch" || a.severity === "Advisory").length ?? 0,
    available: isFreshCurrent(tsunami),
  },
  earthquake: {
    events: (earthquake?.events ?? []).map((e: any) => ({
      magnitude: e.magnitude ?? e.mag ?? 0,
      distanceKm: e.distanceKm ?? 200,
      tsunami: e.tsunami ?? 0,
      place: e.place ?? "",
    })),
    available: isFreshCurrent(earthquake),
  },
  weather: {
    severities: (weather?.alerts ?? []).map((a: any) => a.severity?.toLowerCase() ?? "advisory"),
    count: weather?.alerts?.length ?? 0,
    available: isFreshCurrent(weather),
  },
  tides: tidesInput,
  fishing: fishingInput,
  airQuality: {
    maxAqi: airquality?.maxAqi ?? 0,
    available: isFreshCurrent(airquality) && Array.isArray(airquality?.readings) && airquality.readings.length > 0,
  },
  wildfire: {
    incidentCount: wildfire?.totalIncidents ?? 0,
    hasEvacuationOrders: wildfire?.incidents?.some((i: any) => i.hasEvacuationOrders) ?? false,
    hasLargeFireNearby: wildfire?.incidents?.some((i: any) => i.acres >= 1000 && i.containmentPercent < 50) ?? false,
    available: isFreshCurrent(wildfire),
  },
  marine: {
    waveHeightFt: marine?.observations?.[0]?.waveHeightFt ?? null,
    windSpeedKt: marine?.observations?.[0]?.windSpeedKt ?? null,
    available: isFreshCurrent(marine) && !!marine?.observations?.length,
  },
};

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

// Persist composite severity report
const severityDir = join(process.cwd(), "output", "alerts", "composite");
await mkdir(severityDir, { recursive: true });
await writeJsonAtomic(join(severityDir, "current.json"), severityReport);

const checkedAt = new Date().toISOString();
const monitorDefinitions: Array<{
  source: string;
  index: number;
  report: any | null;
  itemCount: number;
  url: string;
  provenance: string;
}> = [
  { source: "NOAA Tsunami", index: 0, report: tsunami, itemCount: tsunami?.alerts?.length ?? 0, url: "https://api.weather.gov/alerts/active?event=Tsunami+Warning&area=CA", provenance: "NOAA CAP alerts" },
  { source: "USGS Earthquake", index: 1, report: earthquake, itemCount: earthquake?.events?.length ?? 0, url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson", provenance: "USGS GeoJSON feed" },
  { source: "NWS Weather", index: 2, report: weather, itemCount: weather?.alerts?.length ?? 0, url: "https://api.weather.gov/alerts/active?zone=CAZ006", provenance: "NWS active alerts" },
  { source: "NOAA Tides", index: 6, report: tidesReport, itemCount: tidesReport?.predictions?.length ?? 0, url: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9419750", provenance: "NOAA CO-OPS station 9419750" },
  { source: "CDFW Fishing", index: 7, report: fishingReport, itemCount: fishingReport?.bulletins?.length ?? 0, url: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins", provenance: "CDFW North Coast bulletins" },
  { source: "EPA AirNow", index: 3, report: airquality, itemCount: airquality?.readings?.length ?? 0, url: airquality?.provider === "airnow-public-kml" ? AIRNOW_PUBLIC_KML_URL : "https://www.airnowapi.org/aq/observation/zipCode/current/", provenance: airquality?.provider === "airnow-public-kml" ? "EPA AirNow public KML; keyed ZIP API fallback not required" : "EPA AirNow ZIP 95531 API" },
  { source: "CAL FIRE Wildfire", index: 4, report: wildfire, itemCount: wildfire?.incidents?.length ?? 0, url: CALFIRE_API_URL, provenance: "CAL FIRE current active-incident JSON feed" },
  { source: "NDBC Marine", index: 5, report: marine, itemCount: marine?.observations?.length ?? 0, url: "https://www.ndbc.noaa.gov/data/realtime2/", provenance: "NDBC monitored buoys" },
];

const alertSources: SourceHealth[] = monitorDefinitions.map(definition => {
  const result = settledResults[definition.index];
  const failed = result.status === "rejected" ||
    (result.status === "fulfilled" && definition.index >= 3 && result.value === null);
  const fetchedAt = definition.report?.fetchedAt ?? definition.report?.timestamp;
  const fresh = isFreshCurrent(definition.report);
  const status: SourceHealth["status"] = failed
    ? "unavailable"
    : !fresh
      ? "stale"
      : definition.itemCount === 0 ? "empty" : "ok";
  const error = result.status === "rejected"
    ? String(result.reason instanceof Error ? result.reason.message : result.reason)
    : failed ? monitorErrors.get(definition.index) ?? "Monitor returned no report" : undefined;
  return {
    source: definition.source,
    status,
    checkedAt,
    ...(fetchedAt ? { fetchedAt } : {}),
    itemCount: definition.itemCount,
    url: definition.url,
    ...(error ? { error } : {}),
    provenance: definition.provenance,
    ...(fetchedAt ? { ageMs: Math.max(0, Date.now() - Date.parse(fetchedAt)) } : {}),
  };
});
await writeJsonAtomic(paths.alertsHealth, { checkedAt, sources: alertSources });

logger.info("=== All 8 Alert Monitors Complete ===");
return alertSources;
}

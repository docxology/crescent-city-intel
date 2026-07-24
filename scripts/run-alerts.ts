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
import { runAirQualityMonitor } from "../src/alerts/epa_airnow.ts";
import { runWildfireMonitor } from "../src/alerts/calfire_wildfire.ts";
import { runMarineMonitor } from "../src/alerts/ndbc_marine.ts";
import { monitorTides, type TideReport } from "../src/alerts/noaa_tides.ts";
import { monitorFishing, type FishingReport } from "../src/alerts/cdfw_fishing.ts";
import { computeAlertSeverity, type TidesInput, type FishingInput } from "../src/alerts/severity.ts";
import { createLogger } from "../src/logger.ts";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

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
  };
}

// Guarded so importing this module (e.g. from a test, to reach the pure
// functions above) never triggers 8 real monitor runs as a side effect.
if (import.meta.main) {
await runAllAlertMonitors();
}

async function runAllAlertMonitors(): Promise<void> {
logger.info("=== Running All 8 Alert Monitors ===");

const settledResults = await Promise.allSettled([
  monitorNOAATsunamiAlerts().catch((err) => logger.error("NOAA tsunami monitor failed", { error: err.message })),
  monitorUSGSEarthquakeAlerts().catch((err) => logger.error("USGS earthquake monitor failed", { error: err.message })),
  monitorNWSWeatherAlerts().catch((err) => logger.error("NWS weather monitor failed", { error: err.message })),
  runAirQualityMonitor().catch((err) => logger.error("EPA air quality monitor failed", { error: err.message })),
  runWildfireMonitor().catch((err) => logger.error("CAL FIRE wildfire monitor failed", { error: err.message })),
  runMarineMonitor().catch((err) => logger.error("NDBC marine monitor failed", { error: err.message })),
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
  },
  earthquake: {
    events: (earthquake?.events ?? []).map((e: any) => ({
      magnitude: e.magnitude ?? e.mag ?? 0,
      distanceKm: e.distanceKm ?? 200,
      tsunami: e.tsunami ?? 0,
      place: e.place ?? "",
    })),
  },
  weather: {
    severities: (weather?.alerts ?? []).map((a: any) => a.severity?.toLowerCase() ?? "advisory"),
    count: weather?.alerts?.length ?? 0,
  },
  tides: tidesInput,
  fishing: fishingInput,
  airQuality: {
    maxAqi: airquality?.maxAqi ?? 0,
    available: !!airquality,
  },
  wildfire: {
    incidentCount: wildfire?.totalIncidents ?? 0,
    hasEvacuationOrders: wildfire?.incidents?.some((i: any) => i.hasEvacuationOrders) ?? false,
    hasLargeFireNearby: wildfire?.incidents?.some((i: any) => i.acres >= 1000 && i.containmentPercent < 50) ?? false,
  },
  marine: {
    waveHeightFt: marine?.observations?.[0]?.waveHeightFt ?? null,
    windSpeedKt: marine?.observations?.[0]?.windSpeedKt ?? null,
    available: !!marine?.observations?.length,
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
await writeFile(join(severityDir, "current.json"), JSON.stringify(severityReport, null, 2), "utf-8");

logger.info("=== All 8 Alert Monitors Complete ===");
}

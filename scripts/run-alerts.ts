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
import { computeAlertSeverity } from "../src/alerts/severity.ts";
import { createLogger } from "../src/logger.ts";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const logger = createLogger("alerts");

logger.info("=== Running All 8 Alert Monitors ===");

const results = await Promise.allSettled([
  monitorNOAATsunamiAlerts().catch((err) => logger.error("NOAA tsunami monitor failed", { error: err.message })),
  monitorUSGSEarthquakeAlerts().catch((err) => logger.error("USGS earthquake monitor failed", { error: err.message })),
  monitorNWSWeatherAlerts().catch((err) => logger.error("NWS weather monitor failed", { error: err.message })),
  runAirQualityMonitor().catch((err) => logger.error("EPA air quality monitor failed", { error: err.message })),
  runWildfireMonitor().catch((err) => logger.error("CAL FIRE wildfire monitor failed", { error: err.message })),
  runMarineMonitor().catch((err) => logger.error("NDBC marine monitor failed", { error: err.message })),
]);

// Also run tides and fishing (these are standalone scripts)
await Promise.allSettled([
  import("../src/alerts/noaa_tides.ts").then(m => m.runTidesMonitor?.()).catch(() => {}),
  import("../src/alerts/cdfw_fishing.ts").then(m => m.runFishingMonitor?.()).catch(() => {}),
]);

// ─── Compute composite severity ───────────────────────────────────
logger.info("Computing 8-monitor composite alert severity...");

const tsunamiInput = { warningCount: 0, watchCount: 0 };
const earthquakeInput = { events: [] as any[] };
const weatherInput = { severities: [] as any[], count: 0 };
const tidesInput = { waterLevelFt: null as number | null, available: false };
const fishingInput = { closureActive: false };

const airQualityInput = { maxAqi: 0, available: false };
const wildfireInput = { incidentCount: 0, hasEvacuationOrders: false, hasLargeFireNearby: false };
const marineInput = { waveHeightFt: null as number | null, windSpeedKt: null as number | null, available: false };

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

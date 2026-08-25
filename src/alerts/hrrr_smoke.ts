#!/usr/bin/env bun
/**
 * HRRR Smoke Forecast Monitor for Crescent City.
 *
 * Fetches surface PM2.5 smoke forecast data from NOAA HRRR-Smoke / AirFire
 * for the Crescent City area. Covers the next 48-hour forecast period.
 *
 * API: AirFire HRRR-Smoke CONUS surface smoke (BlueSky / NOAA)
 *
 * Usage:
 *   bun run src/alerts/hrrr_smoke.ts
 *
 * Output: output/alerts/smoke/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

const logger = createLogger("hrrr_smoke_alert");

/** BlueSky AirFire HRRR-Smoke surface PM2.5 forecast API (CONUS). */
export const HRRR_SMOKE_API_URL = "https://airfire.org/data/smoke2/forecast/pm25.nc.json";
/** Fallback: AirFire's operational HRRR-Smoke surface PM2.5 endpoint. */
export const HRRR_SMOKE_FALLBACK_URL = "https://airfire.org/data/smoke/forecast/surface/pm25.latest.json";

const CRESCENT_CITY_LAT = 41.7485;
const CRESCENT_CITY_LNG = -124.2028;
const SEARCH_RADIUS_KM = 50;

const HISTORY_DIR = join(process.cwd(), "output", "alerts", "smoke");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
let lastSmokeError: string | undefined;

export function getLastSmokeError(): string | undefined {
  return lastSmokeError;
}

export type SmokeLevel = "GOOD" | "MODERATE" | "UNHEALTHY_SENSITIVE" | "UNHEALTHY" | "VERY_UNHEALTHY" | "HAZARDOUS";

export interface SmokeForecast {
  /** Forecast hour offset from run time */
  hourOffset: number;
  /** Forecast timestamp ISO */
  forecastTime: string;
  /** Surface PM2.5 concentration (micrograms/m3) */
  pm25: number | null;
  /** AQI equivalent based on PM2.5 */
  aqi: number | null;
  /** Severity level */
  level: SmokeLevel;
}

export interface SmokeReport {
  timestamp: string;
  /** Forecasts over the next 48 hours */
  forecasts: SmokeForecast[];
  /** Maximum PM2.5 forecast value */
  maxPm25: number | null;
  /** Peak AQI equivalent */
  peakAqi: number | null;
  /** Peak severity level */
  peakLevel: SmokeLevel;
  /** Whether the report came from primary or fallback source */
  source: "airfire-primary" | "airfire-fallback";
  /** Human-readable summary */
  summary: string;
  /** Health advisory if PM2.5 exceeds safe levels */
  advisory: string | null;
}

const PM25_THRESHOLDS = [
  { max: 12.0, level: "GOOD" as SmokeLevel, aqi: 50 },
  { max: 35.4, level: "MODERATE" as SmokeLevel, aqi: 100 },
  { max: 55.4, level: "UNHEALTHY_SENSITIVE" as SmokeLevel, aqi: 150 },
  { max: 150.4, level: "UNHEALTHY" as SmokeLevel, aqi: 200 },
  { max: 250.4, level: "VERY_UNHEALTHY" as SmokeLevel, aqi: 300 },
  { max: Infinity, level: "HAZARDOUS" as SmokeLevel, aqi: 500 },
];

export function classifyPm25(pm25: number): { level: SmokeLevel; aqi: number } {
  for (const t of PM25_THRESHOLDS) {
    if (pm25 <= t.max) return { level: t.level, aqi: Math.round(t.aqi * (pm25 / t.max)) };
  }
  return { level: "HAZARDOUS", aqi: 500 };
}

export function getSmokeAdvisory(level: SmokeLevel): string | null {
  const advisories: Record<SmokeLevel, string | null> = {
    "GOOD": null,
    "MODERATE": "Air quality is acceptable; unusually sensitive individuals should monitor symptoms.",
    "UNHEALTHY_SENSITIVE": "Sensitive groups (children, elderly, respiratory conditions) should limit outdoor activity.",
    "UNHEALTHY": "Everyone may experience health effects; sensitive groups should avoid outdoor exertion.",
    "VERY_UNHEALTHY": "Health alert: everyone should avoid outdoor exertion. Stay indoors with windows closed.",
    "HAZARDOUS": "Emergency conditions: everyone should stay indoors. Use air purifiers if available.",
  };
  return advisories[level];
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const clamped = Math.max(0, Math.min(1, a));
  return R * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(HISTORY_FILE)) return ids;
  try {
    const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function appendHistory(forecast: SmokeForecast): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const id = "smoke-" + forecast.hourOffset + "h-" + forecast.forecastTime;
    const record = JSON.stringify({ id: id, ...forecast, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE, record);
  } catch (err) {
    logger.warn("Failed to append smoke history", { error: String(err) });
  }
}

function findNearestGridPoint(grid: any[], lat: number, lng: number): { pm25: number; hourOffset: number } | null {
  let nearest: { pm25: number; hourOffset: number; distance: number } | null = null;
  for (const point of grid) {
    const ptLat = Number(point.lat ?? point.latitude ?? 0);
    const ptLng = Number(point.lon ?? point.longitude ?? point.lng ?? 0);
    if (!Number.isFinite(ptLat) || !Number.isFinite(ptLng)) continue;
    const dist = haversineDistance(lat, lng, ptLat, ptLng);
    if (dist > SEARCH_RADIUS_KM) continue;
    const pm25 = Number(point.pm25 ?? point.PM25 ?? point.value ?? 0);
    if (!Number.isFinite(pm25)) continue;
    const hourOff = Number(point.hour ?? point.forecastHour ?? point.hourOffset ?? 0);
    if (nearest && nearest.distance <= dist) continue;
    nearest = { pm25, hourOffset: hourOff, distance: dist };
  }
  return nearest ? { pm25: nearest.pm25, hourOffset: nearest.hourOffset } : null;
}

async function fetchFromUrl(url: string): Promise<SmokeReport> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("HRRR smoke endpoint returned " + response.status + ": " + response.statusText);
  }
  const payload = await response.json() as any;

  // Try to extract grid/data points
  const grid = payload?.grid ?? payload?.data ?? payload?.forecasts ?? payload?.points ?? [];
  const forecasts: SmokeForecast[] = [];
  const isPrimary = url === HRRR_SMOKE_API_URL;

  if (Array.isArray(grid) && grid.length > 0) {
    // Try multi-hour: group by hour
    const hours = new Map<number, number[]>();
    for (const point of grid) {
      const ptLat = Number(point.lat ?? point.latitude ?? 0);
      const ptLng = Number(point.lon ?? point.longitude ?? point.lng ?? 0);
      if (!Number.isFinite(ptLat) || !Number.isFinite(ptLng)) continue;
      const dist = haversineDistance(CRESCENT_CITY_LAT, CRESCENT_CITY_LNG, ptLat, ptLng);
      if (dist > SEARCH_RADIUS_KM) continue;
      const pm25 = Number(point.pm25 ?? point.PM25 ?? point.value ?? 0);
      if (!Number.isFinite(pm25)) continue;
      const hour = Math.round(Number(point.hour ?? point.forecastHour ?? point.hourOffset ?? 0));
      if (!hours.has(hour)) hours.set(hour, []);
      hours.get(hour)!.push(pm25);
    }

    for (const [hour, values] of hours) {
      const avgPm25 = values.reduce((a, b) => a + b, 0) / values.length;
      const { level, aqi } = classifyPm25(avgPm25);
      const forecastTime = new Date(Date.now() + hour * 3600 * 1000).toISOString();
      forecasts.push({
        hourOffset: hour,
        forecastTime,
        pm25: Math.round(avgPm25 * 10) / 10,
        aqi,
        level,
      });
    }
  }

  forecasts.sort((a, b) => a.hourOffset - b.hourOffset);

  const maxForecast = forecasts.length > 0
    ? forecasts.reduce((a, b) => (a.pm25 ?? 0) > (b.pm25 ?? 0) ? a : b)
    : null;

  return {
    timestamp: new Date().toISOString(),
    forecasts,
    maxPm25: maxForecast?.pm25 ?? null,
    peakAqi: maxForecast?.aqi ?? null,
    peakLevel: maxForecast?.level ?? "GOOD",
    source: isPrimary ? "airfire-primary" : "airfire-fallback",
    summary: forecasts.length === 0
      ? "No HRRR smoke forecast data available for Crescent City area"
      : "PM2.5 peak: " + (maxForecast?.pm25?.toFixed(1) ?? "N/A") + " ug/m3 (" + (maxForecast?.level ?? "N/A") + "). " +
        forecasts.length + " forecast hour(s): " +
        forecasts.map(f => f.hourOffset + "h: " + (f.pm25?.toFixed(1) ?? "N/A") + " (" + f.level + ")").join("; "),
    advisory: getSmokeAdvisory(maxForecast?.level ?? "GOOD"),
  };
}

/** Fetch HRRR smoke forecast for Crescent City area. */
export async function fetchSmokeForecast(): Promise<SmokeReport> {
  let primaryError: string | undefined;
  try {
    return await fetchFromUrl(HRRR_SMOKE_API_URL);
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
    logger.warn("HRRR smoke primary endpoint unavailable; trying fallback", { error: primaryError });
  }

  try {
    const fallback = await fetchFromUrl(HRRR_SMOKE_FALLBACK_URL);
    return fallback;
  } catch (err) {
    const fallbackError = err instanceof Error ? err.message : String(err);
    throw new Error("HRRR smoke unavailable: primary (" + (primaryError ?? "not attempted") + "); fallback (" + fallbackError + ")");
  }
}

/** Main monitor entry point */
export async function runSmokeMonitor(): Promise<SmokeReport | null> {
  logger.info("Checking HRRR smoke forecast for Crescent City area");
  lastSmokeError = undefined;

  try {
    const report = await fetchSmokeForecast();
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);

    if (report.forecasts.length > 0) {
      const processedIds = loadProcessedIds();
      for (const f of report.forecasts) {
        const id = "smoke-" + f.hourOffset + "h-" + f.forecastTime;
        if (!processedIds.has(id)) {
          appendHistory(f);
        }
      }
    }

    if (report.peakLevel === "HAZARDOUS" || report.peakLevel === "VERY_UNHEALTHY") {
      logger.warn("SMOKE EMERGENCY: " + report.summary);
    } else if (report.peakLevel === "UNHEALTHY" || report.peakLevel === "UNHEALTHY_SENSITIVE") {
      logger.warn("Smoke advisory: " + report.summary);
    } else {
      logger.info("Smoke check: " + report.summary);
    }

    return report;
  } catch (err: any) {
    lastSmokeError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch smoke forecast data", { error: lastSmokeError });
    return null;
  }
}

if (import.meta.main) {
  runSmokeMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Smoke monitor check failed --- see logs");
  });
}

#!/usr/bin/env bun
/**
 * EPA AirNow Air Quality Monitor for Crescent City.
 *
 * Fetches real-time Air Quality Index (AQI) data from the EPA AirNow API
 * for Crescent City's monitoring area. Tracks PM2.5, ozone, and PM10 levels,
 * issues health advisories based on AQI thresholds, and maintains persistent
 * history.
 *
 * API: https://www.airnowapi.org/aq/observation/zipCode/current/
 * Requires AIRNOW_API_KEY env var (free at airnowapi.org).
 *
 * Usage:
 *   bun run src/alerts/epa_airnow.ts
 *
 * Output: output/alerts/airquality/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { DOMParser } from "@xmldom/xmldom";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic } from "../shared/source_health.js";

const logger = createLogger("epa_airnow_alert");

const CRESCENT_CITY_ZIP = "95531";
const AIRNOW_API_URL = "https://www.airnowapi.org/aq/observation/zipCode/current";
/** Public preliminary AirNow product; unlike the ZIP API it does not require a key. */
export const AIRNOW_PUBLIC_KML_URL = "https://files.airnowtech.org/airnow/today/airnowlatest_pm25aqi.kml";
const CRESCENT_CITY_LAT = 41.7485;
const CRESCENT_CITY_LNG = -124.2028;
const PUBLIC_STATION_RADIUS_KM = 80;

// History persistence
const HISTORY_DIR = join(process.cwd(), "output", "alerts", "airquality");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
let lastAirQualityError: string | undefined;

/** Return the most recent failure without changing the monitor's null-result contract. */
export function getLastAirQualityError(): string | undefined {
  return lastAirQualityError;
}

export type AirQualityLevel = "GOOD" | "MODERATE" | "UNHEALTHY_SENSITIVE" | "UNHEALTHY" | "VERY_UNHEALTHY" | "HAZARDOUS";

export interface AirQualityReading {
  /** Parameter name: PM2.5, O3, PM10 */
  parameter: string;
  /** AQI value (0-500) */
  aqi: number;
  /** AQI category name */
  category: string;
  /** AQI category number (1-6) */
  categoryNumber: number;
  /** Unit of measurement */
  unit: string;
  /** Measured value */
  value: number;
  /** Data source */
  agency: string;
}

export interface AirQualityReport {
  timestamp: string;
  zipCode: string;
  /** Which AirNow transport produced this report. */
  provider: "airnow-api" | "airnow-public-kml";
  readings: AirQualityReading[];
  /** Highest AQI across all parameters */
  maxAqi: number;
  /** Overall severity level based on max AQI */
  level: AirQualityLevel;
  /** Human-readable summary */
  summary: string;
  /** Health advisory if AQI > 100 */
  advisory: string | null;
}

/** Load processed reading IDs from persistent history */
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

/** Append a reading to persistent JSONL history */
function appendHistory(report: AirQualityReport): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const id = `${report.zipCode}-${report.timestamp}`;
    const record = JSON.stringify({ id, ...report });
    appendFileSync(HISTORY_FILE, record + "\n", "utf-8");
  } catch (err) {
    logger.warn("Failed to append air quality history", { error: String(err) });
  }
}

/** Classify AQI value into severity level */
export function classifyAqi(aqi: number): AirQualityLevel {
  if (aqi <= 50) return "GOOD";
  if (aqi <= 100) return "MODERATE";
  if (aqi <= 150) return "UNHEALTHY_SENSITIVE";
  if (aqi <= 200) return "UNHEALTHY";
  if (aqi <= 300) return "VERY_UNHEALTHY";
  return "HAZARDOUS";
}

function categoryNumber(level: AirQualityLevel): number {
  return { GOOD: 1, MODERATE: 2, UNHEALTHY_SENSITIVE: 3, UNHEALTHY: 4, VERY_UNHEALTHY: 5, HAZARDOUS: 6 }[level];
}

/** Generate health advisory message based on AQI level */
export function getAdvisory(level: AirQualityLevel): string | null {
  const advisories: Record<AirQualityLevel, string | null> = {
    "GOOD": null,
    "MODERATE": "Unusually sensitive people should consider reducing prolonged or heavy outdoor exertion.",
    "UNHEALTHY_SENSITIVE": "Sensitive groups (children, elderly, heart/lung disease) should limit outdoor activity.",
    "UNHEALTHY": "Everyone may experience health effects; sensitive groups should avoid outdoor exertion.",
    "VERY_UNHEALTHY": "Health alert: everyone should avoid outdoor exertion. Stay indoors.",
    "HAZARDOUS": "Emergency conditions: everyone should stay indoors and minimize activity.",
  };
  return advisories[level];
}

/** Fetch current air quality from AirNow API */
export async function fetchAirQuality(apiKey?: string): Promise<AirQualityReport> {
  const key = apiKey ?? process.env.AIRNOW_API_KEY;
  let apiError: string | undefined;
  if (key) {
    try {
      const url = `${AIRNOW_API_URL}?format=application/json&zipCode=${CRESCENT_CITY_ZIP}&distance=25&API_KEY=${encodeURIComponent(key)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`AirNow API returned ${response.status}: ${response.statusText}`);
      const data = await response.json() as any[];
      const readings: AirQualityReading[] = Array.isArray(data) ? data.map((obs: any) => ({
        parameter: obs.ParameterName,
        aqi: obs.AQI,
        category: obs.Category.Name,
        categoryNumber: obs.Category.Number,
        unit: obs.Unit,
        value: obs.Value,
        agency: obs.AgencyName,
      })) : [];
      if (readings.length === 0) {
        // The keyed ZIP endpoint succeeded but produced no observation within
        // radius — emitting a maxAqi:0 "GOOD" report here would present "good
        // air" when the sensor simply had no data. Fall through to the public
        // KML product (which honestly says "no observation"), like the
        // network-failure path below.
        throw new Error("AirNow ZIP endpoint returned no current readings within radius");
      }
      const maxAqi = Math.max(...readings.map(r => r.aqi));
      const level = classifyAqi(maxAqi);
      return {
        timestamp: new Date().toISOString(),
        zipCode: CRESCENT_CITY_ZIP,
        provider: "airnow-api",
        readings,
        maxAqi,
        level,
        summary: `AQI ${maxAqi} (${level}) — ${readings.map(r => `${r.parameter}: ${r.aqi}`).join(", ")}`,
        advisory: getAdvisory(level),
      };
    } catch (error) {
      apiError = error instanceof Error ? error.message : String(error);
      logger.warn("AirNow keyed endpoint unavailable; trying public KML product", { error: apiError });
    }
  } else {
    apiError = "AIRNOW_API_KEY env var not set";
  }

  try {
    return await fetchPublicAirNowKml();
  } catch (error) {
    const publicError = error instanceof Error ? error.message : String(error);
    throw new Error(`AirNow keyed endpoint unavailable (${apiError ?? "not attempted"}); public KML fallback failed (${publicError})`);
  }
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  // Clamp a to [0,1] to avoid NaN from floating-point rounding on sqrt(1-a).
  const clamped = Math.max(0, Math.min(1, a));
  return radius * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

function parseKmlAqi(description: string): number | null {
  const match = description.match(/(?:Good|Moderate|Unhealthy for Sensitive Groups|Unhealthy|Very Unhealthy|Hazardous)\s+(\d{1,3})\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Read the keyless public AirNow PM2.5 KML product near Crescent City. */
export async function fetchPublicAirNowKml(): Promise<AirQualityReport> {
  const response = await fetch(AIRNOW_PUBLIC_KML_URL, {
    headers: { Accept: "application/vnd.google-earth.kml+xml, application/xml" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`AirNow public KML returned ${response.status}: ${response.statusText}`);
  const xml = await response.text();
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const placemarks = document.getElementsByTagName("Placemark");
  let nearest: { aqi: number; distanceKm: number; site: string } | null = null;
  for (let index = 0; index < placemarks.length; index += 1) {
    const placemark = placemarks[index];
    const coordinates = placemark.getElementsByTagName("coordinates")[0]?.textContent?.trim() ?? "";
    const [longitudeText, latitudeText] = coordinates.split(",");
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const distanceKm = haversineDistance(CRESCENT_CITY_LAT, CRESCENT_CITY_LNG, latitude, longitude);
    if (distanceKm > PUBLIC_STATION_RADIUS_KM) continue;
    const description = placemark.getElementsByTagName("description")[0]?.textContent ?? "";
    const aqi = parseKmlAqi(description);
    if (aqi === null || (nearest && nearest.distanceKm <= distanceKm)) continue;
    const site = placemark.getElementsByTagName("Snippet")[0]?.textContent?.trim() || "Crescent City-area AirNow station";
    nearest = { aqi, distanceKm, site };
  }

  const timestamp = new Date().toISOString();
  if (!nearest) {
    return {
      timestamp,
      zipCode: CRESCENT_CITY_ZIP,
      provider: "airnow-public-kml",
      readings: [],
      maxAqi: 0,
      level: "GOOD",
      summary: "AirNow public KML was reachable, but it contained no current Crescent City-area PM2.5 observation",
      advisory: null,
    };
  }
  const level = classifyAqi(nearest.aqi);
  return {
    timestamp,
    zipCode: CRESCENT_CITY_ZIP,
    provider: "airnow-public-kml",
    readings: [{ parameter: "PM2.5", aqi: nearest.aqi, category: level, categoryNumber: categoryNumber(level), unit: "AQI", value: nearest.aqi, agency: `AirNow public KML — ${nearest.site}` }],
    maxAqi: nearest.aqi,
    level,
    summary: `AQI ${nearest.aqi} (${level}) — PM2.5 at ${nearest.site}`,
    advisory: getAdvisory(level),
  };
}

/** Main monitor entry point */
export async function runAirQualityMonitor(): Promise<AirQualityReport | null> {
  logger.info("Checking air quality for Crescent City (ZIP 95531)");
  lastAirQualityError = undefined;

  try {
    const report = await fetchAirQuality();
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);
    appendHistory(report);

    if (report.advisory) {
      logger.warn(`Air quality advisory: ${report.summary} — ${report.advisory}`);
    } else {
      logger.info(`Air quality: ${report.summary}`);
    }

    return report;
  } catch (err: any) {
    lastAirQualityError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch air quality data", { error: lastAirQualityError });
    return null;
  }
}

// Run if called directly
if (import.meta.main) {
  runAirQualityMonitor().then(report => {
    if (report) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("Air quality check failed — see logs");
    }
  });
}

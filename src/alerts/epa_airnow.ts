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

const logger = createLogger("epa_airnow_alert");

const CRESCENT_CITY_ZIP = "95531";
const AIRNOW_API_URL = "https://www.airnowapi.org/aq/observation/zipCode/current";

// History persistence
const HISTORY_DIR = join(process.cwd(), "output", "alerts", "airquality");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");

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
  if (!key) {
    throw new Error("AIRNOW_API_KEY env var not set — get a free key at airnowapi.org");
  }

  const url = `${AIRNOW_API_URL}?format=application/json&zipCode=${CRESCENT_CITY_ZIP}&distance=25&API_KEY=${key}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`AirNow API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json() as any[];

  if (!Array.isArray(data) || data.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      zipCode: CRESCENT_CITY_ZIP,
      readings: [],
      maxAqi: 0,
      level: "GOOD",
      summary: "No air quality data available",
      advisory: null,
    };
  }

  const readings: AirQualityReading[] = data.map((obs: any) => ({
    parameter: obs.ParameterName,
    aqi: obs.AQI,
    category: obs.Category.Name,
    categoryNumber: obs.Category.Number,
    unit: obs.Unit,
    value: obs.Value,
    agency: obs.AgencyName,
  }));

  const maxAqi = Math.max(...readings.map(r => r.aqi));
  const level = classifyAqi(maxAqi);
  const advisory = getAdvisory(level);

  const report: AirQualityReport = {
    timestamp: new Date().toISOString(),
    zipCode: CRESCENT_CITY_ZIP,
    readings,
    maxAqi,
    level,
    summary: `AQI ${maxAqi} (${level}) — ${readings.map(r => `${r.parameter}: ${r.aqi}`).join(", ")}`,
    advisory,
  };

  return report;
}

/** Main monitor entry point */
export async function runAirQualityMonitor(): Promise<AirQualityReport | null> {
  logger.info("Checking air quality for Crescent City (ZIP 95531)");

  try {
    const report = await fetchAirQuality();
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeFile(CURRENT_FILE, JSON.stringify(report, null, 2), "utf-8");
    appendHistory(report);

    if (report.advisory) {
      logger.warn(`Air quality advisory: ${report.summary} — ${report.advisory}`);
    } else {
      logger.info(`Air quality: ${report.summary}`);
    }

    return report;
  } catch (err: any) {
    logger.error("Failed to fetch air quality data", { error: err.message });
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

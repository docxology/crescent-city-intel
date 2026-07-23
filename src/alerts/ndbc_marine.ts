#!/usr/bin/env bun
/**
 * NDBC Marine Weather / Buoy Monitor for Crescent City.
 *
 * Fetches real-time marine observations from the nearest NDBC buoy stations
 * to Crescent City Harbor. Tracks wave height, wave period, wind speed,
 * water temperature, and air temperature. Issues advisories for hazardous
 * marine conditions affecting harbor operations.
 *
 * API: https://www.ndbc.noaa.gov/data/realtime2/
 *
 * Nearest buoys to Crescent City:
 *   46027 — St Georges CA (27 NM NW of Crescent City) — primary
 *   46022 — Eel River CA (120 NM S) — secondary
 *   46214 — Humboldt Bay CA (60 NM S) — tsunami-ready DART
 *
 * Usage:
 *   bun run src/alerts/ndbc_marine.ts
 *
 * Output: output/alerts/marine/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const logger = createLogger("ndbc_marine_alert");

const NDBC_BASE_URL = "https://www.ndbc.noaa.gov/data/realtime2";

// Primary buoy stations for Crescent City marine intelligence
const MONITORED_STATIONS = [
  { id: "46027", name: "St Georges CA", lat: 41.85, lng: -124.38, distanceNm: 27 },
  { id: "46022", name: "Eel River CA", lat: 40.72, lng: -124.53, distanceNm: 120 },
  { id: "46214", name: "Humboldt Bay CA", lat: 40.88, lng: -124.36, distanceNm: 60 },
];

const HISTORY_DIR = join(process.cwd(), "output", "alerts", "marine");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");

export type MarineSeverity = "CALM" | "WATCH" | "WARNING" | "EMERGENCY";

export interface BuoyObservation {
  /** NDBC station ID */
  stationId: string;
  /** Station name */
  stationName: string;
  /** Distance from Crescent City (nautical miles) */
  distanceNm: number;
  /** Observation timestamp ISO */
  timestamp: string;
  /** Wind speed (knots) */
  windSpeedKt: number | null;
  /** Wind direction (degrees) */
  windDirectionDeg: number | null;
  /** Wind gust speed (knots) */
  windGustKt: number | null;
  /** Significant wave height (feet) */
  waveHeightFt: number | null;
  /** Dominant wave period (seconds) */
  wavePeriodSec: number | null;
  /** Wave direction (degrees) */
  waveDirectionDeg: number | null;
  /** Water temperature (F) */
  waterTempF: number | null;
  /** Air temperature (F) */
  airTempF: number | null;
  /** Barometric pressure (hPa) */
  pressure: number | null;
}

export interface MarineReport {
  timestamp: string;
  observations: BuoyObservation[];
  /** Primary station ID (nearest) */
  primaryStation: string;
  /** Composite severity level */
  level: MarineSeverity;
  /** Human-readable summary */
  summary: string;
  /** Advisory message if hazardous conditions */
  advisory: string | null;
}

// ─── Thresholds ───────────────────────────────────────────────────
const WAVE_HEIGHT_WARNING_FT = 15;     // High surf — dangerous to small craft
const WAVE_HEIGHT_WATCH_FT = 10;       // Elevated seas — caution
const WIND_SPEED_WARNING_KT = 34;      // Gale force (39+ mph)
const WIND_SPEED_WATCH_KT = 22;        // Strong breeze (25+ mph)
const WAVE_PERIOD_LONG_SEC = 15;       // Long-period swell → tsunami-like surge

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

function appendHistory(obs: BuoyObservation): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const id = `${obs.stationId}-${obs.timestamp}`;
    const record = JSON.stringify({ id, ...obs, fetchedAt: new Date().toISOString() });
    appendFileSync(HISTORY_FILE, record + "\n", "utf-8");
  } catch (err) {
    logger.warn("Failed to append marine history", { error: String(err) });
  }
}

/** Parse a single NDBC realtime data line */
function parseNdbcLine(station: typeof MONITORED_STATIONS[number], line: string): BuoyObservation | null {
  // NDBC realtime format: columns are space-separated with unit headers
  // Standard order: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD BAR ATMP WTMP DEWP VIS PTDY TIDE
  // We only care about specific fields; parse loosely
  const parts = line.trim().split(/\s+/);
  if (parts.length < 15) return null;

  const toNum = (v: string): number | null => {
    if (v === "MM" || v === "" || v === "--") return null;
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  };

  // Year fix: NDBC uses 2-digit year
  const yy = parseInt(parts[0], 10);
  const year = yy < 50 ? 2000 + yy : 1900 + yy;
  const mm = parts[1].padStart(2, "0");
  const dd = parts[2].padStart(2, "0");
  const hh = parts[3].padStart(2, "0");
  const min = parts[4].padStart(2, "0");
  const timestamp = `${year}-${mm}-${dd}T${hh}:${min}:00Z`;

  // Convert wind from m/s to knots (NDBC reports m/s)
  const windMs = toNum(parts[6]);
  const windGustMs = toNum(parts[7]);
  const windSpeedKt = windMs !== null ? windMs * 1.94384 : null;
  const windGustKt = windGustMs !== null ? windGustMs * 1.94384 : null;

  // Wave height from meters to feet
  const waveHeightM = toNum(parts[8]);
  const waveHeightFt = waveHeightM !== null ? waveHeightM * 3.28084 : null;

  const wavePeriodSec = toNum(parts[9]);     // dominant period
  const waveDirectionDeg = toNum(parts[11]);  // mean wave direction
  const pressure = toNum(parts[12]);           // barometric pressure hPa
  const airTempC = toNum(parts[13]);           // air temp C
  const waterTempC = toNum(parts[14]);         // water temp C

  const airTempF = airTempC !== null ? airTempC * 9 / 5 + 32 : null;
  const waterTempF = waterTempC !== null ? waterTempC * 9 / 5 + 32 : null;

  return {
    stationId: station.id,
    stationName: station.name,
    distanceNm: station.distanceNm,
    timestamp,
    windSpeedKt,
    windDirectionDeg: toNum(parts[5]),
    windGustKt,
    waveHeightFt,
    wavePeriodSec,
    waveDirectionDeg,
    waterTempF,
    airTempF,
    pressure,
  };
}

export function classifyMarineSeverity(observations: BuoyObservation[]): {
  level: MarineSeverity;
  advisory: string | null;
} {
  if (observations.length === 0) return { level: "CALM", advisory: null };

  const primary = observations.find(o => o.stationId === "46027") ?? observations[0];

  if (primary.waveHeightFt !== null && primary.waveHeightFt >= WAVE_HEIGHT_WARNING_FT) {
    return {
      level: "WARNING",
      advisory: `Hazardous seas: ${primary.waveHeightFt.toFixed(1)} ft waves at ${primary.stationName}. Small craft should remain in port.`,
    };
  }

  if (primary.windSpeedKt !== null && primary.windSpeedKt >= WIND_SPEED_WARNING_KT) {
    return {
      level: "WARNING",
      advisory: `Gale force winds: ${primary.windSpeedKt.toFixed(0)} kt at ${primary.stationName}. Dangerous conditions for all vessels.`,
    };
  }

  if (primary.waveHeightFt !== null && primary.waveHeightFt >= WAVE_HEIGHT_WATCH_FT) {
    return {
      level: "WATCH",
      advisory: `Elevated seas: ${primary.waveHeightFt.toFixed(1)} ft waves. Small craft exercise caution.`,
    };
  }

  if (primary.windSpeedKt !== null && primary.windSpeedKt >= WIND_SPEED_WATCH_KT) {
    return {
      level: "WATCH",
      advisory: `Strong winds: ${primary.windSpeedKt.toFixed(0)} kt at ${primary.stationName}. Small craft advisory.`,
    };
  }

  if (primary.wavePeriodSec !== null && primary.wavePeriodSec >= WAVE_PERIOD_LONG_SEC) {
    return {
      level: "WATCH",
      advisory: `Long-period swell: ${primary.wavePeriodSec}s period. Potential surge in harbor.`,
    };
  }

  return { level: "CALM", advisory: null };
}

export async function fetchBuoyObservation(station: typeof MONITORED_STATIONS[number]): Promise<BuoyObservation | null> {
  const url = `${NDBC_BASE_URL}/${station.id}.txt`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(`Failed to fetch buoy ${station.id}`, { status: response.status });
      return null;
    }
    const text = await response.text();
    const lines = text.trim().split("\n");
    // First 2 lines are headers, 3rd line is most recent observation
    if (lines.length < 3) return null;
    return parseNdbcLine(station, lines[2]);
  } catch (err: any) {
    logger.warn(`Error fetching buoy ${station.id}`, { error: err.message });
    return null;
  }
}

export async function runMarineMonitor(): Promise<MarineReport | null> {
  logger.info("Fetching NDBC buoy data for Crescent City marine region");

  try {
    const observations: BuoyObservation[] = [];

    for (const station of MONITORED_STATIONS) {
      const obs = await fetchBuoyObservation(station);
      if (obs) {
        observations.push(obs);
        const processedIds = loadProcessedIds();
        const id = `${obs.stationId}-${obs.timestamp}`;
        if (!processedIds.has(id)) {
          appendHistory(obs);
        }
      }
    }

    const { level, advisory } = classifyMarineSeverity(observations);
    const primary = observations.find(o => o.stationId === "46027") ?? observations[0];

    const report: MarineReport = {
      timestamp: new Date().toISOString(),
      observations,
      primaryStation: primary?.stationId ?? "46027",
      level,
      summary: observations.length === 0
        ? "No buoy data available"
        : `${observations.length} station(s): ${observations.map(o =>
            `${o.stationName} ${o.waveHeightFt?.toFixed(1) ?? "—"}ft@${o.wavePeriodSec?.toFixed(0) ?? "—"}s ${o.windSpeedKt?.toFixed(0) ?? "—"}kt`
          ).join("; ")}`,
      advisory,
    };

    await mkdir(HISTORY_DIR, { recursive: true });
    await writeFile(CURRENT_FILE, JSON.stringify(report, null, 2), "utf-8");

    if (advisory) {
      logger.warn(`Marine advisory: ${advisory}`);
    } else {
      logger.info(`Marine check: ${report.summary}`);
    }

    return report;
  } catch (err: any) {
    logger.error("Failed to fetch marine buoy data", { error: err.message });
    return null;
  }
}

if (import.meta.main) {
  runMarineMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Marine check failed — see logs");
  });
}

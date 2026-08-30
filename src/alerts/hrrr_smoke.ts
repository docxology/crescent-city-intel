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
  source: "noaa-hms" | "airfire-primary" | "airfire-fallback";
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
/**
 * NOAA HMS smoke detection (verified live 2026-08-30). The old AirFire
 * HRRR-smoke JSON endpoints now return 404. HMS publishes daily smoke-plume
 * shapefiles at a date-based URL; we read the polygon bounding boxes plus the
 * DBF Density attribute and count plumes overlapping the Del Norte box.
 */
export interface HmsSmokeResult {
  mapDate: string;
  plumes: number;
  maxDensity: "Light" | "Medium" | "Heavy";
}

export const HMS_SMOKE_URL =
  "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/Shapefile/{Y}/{M}/hms_smoke{YMD}.zip";
const DN_BOX = { lonMin: -124.45, latMin: 41.45, lonMax: -123.55, latMax: 42.15 };

/** Minimal ZIP extraction: locate a local file header by name and inflateRaw. */
function zipEntry(zip: Buffer, namePattern: RegExp): Buffer | null {
  const target = zip.indexOf("PK\x03\x04");
  void target;
  let off = 0;
  while (off + 30 <= zip.length) {
    if (zip.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const method = zip.readUInt16LE(off + 8);
    const compressedSize = zip.readUInt32LE(off + 18);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const name = zip.toString("latin1", off + 30, off + 30 + nameLen);
    if (namePattern.test(name)) {
      const dataStart = off + 30 + nameLen + extraLen;
      const raw = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(raw);
      const zlib = require("node:zlib");
      return Buffer.from(zlib.inflateRawSync(raw));
    }
    off = dataStartGuess(off, nameLen, extraLen, compressedSize);
  }
  return null;
}
function dataStartGuess(off: number, nameLen: number, extraLen: number, compressedSize: number): number {
  return off + 30 + nameLen + extraLen + compressedSize;
}

function plumeBboxes(shp: Buffer): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  let off = 100;
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  while (off + 8 <= shp.length) {
    const words = view.getInt32(off + 4, false);
    const len = words * 2;
    if (off + 8 + len > shp.length) break;
    const shapeType = view.getInt32(off + 8, true);
    if (shapeType === 5 || shapeType === 3 || shapeType === 15) {
      out.push([
        view.getFloat64(off + 12, true),
        view.getFloat64(off + 20, true),
        view.getFloat64(off + 28, true),
        view.getFloat64(off + 36, true),
      ]);
    }
    off += 8 + len;
  }
  return out;
}

function dbfRows(dbf: Buffer): Array<Record<string, string>> {
  const count = dbf.readInt32LE(4);
  const headerLen = dbf.readUInt16LE(8);
  const recordLen = dbf.readUInt16LE(10);
  const fields: Array<{ name: string; len: number }> = [];
  let off = 32;
  while (dbf[off] !== 0x0d && off < headerLen - 1) {
    const name = dbf.toString("ascii", off, off + 11).replace(/\0.*$/, "");
    fields.push({ name, len: dbf[off + 16] });
    off += 32;
  }
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < count; i++) {
    const rowStart = headerLen + i * recordLen;
    let p = 1;
    const values: Record<string, string> = {};
    for (const f of fields) {
      values[f.name] = dbf.toString("ascii", rowStart + p, rowStart + p + f.len).trim();
      p += f.len;
    }
    rows.push(values);
  }
  return rows;
}

function densityRank(d: string): number {
  if (/heavy/i.test(d)) return 3;
  if (/medium/i.test(d)) return 2;
  if (/light/i.test(d)) return 1;
  return 0;
}

/** Fetch the newest HMS smoke product (today, then up to 3 days back). */
export async function fetchHmsSmoke(): Promise<HmsSmokeResult | null> {
  for (let back = 0; back <= 3; back++) {
    const day = new Date(Date.now() - back * 24 * 3600 * 1000);
    const ymd = day.toISOString().slice(0, 10).replace(/-/g, "");
    const year = ymd.slice(0, 4);
    const month = ymd.slice(4, 6);
    const url = HMS_SMOKE_URL.replace("{Y}", year).replace("{M}", month).replace("{YMD}", ymd);
    let zip: Buffer;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/zip" },
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      zip = Buffer.from(await response.arrayBuffer());
    } catch {
      continue;
    }
    try {
      const shp = zipEntry(zip, /\.shp$/);
      const dbf = zipEntry(zip, /\.dbf$/);
      if (!shp || !dbf) continue;
      const boxes = plumeBboxes(shp);
      const rows = dbfRows(dbf);
      let plumes = 0;
      let maxRank = 0;
      let maxDensity: HmsSmokeResult["maxDensity"] = "Light";
      for (let i = 0; i < boxes.length && i < rows.length; i++) {
        const [x0, y0, x1, y1] = boxes[i];
        const overlaps = !(x1 < DN_BOX.lonMin || x0 > DN_BOX.lonMax || y1 < DN_BOX.latMin || y0 > DN_BOX.latMax);
        if (!overlaps) continue;
        plumes++;
        const d = (rows[i]?.Density ?? "").trim();
        const rank = densityRank(d);
        if (rank > maxRank) {
          maxRank = rank;
          maxDensity = (d.charAt(0).toUpperCase() + d.slice(1).toLowerCase()) as HmsSmokeResult["maxDensity"];
        }
      }
      if (plumes > 0) {
        return { mapDate: ymd, plumes, maxDensity };
      }
      return { mapDate: ymd, plumes: 0, maxDensity: "Light" };
    } catch (err) {
      logger.warn("HMS zip parse failed for " + ymd, { error: String(err) });
      continue;
    }
  }
  return null;
}

export async function fetchSmokeForecast(): Promise<SmokeReport> {
  // PRIMARY: NOAA HMS smoke plumes (verified live 2026-08-30). Density maps
  // onto PM2.5 guidance bands for the report shape consumers already use.
  const hms = await fetchHmsSmoke();
  if (hms) {
    if (hms.plumes === 0) {
      return {
        timestamp: new Date().toISOString(),
        forecasts: [],
        maxPm25: 0,
        peakAqi: null,
        peakLevel: "GOOD",
        source: "noaa-hms",
        summary: "No NOAA HMS smoke plumes overlap the Del Norte area (map of " + hms.mapDate + ").",
        advisory: getSmokeAdvisory("GOOD"),
      };
    }
    // HMS density bands: Light ~ 10-25 ug/m3, Medium ~ 35-80, Heavy ~ 150+.
    const pm25 = hms.maxDensity === "Heavy" ? 155 : hms.maxDensity === "Medium" ? 55 : 20;
    const { level, aqi } = classifyPm25(pm25);
    return {
      timestamp: new Date().toISOString(),
      forecasts: [{ hourOffset: 0, forecastTime: new Date().toISOString(), pm25, aqi, level }],
      maxPm25: pm25,
      peakAqi: aqi,
      peakLevel: level,
      source: "noaa-hms",
      summary: "NOAA HMS reports " + hms.plumes + " " + hms.maxDensity + "-density smoke plume(s) overlapping the Del Norte area (map of " + hms.mapDate + "). Peak " + level + ".",
      advisory: getSmokeAdvisory(level),
    };
  }

  // FALLBACK: legacy AirFire HRRR-smoke JSON (404 since ~2026-08; retained for
  // service restoration without a code change).
  let primaryError: string | undefined;
  try {
    return await fetchFromUrl(HRRR_SMOKE_API_URL);
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
    logger.warn("HMS unavailable and legacy primary errored; trying legacy fallback", { error: primaryError });
  }
  return await fetchFromUrl(HRRR_SMOKE_FALLBACK_URL);
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

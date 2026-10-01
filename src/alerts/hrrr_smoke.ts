#!/usr/bin/env bun
import { withProducerScope, type ProducerOptions } from "../shared/run_scope.js";
import { boundedHttpFetch as fetch } from "../shared/transport.js";
import { outputRoot } from "../shared/paths.js";
/**
 * NOAA HMS Smoke Plume Monitor for Crescent City.
 *
 * Fetches NOAA HMS smoke-plume maps for the Del Norte area and adapts them
 * into the SmokeReport shape consumed by the alert layer.
 *
 * Source: NOAA HMS smoke-polygon products.
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

function HISTORY_DIR(): string { return join(outputRoot(), "alerts", "smoke"); }
function HISTORY_FILE(): string { return join(HISTORY_DIR(), "history.jsonl"); }
function CURRENT_FILE(): string { return join(HISTORY_DIR(), "current.json"); }
let lastSmokeError: string | undefined;

export function getLastSmokeError(): string | undefined {
  return lastSmokeError;
}

export interface SmokeReport {
  schemaVersion: "2.0.0";
  sourceProduct: "noaa-hms";
  density: "light" | "moderate" | "heavy" | "none" | "unknown";
  productDate: string;
  observedAt: string | null;
  observationStart: string | null;
  observationEnd: string | null;
  fetchedAt: string;
  checkedAt: string;
  validUntil: string;
  plumeCount: number;
  timestamp: string;
  /** HMS supplies no surface-concentration forecasts. */
  forecasts: [];
  /** HMS does not measure surface PM2.5. */
  maxPm25: null;
  /** HMS does not measure AQI. */
  peakAqi: null;
  /** Surface air-quality severity is unknown. */
  peakLevel: "UNKNOWN";
  /** Provider of the smoke-plume map. */
  source: "noaa-hms";
  /** Human-readable summary */
  summary: string;
  /** Product limitation, not an exposure diagnosis. */
  advisory: string | null;
}

/** Historical numeric artifacts retain their original values with an explicit evidence limitation. */
export function legacySmokeDisplay(value: Record<string, unknown>): { evidence: "legacy-inferred-unverified"; original: Record<string, unknown> } {
  return { evidence: "legacy-inferred-unverified", original: structuredClone(value) };
}
export function isHmsSmokeReport(value: unknown): value is SmokeReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return report.schemaVersion === "2.0.0" && report.sourceProduct === "noaa-hms" && report.source === "noaa-hms"
    && ["light", "moderate", "heavy", "none", "unknown"].includes(String(report.density))
    && typeof report.productDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(report.productDate)
    && [report.timestamp, report.fetchedAt, report.checkedAt, report.validUntil].every(time => typeof time === "string" && Number.isFinite(Date.parse(time)))
    && report.timestamp === `${report.productDate}T00:00:00.000Z`
    && new Date(Date.parse(report.timestamp as string)).toISOString().slice(0, 10) === report.productDate
    && Date.parse(report.validUntil as string) - Date.parse(report.timestamp as string) === 86_400_000
    && Date.parse(report.checkedAt as string) >= Date.parse(report.fetchedAt as string)
    && [report.observedAt, report.observationStart, report.observationEnd].every(time => time === null || typeof time === "string" && Number.isFinite(Date.parse(time)))
    && report.maxPm25 === null && report.peakAqi === null && report.peakLevel === "UNKNOWN"
    && Array.isArray(report.forecasts) && report.forecasts.length === 0 && Number.isSafeInteger(report.plumeCount) && Number(report.plumeCount) >= 0
    && typeof report.summary === "string" && (report.advisory === null || typeof report.advisory === "string");
}

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(HISTORY_FILE())) return ids;
  try {
    const lines = readFileSync(HISTORY_FILE(), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return ids;
}

/**
 * NOAA HMS smoke detection (verified live 2026-08-30). HMS publishes daily smoke-plume
 * shapefiles at a date-based URL; we read the polygon bounding boxes plus the
 * DBF Density attribute and count plumes overlapping the Del Norte box.
 */
export interface HmsSmokeResult {
  mapDate: string;
  plumes: number;
  maxDensity: "Light" | "Medium" | "Heavy" | "Unknown";
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
      return Buffer.from(zlib.inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
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
        maxBytes: 32 * 1024 * 1024,
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
      let maxDensity: HmsSmokeResult["maxDensity"] = "Unknown";
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

/** HMS density is a mapped plume observation, never a concentration or forecast. */
export function buildHmsSmokeReport(hms: HmsSmokeResult, fetchedAt = new Date().toISOString()): SmokeReport {
  const productDate = `${hms.mapDate.slice(0, 4)}-${hms.mapDate.slice(4, 6)}-${hms.mapDate.slice(6, 8)}`;
  const timestamp = `${productDate}T00:00:00.000Z`;
  if (!/^\d{8}$/.test(hms.mapDate) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString().slice(0, 10) !== productDate) throw new Error("Invalid HMS product date");
  const density = hms.plumes === 0 ? "none" : hms.maxDensity === "Heavy" ? "heavy" : hms.maxDensity === "Medium" ? "moderate" : hms.maxDensity === "Light" ? "light" : "unknown";
  const peakLevel = "UNKNOWN" as const;
  const summary = hms.plumes === 0
    ? `No mapped HMS plume overlaps Del Norte in product ${productDate}; surface air quality was not measured.`
    : `HMS product ${productDate} maps ${hms.plumes} ${density}-density plume(s) over Del Norte; surface PM2.5 and AQI are unknown.`;
  if (!Number.isSafeInteger(hms.plumes) || hms.plumes < 0 || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("Invalid HMS report input");
  return { schemaVersion: "2.0.0", sourceProduct: "noaa-hms", source: "noaa-hms", density, productDate,
    timestamp, observedAt: null, observationStart: null, observationEnd: null, fetchedAt, checkedAt: fetchedAt,
    validUntil: new Date(Date.parse(timestamp) + 86400000).toISOString(), plumeCount: hms.plumes,
    forecasts: [], maxPm25: null, peakAqi: null, peakLevel, summary,
    advisory: hms.plumes ? "Mapped smoke may affect the area; consult observed air-quality measurements. HMS does not measure surface exposure." : null };
}

export async function fetchSmokeForecast(): Promise<SmokeReport> {
  const hms = await fetchHmsSmoke();
  if (!hms) throw new Error("NOAA HMS smoke-plume product unavailable or unreadable");
  return buildHmsSmokeReport(hms);
}

/** Main monitor entry point */
export async function runSmokeMonitor(options: ProducerOptions = {}): Promise<SmokeReport | null> { return withProducerScope("alert-hrrr-smoke", options, () => runSmokeMonitorInScope()); }
async function runSmokeMonitorInScope(): Promise<SmokeReport | null> {
  logger.info("Checking NOAA HMS smoke plumes for the Del Norte area");
  lastSmokeError = undefined;

  try {
    const report = await fetchSmokeForecast();
    await mkdir(HISTORY_DIR(), { recursive: true });
    await writeJsonAtomic(CURRENT_FILE(), report);
    const id = `hms-${report.productDate}-${report.density}-${report.plumeCount}`;
    if (!loadProcessedIds().has(id)) appendBoundedJsonlSync(HISTORY_FILE(), { id, ...report });
    logger.info("Smoke product: " + report.summary);

    return report;
  } catch (err: any) {
    lastSmokeError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch HMS smoke product", { error: lastSmokeError });
    return null;
  }
}

if (import.meta.main) {
  runSmokeMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Smoke monitor check failed --- see logs");
  });
}

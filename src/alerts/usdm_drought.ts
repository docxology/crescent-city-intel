#!/usr/bin/env bun
import { withProducerScope, type ProducerOptions } from "../shared/run_scope.js";
import { boundedHttpFetch as fetch } from "../shared/transport.js";
import { outputRoot } from "../shared/paths.js";
/**
 * USDM Drought Monitor for Del Norte County.
 *
 * Fetches the US Drought Monitor data from the University of Nebraska-Lincoln
 * and classifies drought severity (D0-D4) for Del Norte County, CA.
 *
 * API: https://usdmdataservices.unl.edu/api/CountyStatistics/
 *
 * Usage:
 *   bun run src/alerts/usdm_drought.ts
 *
 * Output: output/alerts/drought/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

const logger = createLogger("usdm_drought_alert");

/**
 * USDM Data Services county statistics (verified live 2026-08-30). The old
 * droughtmonitor.unl.edu/data/json/USDM_west.json bulk file now returns 404.
 * GetDSCI returns weekly DSCI (0-500) per county as CSV; GetDroughtSeverity-
 * StatisticsByAreaPercent returns per-category (D0-D4) percent-of-area CSV.
 */
export const USDM_API_URL =
  "https://usdmdataservices.unl.edu/api/CountyStatistics/GetDSCI?aoi=06015&startdate={START}&enddate={END}&statisticsType=3";
export const USDM_AREA_PCT_URL =
  "https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent?aoi=06015&startdate={START}&enddate={END}&statisticsType=2";
const TARGET_FIPS = "06015"; // Del Norte County FIPS code
const TARGET_COUNTY = "Del Norte";

function HISTORY_DIR(): string { return join(outputRoot(), "alerts", "drought"); }
function HISTORY_FILE(): string { return join(HISTORY_DIR(), "history.jsonl"); }
function CURRENT_FILE(): string { return join(HISTORY_DIR(), "current.json"); }
let lastDroughtError: string | undefined;

export function getLastDroughtError(): string | undefined {
  return lastDroughtError;
}

export type DroughtSeverity = "NONE" | "D0" | "D1" | "D2" | "D3" | "D4";

export interface DroughtReading {
  fips: string;
  county: string;
  state: string;
  severity: DroughtSeverity;
  percent: number;
}

export interface DroughtReport {
  timestamp: string;
  fetchedAt?: string;
  productDate?: string;
  observedAt?: string;
  validUntil?: string;
  readings: DroughtReading[];
  compositeSeverity: DroughtSeverity;
  severeDroughtPercent: number;
  summary: string;
}

const SEVERITY_SCORE: Record<DroughtSeverity, number> = {
  NONE: 0, D0: 1, D1: 2, D2: 3, D3: 4, D4: 5,
};

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

function appendHistory(readings: DroughtReading[], productDate: string): void {
  try {
    mkdirSync(HISTORY_DIR(), { recursive: true });
    for (const r of readings) {
      const id = r.fips + "-" + r.severity + "-" + productDate;
      const record = JSON.stringify({ id: id, ...r, productDate, observedAt: `${productDate}T00:00:00Z`, fetchedAt: new Date().toISOString() });
      appendBoundedJsonlSync(HISTORY_FILE(), record);
    }
  } catch (err) {
    logger.warn("Failed to append drought history", { error: String(err) });
  }
}

export function classifyDroughtSeverity(category: string): DroughtSeverity {
  const c = category.trim().toUpperCase();
  if (c === "D0") return "D0";
  if (c === "D1") return "D1";
  if (c === "D2") return "D2";
  if (c === "D3") return "D3";
  if (c === "D4") return "D4";
  return "NONE";
}

export function computeDroughtComposite(readings: DroughtReading[]): DroughtSeverity {
  if (readings.length === 0) return "NONE";
  const sorted = [...readings].sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity]);
  for (const r of sorted) {
    if (r.percent >= 1) return r.severity;
  }
  return sorted[0]?.severity ?? "NONE";
}

function csvRows(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function usdmWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 24 * 3600 * 1000);
  const md = (d: Date) => (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + d.getUTCFullYear();
  return { start: md(start), end: md(end) };
}

export async function fetchDroughtData(): Promise<DroughtReport> {
  const { start, end } = usdmWindow();
  const url = USDM_AREA_PCT_URL.replace("{START}", start).replace("{END}", end);
  const response = await fetch(url, {
    headers: { Accept: "text/csv" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("USDM API returned " + response.status + ": " + response.statusText);
  }
  const text = await response.text();
  const rows = csvRows(text);
  const dated = rows.filter(row => row.FIPS === TARGET_FIPS).map(row => ({ row, date: /^\d{8}$/.test(row.MapDate ?? "") ? `${row.MapDate.slice(0, 4)}-${row.MapDate.slice(4, 6)}-${row.MapDate.slice(6, 8)}` : row.MapDate }));
  if (dated.some(item => !/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? "") || !Number.isFinite(Date.parse(`${item.date}T00:00:00Z`)) || new Date(`${item.date}T00:00:00Z`).toISOString().slice(0, 10) !== item.date || Date.parse(`${item.date}T00:00:00Z`) > Date.now())) throw new Error("USDM county product contains invalid or future MapDate");
  dated.sort((a, b) => b.date.localeCompare(a.date));
  const latest = dated[0]?.row;
  if (!latest) throw new Error("USDM API returned no county rows for the last 35 days");

  // statisticsType=2 is categorical area percentage, not cumulative D0-or-worse.
  const readings: DroughtReading[] = (["NONE", "D0", "D1", "D2", "D3", "D4"] as const).map(severity => {
    const value = latest[severity === "NONE" ? "None" : severity];
    if (value === undefined || value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100) throw new Error("USDM county product has invalid area percentage");
    return { fips: TARGET_FIPS, county: TARGET_COUNTY, state: "CA", severity, percent: Number(value) };
  });
  if (Math.abs(readings.reduce((sum, row) => sum + row.percent, 0) - 100) > 0.1) throw new Error("USDM categorical area percentages do not total 100");
  const mapDate = dated[0]!.date;

  const compositeSeverity = computeDroughtComposite(readings);
  const severeDroughtPercent = readings
    .filter(r => r.severity === "D2" || r.severity === "D3" || r.severity === "D4")
    .reduce((sum, r) => sum + r.percent, 0);

  const severityNames: Record<DroughtSeverity, string> = {
    NONE: "No drought",
    D0: "Abnormally Dry",
    D1: "Moderate Drought",
    D2: "Severe Drought",
    D3: "Extreme Drought",
    D4: "Exceptional Drought",
  };

  return {
    timestamp: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    productDate: mapDate,
    observedAt: `${mapDate}T00:00:00Z`,
    ...(/^\d{4}-\d{2}-\d{2}$/.test(latest.ValidEnd ?? "") ? { validUntil: `${latest.ValidEnd}T23:59:59Z` } : {}),
    readings,
    compositeSeverity,
    severeDroughtPercent,
    summary: "Del Norte County (map of " + mapDate + "): " + severityNames[compositeSeverity] + "; " + severeDroughtPercent + "% in D2–D4.",
  };
}

export async function runDroughtMonitor(options: ProducerOptions = {}): Promise<DroughtReport | null> { return withProducerScope("alert-usdm-drought", options, () => runDroughtMonitorInScope()); }
async function runDroughtMonitorInScope(): Promise<DroughtReport | null> {
  logger.info("Checking USDA drought monitor for Del Norte County");
  lastDroughtError = undefined;
  try {
    const report = await fetchDroughtData();
    await mkdir(HISTORY_DIR(), { recursive: true });
    await writeJsonAtomic(CURRENT_FILE(), report);
    if (report.readings.length > 0) {
      const processedIds = loadProcessedIds();
      for (const r of report.readings) {
        const id = r.fips + "-" + r.severity + "-" + report.productDate;
        if (!processedIds.has(id)) {
          appendHistory([r], report.productDate!);
        }
      }
    }
    const sevScore = SEVERITY_SCORE[report.compositeSeverity];
    if (sevScore >= 4) {
      logger.warn("DROUGHT EMERGENCY: " + report.summary);
    } else if (sevScore >= 3) {
      logger.warn("Drought warning: " + report.summary);
    } else if (sevScore >= 1) {
      logger.info("Drought watch: " + report.summary);
    } else {
      logger.info("Drought check: " + report.summary);
    }
    return report;
  } catch (err: any) {
    lastDroughtError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch drought data", { error: lastDroughtError });
    return null;
  }
}

if (import.meta.main) {
  runDroughtMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Drought monitor check failed --- see logs");
  });
}

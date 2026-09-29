#!/usr/bin/env bun
/**
 * California retail gasoline price monitor (#18) — the 🔴 TODO "fuel" item.
 *
 * There is no keyless public feed of station-level fuel prices for Crescent
 * City (GasBuddy and AAA block automated access and their terms do not permit
 * it; probed 2026-09-28). The honest keyless substitute is the U.S. Energy
 * Information Administration's weekly California all-grades all-formulations
 * retail gasoline price (series EMM_EPM0_PTE_SCA_DPG), published as a
 * server-rendered HTML table at eia.gov/dnav. It is a STATEWIDE observed
 * average, not a Crescent City street price, and the report says so.
 *
 * Doctrine (2026-09-26/27 correctness passes): this monitor reports the
 * latest OBSERVED weekly price only. There is no forecast in this feed and
 * none is manufactured; a week whose value is missing is reported as missing.
 *
 * Level: ADVISORY when the latest observed price exceeds the trailing 8-week
 * median by more than 15% (a supply-shock signature), CALM otherwise.
 *
 * Fetch plan (bounded): one GET of the EIA LeafHandler page (~145 KB), one
 * retry. Parsing is strict: a page whose data grid parses to zero weekly
 * rows throws, so a redesign of the EIA page is a loud unavailable error,
 * never a silent "no price data".
 *
 * Usage: bun run src/alerts/fuel.ts
 * Output: output/alerts/fuel/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  writeJsonAtomic,
  appendBoundedJsonlSync,
} from "../shared/source_health.js";
import { outputRoot } from "../shared/paths.js";
import { boundedFetchText } from "./connector.js";

const logger = createLogger("fuel_alert");

/** Body-size cap for the EIA dnav page (live page ~145 KB, 2026-09-29). */
export const FUEL_MAX_BYTES = 1_000_000;

export const EIA_CA_RETAIL_GAS_URL =
  "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=EMM_EPM0_PTE_SCA_DPG&f=W";
export const FUEL_SOURCE_NAME = "EIA California Fuel";
/** The price-spike band over the trailing median. */
export const FUEL_SPIKE_THRESHOLD = 0.15;
/** How many trailing observed weeks the median and the report carry. */
export const FUEL_TREND_WEEKS = 8;

const outputDir = (): string => join(outputRoot(), "alerts", "fuel");
export function fuelHistoryPath(): string {
  return join(outputDir(), "history.jsonl");
}
export function fuelCurrentPath(): string {
  return join(outputDir(), "current.json");
}

let lastFuelError: string | undefined;
export function getLastFuelError(): string | undefined {
  return lastFuelError;
}

export type FuelLevel = "CALM" | "ADVISORY";

export interface FuelWeekPrice {
  /** ISO date of the week (EIA weekly stamps are Mondays). */
  weekOf: string;
  /** Observed California retail price, dollars per gallon. */
  pricePerGallon: number;
}

export interface FuelReport {
  fetchedAt: string;
  sourceUrl: string;
  /** The latest OBSERVED week. Never a forecast, never backfilled. */
  latest: FuelWeekPrice | null;
  /** The trailing observed weeks (oldest → newest), excluding the latest. */
  previousWeeks: FuelWeekPrice[];
  /** Median of the trailing FUEL_TREND_WEEKS observed weeks. */
  medianPrice: number | null;
  /** Latest vs median, as a fraction (0.08 = +8%). */
  deltaVsMedian: number | null;
  worstLevel: FuelLevel;
  /** Statewide scope statement — this is NOT a station-level Crescent City price. */
  scopeNote: string;
  summary: string;
}

const MONTH_NAMES: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/**
 * Parse the EIA dnav data grid. Month headers are `<td class='B6'>&nbsp;&nbsp;2026-Jan</td>`;
 * week cells are pairs of `<td class='B5'>01/05&nbsp;</td><td class='B3'>4.154&nbsp;...`.
 * THROWS when the grid parses to zero rows — a redesigned or walled page must
 * surface as an unavailable error, never as silent "no prices".
 */
export function parseEiaWeeklyPrices(html: string): FuelWeekPrice[] {
  if (!html || !/class='B6'/i.test(html)) {
    throw new Error("EIA weekly page carried no data grid (B6/B5/B3 cells absent) — source format changed");
  }
  const prices: FuelWeekPrice[] = [];
  for (const monthMatch of html.matchAll(/class='B6'>[^\d<]*(\d{4})-([A-Za-z]{3})\s*<\/td>([\s\S]*?)(?=<tr|class='B6'|$)/gi)) {
    const year = monthMatch[1]!;
    const monthNum = MONTH_NAMES[monthMatch[2]!];
    if (!monthNum) continue;
    const monthSegment = monthMatch[3]!;
    for (const cell of monthSegment.matchAll(/class='B5'>(\d{2})\/(\d{2})&nbsp;<\/td>\s*<td class='B3'>([\d.]+)&nbsp;/gi)) {
      const price = Number(cell[3]);
      if (!Number.isFinite(price)) continue;
      const weekOf = new Date(Date.UTC(Number(year), monthNum - 1, Number(cell[1]))).toISOString();
      prices.push({ weekOf, pricePerGallon: price });
    }
  }
  if (prices.length === 0) {
    throw new Error("EIA weekly page parsed to zero price rows — source format changed");
  }
  return prices;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Build the report from parsed weekly prices (pure; no I/O). */
export function buildFuelReport(
  prices: FuelWeekPrice[],
  now = new Date().toISOString(),
): FuelReport {
  const sorted = [...prices].sort((a, b) => Date.parse(a.weekOf) - Date.parse(b.weekOf));
  const latest = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
  const previousWeeks = sorted.slice(Math.max(0, sorted.length - 1 - FUEL_TREND_WEEKS), sorted.length - 1);
  const medianPrice = previousWeeks.length >= 4 ? median(previousWeeks.map(week => week.pricePerGallon)) : null;
  const deltaVsMedian = latest && medianPrice !== null && medianPrice > 0
    ? latest.pricePerGallon / medianPrice - 1
    : null;
  const worstLevel: FuelLevel = deltaVsMedian !== null && deltaVsMedian > FUEL_SPIKE_THRESHOLD ? "ADVISORY" : "CALM";
  const summary = latest === null
    ? "No observed weekly price available."
    : deltaVsMedian === null
      ? `Latest observed California retail gasoline price $${latest.pricePerGallon.toFixed(2)}/gal (week of ${latest.weekOf}); insufficient trailing weeks for a trend check.`
      : `Latest observed California retail gasoline price $${latest.pricePerGallon.toFixed(2)}/gal (week of ${latest.weekOf}), ` +
        `${deltaVsMedian >= 0 ? "+" : ""}${(deltaVsMedian * 100).toFixed(1)}% vs ${previousWeeks.length}-week median $${medianPrice!.toFixed(2)}/gal` +
        (worstLevel === "ADVISORY" ? " — spike above the " + `${FUEL_SPIKE_THRESHOLD * 100}%` + " band" : "");
  return {
    fetchedAt: now,
    sourceUrl: EIA_CA_RETAIL_GAS_URL,
    latest,
    previousWeeks,
    medianPrice,
    deltaVsMedian,
    worstLevel,
    scopeNote: "Statewide California observed average (EIA weekly); not a station-level Crescent City reading.",
    summary,
  };
}

/**
 * Append one history record per observed week (deduped by weekOf) so the
 * analytics timeline carries a continuous price series, not just spikes.
 */
export async function appendFuelHistory(
  prices: FuelWeekPrice[],
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  if (prices.length === 0) return;
  await mkdir(outputDir(), { recursive: true });
  const seen = new Set<string>();
  const historyFile = fuelHistoryPath();
  try {
    const { readFileSync } = await import("fs");
    if (readFileSync(historyFile, "utf-8")) {
      for (const line of readFileSync(historyFile, "utf-8").split("\n").filter(Boolean)) {
        try { seen.add(String(JSON.parse(line).weekOf)); } catch { /* skip corrupt row */ }
      }
    }
  } catch { /* no history yet */ }
  for (const week of prices) {
    if (seen.has(week.weekOf)) continue;
    appendBoundedJsonlSync(historyFile, JSON.stringify({
      id: `fuel-${week.weekOf}`,
      type: "fuel",
      weekOf: week.weekOf,
      pricePerGallon: week.pricePerGallon,
      level: "CALM",
      summary: `California retail gasoline $${week.pricePerGallon.toFixed(2)}/gal (week of ${week.weekOf})`,
      url: EIA_CA_RETAIL_GAS_URL,
      fetchedAt,
    }));
  }
}

/** Bounded live fetch through the shared connector. */
function fetchEiaWeeklyPage(): Promise<string> {
  return boundedFetchText(EIA_CA_RETAIL_GAS_URL, {
    label: "EIA weekly price page",
    maxBytes: FUEL_MAX_BYTES,
  });
}

/** Run the monitor: fetch, parse, classify, persist current.json + deduped history. */
export async function runFuelMonitor(): Promise<FuelReport | null> {
  logger.info("Checking EIA weekly California retail gasoline price");
  lastFuelError = undefined;
  try {
    const prices = parseEiaWeeklyPrices(await fetchEiaWeeklyPage());
    const report = buildFuelReport(prices);

    await mkdir(outputDir(), { recursive: true });
    await writeJsonAtomic(fuelCurrentPath(), report);
    await appendFuelHistory([...report.previousWeeks, ...(report.latest ? [report.latest] : [])], report.fetchedAt);

    if (report.worstLevel === "ADVISORY") {
      logger.warn("Fuel: " + report.summary);
    } else {
      logger.info("Fuel check: " + report.summary);
    }
    return report;
  } catch (err) {
    lastFuelError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to check EIA fuel prices", { error: lastFuelError });
    return null;
  }
}

if (import.meta.main) {
  runFuelMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Fuel check failed — see logs");
  });
}
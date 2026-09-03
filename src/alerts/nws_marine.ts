#!/usr/bin/env bun
/**
 * NWS Coastal Waters Forecast monitor — Crescent City nearshore zone.
 *
 * Roadmap item "Marine: ... marine weather forecasts". The NDBC buoy monitor
 * (ndbc_marine.ts) covers OBSERVATIONS; this monitor covers the FORECAST side
 * by reading the official NWS Coastal Waters Forecast (CWF) text product that
 * api.weather.gov publishes for the Eureka (KEKA) office.
 *
 * Zone note: the roadmap said "PZZ455", but the live 2026-09 CWF renumbered
 * the zones — Crescent City's nearshore waters (Pt. St. George to Cape
 * Mendocino out 10 nm) are now PZZ450. The zone title is read from the
 * product text itself rather than hardcoded, so future renumbering degrades
 * to a visible title change, not a silently wrong forecast.
 *
 * API (verified live 2026-09-03):
 *   1. GET https://api.weather.gov/products/types/CWF/locations/EKA
 *      -> { "@graph": [ { "@id", "issuanceTime", ... }, ... ] }  (newest first)
 *   2. GET https://api.weather.gov/products/{id}
 *      -> { productText: "<CWF text with PZZ450-... blocks>" }
 *
 * `/zones/forecast/PZZ455/forecast` returns 404 "Marine Forecast Not
 * Supported" — the text product is the supported machine path.
 *
 * Usage: bun run src/alerts/nws_marine.ts
 * Output: output/alerts/marinezone/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

const logger = createLogger("nws_marine_alert");

export const NWS_CWF_LIST_URL = "https://api.weather.gov/products/types/CWF/locations/EKA";
export const NWS_CWF_PRODUCT_URL = "https://api.weather.gov/products/{ID}";
/** Crescent City nearshore zone in the current (2026-09) CWF numbering. */
export const MARINE_ZONE_CODE = "PZZ450";

const HISTORY_DIR = join(process.cwd(), "output", "alerts", "marinezone");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
let lastMarineZoneError: string | undefined;

export function getLastMarineZoneError(): string | undefined {
  return lastMarineZoneError;
}

const REQUEST_HEADERS = {
  "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)",
  Accept: "application/json",
} as const;

export type MarineForecastLevel = "CALM" | "WATCH" | "ADVISORY" | "WARNING" | "EMERGENCY";

export interface MarineForecastPeriod {
  /** Period label from the CWF, e.g. "REST OF TODAY", "TONIGHT". */
  period: string;
  windKtMin: number | null;
  windKtMax: number | null;
  seasFt: number | null;
  /** The raw CWF period text (wind/seas sentences). */
  text: string;
}

export interface MarineZoneForecast {
  zone: string;
  zoneTitle: string;
  issuance: string;
  office: string;
  periods: MarineForecastPeriod[];
  peakWindKt: number | null;
  worstLevel: MarineForecastLevel;
  worstPeriodName: string | null;
  summary: string;
}

/** Parse "wind 5 to 10 kt" / "winds 15 kt" / "wind to 25 kt" into (min,max). */
export function parseWindKt(text: string): { min: number | null; max: number | null } {
  const m = text.match(/\bwind(?:s)?\s+(?:to\s+)?(\d+)\s*(?:to\s+(\d+))?\s*kt\b/i);
  if (!m) return { min: null, max: null };
  const first = Number(m[1]);
  const second = m[2] !== undefined ? Number(m[2]) : null;
  if (!Number.isFinite(first)) return { min: null, max: null };
  return second !== null && Number.isFinite(second)
    ? { min: Math.min(first, second), max: Math.max(first, second) }
    : { min: null, max: first };
}

/** Parse "Seas 6 ft" / "seas 5 to 8 ft" into the max seas height. */
export function parseSeasFt(text: string): number | null {
  const m = text.match(/\bseas?\s+(\d+)\s*(?:to\s+(\d+))?\s*ft\b/i);
  if (!m) return null;
  const first = Number(m[1]);
  if (!Number.isFinite(first)) return null;
  const second = m[2] !== undefined ? Number(m[2]) : null;
  if (second !== null && Number.isFinite(second)) return Math.max(first, second);
  return first;
}

/**
 * Classify one period's forecast text. Ordered strongest first: STORM/
 * HURRICANE conditions, gale force winds, gale/hazardous-seas warnings, small
 * craft advisory, "should exercise caution". Wind thresholds back the text
 * when the CWF states winds without a headline (gale >= 34 kt, small-craft
 * advisory >= 21 kt).
 */
export function classifyMarineForecastPeriod(text: string, windKtMax: number | null): MarineForecastLevel {
  const t = text.toUpperCase();
  if (/STORM WARNING|HURRICANE FORCE/.test(t) || (windKtMax !== null && windKtMax >= 48)) return "EMERGENCY";
  if (/GALE WARNING|HAZARDOUS SEAS WARNING/.test(t) || (windKtMax !== null && windKtMax >= 34)) return "WARNING";
  if (/SMALL CRAFT ADVISORY/.test(t) || (windKtMax !== null && windKtMax >= 21)) return "ADVISORY";
  if (/SMALL CRAFT SHOULD EXERCISE CAUTION/.test(t)) return "WATCH";
  return "CALM";
}

const LEVEL_RANK: Record<MarineForecastLevel, number> = {
  CALM: 0, WATCH: 1, ADVISORY: 2, WARNING: 3, EMERGENCY: 4,
};

/** Worst level across all parsed periods, plus the period that set it. */
export function worstMarineLevel(periods: MarineForecastPeriod[]): { level: MarineForecastLevel; period: string | null } {
  let worst: MarineForecastLevel = "CALM";
  let worstPeriod: string | null = null;
  for (const p of periods) {
    const level = classifyMarineForecastPeriod(p.text, p.windKtMax);
    if (LEVEL_RANK[level] > LEVEL_RANK[worst]) {
      worst = level;
      worstPeriod = p.period;
    }
  }
  return { level: worst, period: worstPeriod };
}

/**
 * Split a CWF product text into per-zone blocks and return the one for
 * `zoneCode`. Blocks look like:
 *   PZZ450-040515-
 *   Coastal waters from Pt. St. George to Cape Mendocino CA out 10 nm-
 *   913 AM PDT Thu Sep 3 2026
 *   .REST OF TODAY...S wind 5 to 10 kt. Seas 6 ft. ...
 * Returns null when the zone is absent (renumbered/dropped) — visible, not fatal.
 */
export function extractZoneForecast(
  productText: string,
  zoneCode: string,
): { zone: string; zoneTitle: string; issuance: string; body: string } | null {
  const blocks = productText.split(/\n(?=\.?PZZ\d{3}-)/);
  for (const block of blocks) {
    const normalized = block.startsWith(".") ? block.slice(1) : block;
    if (!normalized.startsWith(`${zoneCode}-`)) continue;
    const lines = normalized.split(/\r?\n/);
    const title = (lines[1] ?? "").trim().replace(/-+$/, "");
    const issuance = (lines[2] ?? "").trim();
    const body = lines.slice(3).join("\n").trim();
    return { zone: zoneCode, zoneTitle: title, issuance, body };
  }
  return null;
}

/** Parse ".PERIOD...wind ... Seas ..." segments into structured periods. */
export function parseForecastPeriods(body: string): MarineForecastPeriod[] {
  const periods: MarineForecastPeriod[] = [];
  // Period headers look like ".REST OF TODAY...S wind 5 to 10 kt. ..." and
  // wrap across lines until the next ".PERIOD" header.
  const parts = body.replace(/\s*\$\$\s*$/, "").split(/\n\.(?=[A-Z])/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const headerMatch = trimmed.match(/^\.?([A-Z0-9 ]+?)\.\.\.(.*)$/s);
    if (!headerMatch) continue;
    const period = headerMatch[1].trim();
    const text = headerMatch[2].replace(/\s+/g, " ").trim();
    const wind = parseWindKt(text);
    periods.push({
      period,
      windKtMin: wind.min,
      windKtMax: wind.max,
      seasFt: parseSeasFt(text),
      text,
    });
  }
  return periods;
}

/** Extract the PZZ block from a fetched CWF product into a typed forecast. */
export function toMarineZoneForecast(productText: string, now = new Date().toISOString()): MarineZoneForecast | null {
  const zone = extractZoneForecast(productText, MARINE_ZONE_CODE);
  if (!zone) return null;
  const periods = parseForecastPeriods(zone.body);
  const peakWindKt = periods.reduce<number | null>((max, p) => {
    if (p.windKtMax === null) return max;
    return max === null || p.windKtMax > max ? p.windKtMax : max;
  }, null);
  const { level: worstLevel, period: worstPeriodName } = worstMarineLevel(periods);
  const summary = `${zone.zoneTitle}: ${worstLevel}` +
    (peakWindKt !== null ? `, peak forecast wind ${peakWindKt} kt` : "") +
    (worstPeriodName ? ` (${worstPeriodName})` : "");
  return {
    zone: zone.zone,
    zoneTitle: zone.zoneTitle,
    issuance: zone.issuance || now,
    office: "KEKA",
    periods,
    peakWindKt,
    worstLevel,
    worstPeriodName,
    summary,
  };
}

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(HISTORY_FILE)) return ids;
  try {
    for (const line of readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean)) {
      try { ids.add(String(JSON.parse(line).id)); } catch { /* skip corrupt row */ }
    }
  } catch { /* ignore */ }
  return ids;
}

/** Fetch the newest EKA CWF product text. */
export async function fetchCwfProductText(): Promise<string> {
  const listResp = await fetch(NWS_CWF_LIST_URL, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!listResp.ok) {
    throw new Error("NWS CWF list returned " + listResp.status + ": " + listResp.statusText);
  }
  const list = (await listResp.json()) as { "@graph"?: Array<{ "@id"?: string; id?: string }> };
  const newest = list["@graph"]?.[0];
  const productId = newest?.id ?? newest?.["@id"]?.split("/").pop();
  if (!productId) throw new Error("NWS CWF list contained no products");

  const productResp = await fetch(NWS_CWF_PRODUCT_URL.replace("{ID}", productId), {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!productResp.ok) {
    throw new Error("NWS CWF product returned " + productResp.status + ": " + productResp.statusText);
  }
  const product = (await productResp.json()) as { productText?: unknown };
  if (typeof product.productText !== "string" || !product.productText.trim()) {
    throw new Error("NWS CWF product had no productText");
  }
  return product.productText;
}

/** Run the monitor: fetch, parse, persist current.json + deduped history. */
export async function runMarineZoneMonitor(): Promise<MarineZoneForecast | null> {
  logger.info("Checking NWS Coastal Waters Forecast for " + MARINE_ZONE_CODE);
  lastMarineZoneError = undefined;
  try {
    const productText = await fetchCwfProductText();
    const forecast = toMarineZoneForecast(productText);
    if (!forecast) throw new Error(`Zone ${MARINE_ZONE_CODE} not found in the newest CWF product`);

    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, forecast);

    const id = `${forecast.zone}-${forecast.worstLevel}-${forecast.issuance}`;
    if (!loadProcessedIds().has(id)) {
      appendBoundedJsonlSync(HISTORY_FILE, JSON.stringify({
        id,
        zone: forecast.zone,
        zoneTitle: forecast.zoneTitle,
        issuance: forecast.issuance,
        worstLevel: forecast.worstLevel,
        worstPeriodName: forecast.worstPeriodName,
        peakWindKt: forecast.peakWindKt,
        summary: forecast.summary,
        fetchedAt: new Date().toISOString(),
      }));
    }

    if (forecast.worstLevel === "EMERGENCY" || forecast.worstLevel === "WARNING") {
      logger.warn("MARINE FORECAST " + forecast.worstLevel + ": " + forecast.summary);
    } else if (forecast.worstLevel !== "CALM") {
      logger.info("Marine forecast watch/advisory: " + forecast.summary);
    } else {
      logger.info("Marine forecast check: " + forecast.summary);
    }
    return forecast;
  } catch (err: any) {
    lastMarineZoneError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch NWS marine forecast", { error: lastMarineZoneError });
    return null;
  }
}

if (import.meta.main) {
  runMarineZoneMonitor().then((report) => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("NWS marine forecast check failed --- see logs");
  });
}

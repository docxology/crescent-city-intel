#!/usr/bin/env bun
/**
 * USCG Broadcast Notice to Mariners (BNM) monitor — Coast Guard District 11.
 *
 * Roadmap item: the 15th alert monitor. The USCG Navigation Center publishes
 * Broadcast Notices to Mariners (hazard, closure and aid-to-navigation
 * broadcast traffic) per Coast Guard district; Sector Humboldt Bay is the
 * sector whose area of responsibility includes Crescent City / Del Norte.
 *
 * Endpoint choice (verified live 2026-09-08): the District 11 Local Notice to
 * Mariners page (/local-notices-to-mariners?district=11+0&subdistrict=n) is a
 * weekly PDF download list — no per-notice text to parse — so this monitor
 * reads the DISTRICT 11 BROADCAST notice search-results page instead
 * (https://www.navcen.uscg.gov/broadcast-notice-to-mariners-search-results).
 * It is a server-rendered Drupal table (no JS required) that accepts
 * district/sector/date-range/items_per_page as plain GET parameters. The
 * Sector-Humboldt-Bay-only listing (sector=37) was evaluated and rejected as
 * the primary source: it is thin (14 messages in a 90-day window, several with
 * empty geographic fields), so the monitor scans the district listing over a
 * bounded window and applies a Del Norte / North Coast relevance filter.
 *
 * Fetch plan (bounded):
 *   1. GET the District 11 listing (sector=0 = district office, 35-day window,
 *      items_per_page=50, one request with one retry).
 *   2. Parse the result rows (guid, msg id, originator, criticality, region,
 *      category, publish date).
 *   3. For rows that pass the North Coast relevance filter ONLY, fetch the
 *      message detail page and extract the full broadcast text (synopsis).
 *      Typically zero such rows; never more than the window contains.
 *
 * Usage: bun run src/alerts/uscg_broadcasts.ts
 * Output: output/alerts/uscg/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";
import { outputRoot } from "../shared/paths.js";

const logger = createLogger("uscg_broadcasts_alert");

export const USCG_BNM_LIST_URL =
  "https://www.navcen.uscg.gov/broadcast-notice-to-mariners-search-results?district=11&sector=0&date-range={START}--{END}&items_per_page=50";
export const USCG_BNM_MESSAGE_URL =
  "https://www.navcen.uscg.gov/broadcast-notice-to-mariners-message?guid={GUID}";
/** How far back the district listing is scanned each run. */
export const USCG_BNM_WINDOW_DAYS = 35;
/** Source name used in source-health.json and the healer roster. */
export const USCG_SOURCE_NAME = "USCG Broadcast Notice to Mariners";

/** Resolved per call so the artifact-root seam (CC_OUTPUT_DIR) is honoured at run time. */
const outputDir = (): string => join(outputRoot(), "alerts", "uscg");
export function uscgHistoryPath(): string {
  return join(outputDir(), "history.jsonl");
}
export function uscgCurrentPath(): string {
  return join(outputDir(), "current.json");
}

let lastUscgError: string | undefined;
export function getLastUscgError(): string | undefined {
  return lastUscgError;
}

export type UscgBroadcastLevel = "CALM" | "ADVISORY";

export interface UscgBnmRow {
  /** NAVCEN message guid — the stable identity used for dedup and detail URLs. */
  guid: string;
  /** Message id, e.g. "SEC SHB BNM 0011-26" or "CGD-SW BNM 9105-26". */
  msgId: string;
  /** Originator office: "D11" (district) or "Humboldt Bay" (sector). */
  originator: string;
  /** Criticality: SAFETY | CANCELLATION | SUMMARY | ... */
  criticality: string;
  /** Geographic area string from the listing, e.g. "HUMBOLDT BAY". */
  location: string;
  /** Descriptor/category from the listing, e.g. "ATON", "SPACE OPERATIONS". */
  descriptor: string;
  /** ISO-8601 publish timestamp, or "" when the listing row lacked a parseable date. */
  publishedAt: string;
  /** Message detail page URL. */
  url: string;
  /** Full broadcast text from the detail page; null until fetched (or on fetch failure). */
  synopsis: string | null;
}

export interface UscgBroadcastReport {
  fetchedAt: string;
  sourceUrl: string;
  windowDays: number;
  /** All rows parsed from the district listing this run. */
  totalBroadcasts: number;
  /** Rows that passed the Del Norte / North Coast relevance filter. */
  items: UscgBnmRow[];
  relevantCount: number;
  worstLevel: UscgBroadcastLevel;
  summary: string;
}

/**
 * Del Norte / North Coast relevance keywords, tuned against the live 2026-09-08
 * District 11 listing fixture (tests/fixtures/uscg/bnm-d11-listing.html): the
 * bulk of district traffic is far-field (rocket-launch hazard areas published
 * as "Pacific ocean / SPACE OPERATIONS") and must NOT read as local. Matched
 * case-insensitively as substrings across the row's fields.
 */
export const NORTH_COAST_KEYWORDS = [
  "crescent city", "del norte", "humboldt", "brookings", "smith river", "klamath",
  "trinidad", "eureka", "cape mendocino", "st. george", "rustic art",
  "bar", "channel", "buoy", "harbor",
] as const;

/** Strip tags and decode the handful of entities NAVCEN pages use. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeScriptBlocks(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
}

/**
 * Parse a NAVCEN listing timestamp like "2026-09-04 07:03:12 -0400" into ISO.
 * `Date.parse` is unreliable on that shape, so it is normalized explicitly.
 */
export function parseBnmTimestamp(raw: string): string | null {
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parse the server-rendered BNM search-results table into rows. Data rows are
 * identified by their detail-page link (every other row — headers, sort links,
 * pagination — is skipped). Duplicate guids (a guid can appear on several
 * pages of a window) are collapsed.
 */
export function parseBnmListing(html: string): UscgBnmRow[] {
  const clean = removeScriptBlocks(html);
  const rows: UscgBnmRow[] = [];
  const seen = new Set<string>();
  for (const rowMatch of clean.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const guid = row.match(/broadcast-notice-to-mariners-message\?guid=(\d+)/)?.[1];
    if (!guid || seen.has(guid)) continue;
    const cell = (field: string): string => {
      const cm = row.match(new RegExp(`views-field-field-bnm-message-${field}[^"]*"[^>]*>([\\s\\S]*?)</td>`, "i"));
      return cm ? stripTags(cm[1]) : "";
    };
    rows.push({
      guid,
      msgId: cell("number"),
      originator: cell("originator"),
      criticality: cell("criticality"),
      location: cell("region"),
      descriptor: cell("category"),
      publishedAt: parseBnmTimestamp(cell("date")) ?? "",
      url: USCG_BNM_MESSAGE_URL.replace("{GUID}", guid),
      synopsis: null,
    });
  }
  return rows;
}

/**
 * Extract the full broadcast text from a message detail page. The text sits in
 * a `.bnm_message_render` block as paragraphs after the "SAFETY / AREA / ... /
 * MSG-ID / date" header line, terminated by the NOS "BT" broadcast marker.
 * Returns null when the page no longer carries that shape (visible, not fatal).
 */
export function parseBnmMessage(html: string): string | null {
  const clean = removeScriptBlocks(html);
  const renderStart = clean.indexOf("bnm_message_render");
  if (renderStart === -1) return null;
  const segment = clean.slice(renderStart);
  const paragraphs = [...segment.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => stripTags(m[1]))
    .filter(Boolean);
  // Skip the "Message Originator:" label and the slash-delimited meta line.
  const originatorIdx = paragraphs.findIndex(p => /^Message Originator\b/i.test(p));
  if (originatorIdx === -1) return null;
  let body = paragraphs.slice(originatorIdx + 2).join("\n").trim();
  if (!body) return null;
  // Drop the trailing "BT" terminator (and anything after it — contact boilerplate).
  const btIdx = body.search(/^\s*BT\s*$/m);
  if (btIdx !== -1) body = body.slice(0, btIdx).trim();
  return body || null;
}

/**
 * Relevance filter: does this broadcast concern the Del Norte / North Coast
 * waters this system watches? Applied to every field the row carries, plus the
 * fetched synopsis when one is available.
 */
export function isNorthCoastBroadcast(
  item: Pick<UscgBnmRow, "originator" | "location" | "descriptor" | "msgId"> & { synopsis?: string | null },
): boolean {
  const text = `${item.originator} ${item.location} ${item.descriptor} ${item.msgId} ${item.synopsis ?? ""}`
    .toLowerCase();
  return NORTH_COAST_KEYWORDS.some(keyword => text.includes(keyword));
}

/** Map a BNM criticality to the monitor's level scale. Broadcasts are
 * informational traffic: SAFETY/unknown => ADVISORY, housekeeping => CALM. */
export function classifyUscgBroadcast(criticality: string): UscgBroadcastLevel {
  const c = criticality.trim().toUpperCase();
  if (c === "CANCELLATION" || c === "SUMMARY") return "CALM";
  return "ADVISORY";
}

const LEVEL_RANK: Record<UscgBroadcastLevel, number> = { CALM: 0, ADVISORY: 1 };

/** Build the monitor report from parsed listing rows (pure; no I/O). */
export function buildUscgBroadcastReport(rows: UscgBnmRow[], now = new Date().toISOString()): UscgBroadcastReport {
  const relevant = rows.filter(isNorthCoastBroadcast);
  const worstLevel = relevant.reduce<UscgBroadcastLevel>(
    (worst, item) => (LEVEL_RANK[classifyUscgBroadcast(item.criticality)] > LEVEL_RANK[worst]
      ? classifyUscgBroadcast(item.criticality)
      : worst),
    "CALM",
  );
  const summary = relevant.length === 0
    ? `No Del Norte / North Coast broadcasts in the District 11 BNM window (${rows.length} district notices scanned).`
    : `${relevant.length} North Coast broadcast(s), worst ${worstLevel}: ` +
      relevant.slice(0, 3).map(item => item.msgId || item.guid).join(", ") +
      (relevant.length > 3 ? `, +${relevant.length - 3} more` : "");
  return {
    fetchedAt: now,
    sourceUrl: USCG_BNM_LIST_URL,
    windowDays: USCG_BNM_WINDOW_DAYS,
    totalBroadcasts: rows.length,
    items: relevant,
    relevantCount: relevant.length,
    worstLevel,
    summary,
  };
}

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  const historyFile = uscgHistoryPath();
  if (!existsSync(historyFile)) return ids;
  try {
    for (const line of readFileSync(historyFile, "utf-8").split("\n").filter(Boolean)) {
      try { ids.add(String(JSON.parse(line).id)); } catch { /* skip corrupt row */ }
    }
  } catch { /* ignore */ }
  return ids;
}

/**
 * Append one history record per relevant broadcast, deduplicated by guid, to
 * the bounded JSONL history alert_analytics reads (output/alerts/uscg/).
 * Exported for offline tests; the monitor's run() calls this after a fetch.
 */
export function appendUscgHistory(items: UscgBnmRow[], fetchedAt = new Date().toISOString()): void {
  mkdirSync(outputDir(), { recursive: true });
  const processedIds = loadProcessedIds();
  for (const item of items) {
    const id = `uscg-${item.guid}`;
    if (processedIds.has(id)) continue;
    processedIds.add(id);
    appendBoundedJsonlSync(uscgHistoryPath(), JSON.stringify({
      id,
      guid: item.guid,
      msgId: item.msgId,
      originator: item.originator,
      criticality: item.criticality,
      location: item.location,
      descriptor: item.descriptor,
      publishedAt: item.publishedAt,
      level: classifyUscgBroadcast(item.criticality),
      summary: item.synopsis ?? item.msgId,
      url: item.url,
      fetchedAt,
    }));
  }
}

const REQUEST_HEADERS = {
  "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)",
  Accept: "text/html",
} as const;

/** Bounded fetch with one retry; a second failure throws to the run wrapper. */
async function fetchTextWithRetry(url: string, attempts = 2): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("USCG NAVCEN returned " + response.status + ": " + response.statusText);
      const text = await response.text();
      if (!text.trim()) throw new Error("USCG NAVCEN returned an empty page");
      return text;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function bnmWindow(now = new Date()): { start: string; end: string } {
  const end = now;
  const start = new Date(end.getTime() - USCG_BNM_WINDOW_DAYS * 24 * 3600 * 1000);
  const ymd = (d: Date) =>
    d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  return { start: ymd(start), end: ymd(end) };
}

/** Fetch and parse the District 11 BNM listing (no synopsis fetches). */
export async function fetchUscgBnmRows(now = new Date()): Promise<UscgBnmRow[]> {
  const { start, end } = bnmWindow(now);
  const url = USCG_BNM_LIST_URL.replace("{START}", start).replace("{END}", end);
  const html = await fetchTextWithRetry(url);
  return parseBnmListing(html);
}

/** Fetch the full broadcast text for one message; null on any failure. */
async function fetchBnmSynopsis(row: UscgBnmRow): Promise<string | null> {
  try {
    const html = await fetchTextWithRetry(row.url);
    return parseBnmMessage(html);
  } catch (err) {
    logger.warn("Failed to fetch USCG BNM message detail", {
      guid: row.guid,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Run the monitor: fetch, parse, filter, persist current.json + deduped history. */
export async function runUscgBroadcastMonitor(): Promise<UscgBroadcastReport | null> {
  logger.info("Checking USCG District 11 Broadcast Notices to Mariners");
  lastUscgError = undefined;
  try {
    const rows = await fetchUscgBnmRows();
    // Fetch the full text only for locally relevant rows — usually none, so
    // the common run stays a single request.
    for (const row of rows) {
      if (!isNorthCoastBroadcast(row)) continue;
      row.synopsis = await fetchBnmSynopsis(row);
    }
    const report = buildUscgBroadcastReport(rows);

    await mkdir(outputDir(), { recursive: true });
    await writeJsonAtomic(uscgCurrentPath(), report);
    if (report.items.length > 0) {
      appendUscgHistory(report.items, report.fetchedAt);
    }

    if (report.relevantCount > 0) {
      logger.warn("USCG BNM: " + report.summary);
    } else {
      logger.info("USCG BNM check: " + report.summary);
    }
    return report;
  } catch (err) {
    lastUscgError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch USCG broadcast notices", { error: lastUscgError });
    return null;
  }
}

if (import.meta.main) {
  runUscgBroadcastMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("USCG broadcast notice check failed --- see logs");
  });
}

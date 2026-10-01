#!/usr/bin/env bun
import { withProducerScope, type ProducerOptions } from "../shared/run_scope.js";
import { boundedHttpFetch as fetch } from "../shared/transport.js";
import { outputRoot } from "../shared/paths.js";
/**
 * Del Norte Unified School District (DUSD) Closure Monitor.
 *
 * Monitors Del Norte Unified School District for school closures, delays,
 * early dismissals, and other schedule changes due to weather, emergency,
 * or operational reasons.
 *
 * Sources: DUSD website, social media pages, or district alert system.
 *
 * Usage:
 *   bun run src/alerts/dusd_schools.ts
 *
 * Output: output/alerts/schools/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

import { pacificDay, isCivilDate } from "../events.js";
const logger = createLogger("dusd_schools_alert");

/** DUSD official website. */
export const DUSD_WEBSITE_URL = "https://www.dnusd.org";
/** DUSD alerts/news page for closures. */
export const DUSD_ALERTS_URL = "https://www.dnusd.org/news";
/** Fallback: DUSD Facebook or school-closure alert feed. */
export const DUSD_FALLBACK_URL = "https://www.dnusd.org/announcements";

const TARGET_DISTRICT = "Del Norte Unified School District";
const TARGET_SCHOOLS = [
  "Del Norte High", "Crescent Elk Middle", "Mountain Elementary",
  "Redwood Elementary", "Bess Maxwell Elementary", "Joe Hamilton Elementary",
  "Mary Peacock Elementary", "Sunset High", "Castle Rock Charter",
  "Del Norte Community School", "DNUSD",
];

function HISTORY_DIR(): string { return join(outputRoot(), "alerts", "schools"); }
function HISTORY_FILE(): string { return join(HISTORY_DIR(), "history.jsonl"); }
function CURRENT_FILE(): string { return join(HISTORY_DIR(), "current.json"); }
let lastSchoolsError: string | undefined;

export function getLastSchoolsError(): string | undefined {
  return lastSchoolsError;
}

export type SchoolStatus = "OPEN" | "DELAYED" | "EARLY_RELEASE" | "CLOSED" | "PARTIAL_CLOSURE";

export interface SchoolClosureItem {
  /** Unique event ID */
  id: string;
  /** Title of the announcement */
  title: string;
  /** Closure date (ISO date string) */
  date: string;
  /** Status for the district */
  status: SchoolStatus;
  /** Schools affected (empty = all district schools) */
  affectedSchools: string[];
  /** Reason for the closure/delay */
  reason: string;
  /** Delay duration in minutes (for delayed openings) */
  delayMinutes: number | null;
  /** Source URL */
  sourceUrl: string;
  /** When the announcement was made */
  announcedAt: string | null;
}

export interface SchoolClosureReport {
  timestamp: string;
  /** Current active closure/delay events */
  events: SchoolClosureItem[];
  /** Total events */
  totalEvents: number;
  /** Overall district status */
  districtStatus: SchoolStatus;
  /** Whether any closure is active today */
  hasActiveClosure: boolean;
  /** Whether any delay is active today */
  hasActiveDelay: boolean;
  /** Human-readable summary */
  summary: string;
}

const STATUS_SEVERITY: Record<SchoolStatus, number> = {
  OPEN: 0,
  DELAYED: 1,
  EARLY_RELEASE: 2,
  PARTIAL_CLOSURE: 3,
  CLOSED: 4,
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

function appendHistory(event: SchoolClosureItem): void {
  try {
    mkdirSync(HISTORY_DIR(), { recursive: true });
    const record = JSON.stringify({ ...event, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE(), record);
  } catch (err) {
    logger.warn("Failed to append school closure history", { error: String(err) });
  }
}

export function classifySchoolStatus(text: string): SchoolStatus {
  const t = text.toLowerCase();
  if (t.includes("closed") || t.includes("cancelled") || t.includes("no school") || t.includes("all schools closed")) {
    return "CLOSED";
  }
  if (t.includes("partial") || t.includes("some schools") || t.includes("selected")) {
    return "PARTIAL_CLOSURE";
  }
  if (t.includes("early") || t.includes("early release") || t.includes("early dismissal")) {
    return "EARLY_RELEASE";
  }
  if (t.includes("delay") || t.includes("late start") || t.includes("delayed opening")) {
    return "DELAYED";
  }
  return "OPEN";
}

function extractDelayMinutes(text: string): number | null {
  const match = text.match(/(\d+)\s*(hour|hr|minute|min)/i);
  if (match) {
    const val = Number(match[1]);
    if (Number.isFinite(val)) {
      if (match[2].toLowerCase().startsWith("h")) return val * 60;
      return val;
    }
  }
  return null;
}

/**
 * Pull the announcement headline out of a page: the `<title>`, and the first
 * few headings, which is where a district posts "Schools Closed ...". This is
 * the ONLY text allowed to decide a closure on the fallback path — body text
 * mentions "closed" in navigation, footers and unrelated posts.
 */
function extractHeadlineText(html: string): string {
  const parts: string[] = [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) parts.push(title[1]);
  for (const heading of html.slice(0, 20_000).matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    const text = (heading[1] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
    if (parts.length >= 6) break;
  }
  return parts.join(" ");
}

/**
 * Fetch DUSD announcements that may contain school closure info.
 */
/** A current acquisition cannot turn an undated announcement into today's closure. */
export function parseSchoolClosurePage(html: string, sourceUrl: string, asOf: Date = new Date()): SchoolClosureItem[] {
  const today = pacificDay(asOf);
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (visible.length < 40 || !/del norte|dnusd|dusd/i.test(visible) || /(?:sign in|log in) to (?:continue|view)|access denied|just a moment/i.test(extractHeadlineText(html))) throw new Error('District response does not establish a usable announcement page');
  const blocks = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(match => match[1]!);
  const candidates = blocks.length ? blocks : [html];
  const events: SchoolClosureItem[] = [];
  for (const block of candidates) {
    const headline = extractHeadlineText(block);
    if (!/school|student|district/i.test(headline)) continue;
    const status = classifySchoolStatus(headline);
    if (status === 'OPEN') continue;
    // Only an explicit occurrence day in the headline, or its literal "today", qualifies.
    // A <time> publication stamp elsewhere in a post never supplies this day.
    const day = headline.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? (/\btoday\b/i.test(headline) ? today : null);
    if (!day || !isCivilDate(day)) throw new Error('School status announcement lacks a valid occurrence date');
    if (day !== today) continue;
    events.push({ id: 'dusd-' + new Bun.CryptoHasher('sha256').update(sourceUrl + '|' + headline + '|' + day).digest('hex').slice(0, 20), title: headline, date: day, status, affectedSchools: [], reason: 'Explicit occurrence day in district announcement headline', delayMinutes: extractDelayMinutes(headline), sourceUrl, announcedAt: null });
  }
  return events;
}
export async function fetchSchoolClosures(): Promise<SchoolClosureItem[]> {
  const asOf = new Date(); const events: SchoolClosureItem[] = [];
  for (const url of [DUSD_WEBSITE_URL, DUSD_ALERTS_URL]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error('Incomplete district source coverage: HTTP ' + response.status);
    events.push(...parseSchoolClosurePage(await response.text(), url, asOf));
  }
  const seen = new Set<string>();
  return events.filter(event => { const identity = event.status + '|' + event.title + '|' + event.date; if (seen.has(identity)) return false; seen.add(identity); return true; });
}

/** Main monitor entry point */
export async function runSchoolClosureMonitor(options: ProducerOptions = {}): Promise<SchoolClosureReport | null> { return withProducerScope("alert-dusd-schools", options, () => runSchoolClosureMonitorInScope()); }
async function runSchoolClosureMonitorInScope(): Promise<SchoolClosureReport | null> {
  logger.info("Checking Del Norte Unified School District closures");
  lastSchoolsError = undefined;

  try {
    const events = await fetchSchoolClosures();

    let districtStatus: SchoolStatus = "OPEN";
    let hasActiveClosure = false;
    let hasActiveDelay = false;
    for (const ev of events) {
      if (STATUS_SEVERITY[ev.status] > STATUS_SEVERITY[districtStatus]) {
        districtStatus = ev.status;
      }
      if (ev.status === "CLOSED" || ev.status === "PARTIAL_CLOSURE") {
        hasActiveClosure = true;
      }
      if (ev.status === "DELAYED") {
        hasActiveDelay = true;
      }
    }

    const report: SchoolClosureReport = {
      timestamp: new Date().toISOString(),
      events,
      totalEvents: events.length,
      districtStatus,
      hasActiveClosure,
      hasActiveDelay,
      summary: events.length === 0
        ? "No school closures or delays reported for " + TARGET_DISTRICT
        : TARGET_DISTRICT + ": " + districtStatus +
          (hasActiveClosure ? " — CLOSURE IN EFFECT" : "") +
          (hasActiveDelay ? " — DELAYED OPENING" : "") +
          ". " + events.map(e => e.title + " (" + e.reason + ")").join("; "),
    };

    await mkdir(HISTORY_DIR(), { recursive: true });
    await writeJsonAtomic(CURRENT_FILE(), report);

    if (events.length > 0) {
      const processedIds = loadProcessedIds();
      for (const ev of events) {
        if (!processedIds.has(ev.id)) {
          appendHistory(ev);
        }
      }
    }

    if (hasActiveClosure) {
      logger.warn("SCHOOL CLOSURE: " + report.summary);
    } else if (hasActiveDelay) {
      logger.warn("School delay: " + report.summary);
    } else if (districtStatus !== "OPEN") {
      logger.info("School status change: " + report.summary);
    } else {
      logger.info("School check: " + report.summary);
    }

    return report;
  } catch (err: any) {
    lastSchoolsError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to check school closures", { error: lastSchoolsError });
    return null;
  }
}

if (import.meta.main) {
  runSchoolClosureMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("School closure monitor check failed --- see logs");
  });
}

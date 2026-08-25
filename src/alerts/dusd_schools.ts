#!/usr/bin/env bun
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

const HISTORY_DIR = join(process.cwd(), "output", "alerts", "schools");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
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
  if (!existsSync(HISTORY_FILE)) return ids;
  try {
    const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function appendHistory(event: SchoolClosureItem): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const record = JSON.stringify({ ...event, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE, record);
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

function isTodayEvent(dateText: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  // Check dateText contains today or a relative date
  return dateText.includes(today);
}

/**
 * Fetch DUSD announcements that may contain school closure info.
 */
export async function fetchSchoolClosures(): Promise<SchoolClosureItem[]> {
  const today = new Date().toISOString().slice(0, 10);
  const events: SchoolClosureItem[] = [];

  // Try the main DUSD website first
  try {
    const response = await fetch(DUSD_WEBSITE_URL, {
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const html = await response.text();
      // Look for closure/delay keywords in the page text
      const lower = html.toLowerCase();
      if (lower.includes("school closed") || lower.includes("no school") || lower.includes("delayed opening") || lower.includes("dnsud closed")) {
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : "DUSD Announcement";
        const status = classifySchoolStatus(title);
        events.push({
          id: "dusd-site-" + today,
          title,
          date: today,
          status,
          affectedSchools: [],
          reason: "Posted on DUSD website",
          delayMinutes: extractDelayMinutes(title),
          sourceUrl: DUSD_WEBSITE_URL,
          announcedAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    logger.warn("DUSD website not reachable for closure check", { error: String(err) });
  }

  // Try the alerts/news page
  try {
    const response = await fetch(DUSD_ALERTS_URL, {
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const html = await response.text();
      const lower = html.toLowerCase();
      // Look for closure-related posts/news items
      const keywords = ["closed", "delay", "late start", "no school", "dismiss", "closure", "snow", "weather", "emergency"];
      const found = keywords.some(k => lower.includes(k));
      if (found) {
        // Try to extract individual items
        const itemRegex = /<article[^>]*>|<div[^>]*class="[^"]*(?:news|post|item|alert)[^"]*"[^>]*>/gi;
        const items: string[] = [];
        let match;
        while ((match = itemRegex.exec(html)) !== null) {
          const start = match.index;
          const end = html.indexOf("</article>", start);
          if (end > start) items.push(html.slice(start, end + 10));
        }

        if (items.length === 0) {
          // Fallback: just check the entire page
          const status = classifySchoolStatus(lower);
          if (status !== "OPEN") {
            events.push({
              id: "dusd-news-" + today,
              title: "DUSD News Page: " + status.toLowerCase().replace("_", " "),
              date: today,
              status,
              affectedSchools: [],
              reason: "Posted on DUSD alerts page",
              delayMinutes: extractDelayMinutes(lower),
              sourceUrl: DUSD_ALERTS_URL,
              announcedAt: new Date().toISOString(),
            });
          }
        } else {
          for (const item of items) {
            const itemLower = item.toLowerCase();
            if (keywords.some(k => itemLower.includes(k))) {
              const titleMatch = item.match(/<h[2-4][^>]*>([^<]*)<\/h[2-4]>/i);
              const title = titleMatch ? titleMatch[1].trim() : "DUSD Alert";
              const status = classifySchoolStatus(title);
              if (status !== "OPEN") {
                events.push({
                  id: "dusd-news-" + events.length + "-" + today,
                  title,
                  date: today,
                  status,
                  affectedSchools: [],
                  reason: "Posted on DUSD alerts page",
                  delayMinutes: extractDelayMinutes(title),
                  sourceUrl: DUSD_ALERTS_URL,
                  announcedAt: new Date().toISOString(),
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn("DUSD alerts page not reachable", { error: String(err) });
  }

  // De-duplicate by title + status
  const seen = new Set<string>();
  return events.filter(e => {
    const key = e.status + "|" + e.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Main monitor entry point */
export async function runSchoolClosureMonitor(): Promise<SchoolClosureReport | null> {
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

    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);

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

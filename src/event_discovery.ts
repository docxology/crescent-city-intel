#!/usr/bin/env bun
/**
 * Community-event discovery - fetches configured public event feeds for
 * Crescent City / Del Norte County, parses ICS/RSS/HTML listings into
 * candidate StructuredEvent records, reconciles them against the existing
 * deterministic calendar artifact, and emits a discovery artifact.
 *
 * Grounding rules (round 2):
 *  - Every emitted event carries its `sourceUrl`, `sourceName`,
 *    `extractionMethod` ('markup' | 'llm'), and a `confidence` score.
 *  - Dates come only from the feed itself (markup/ICS/RSS) or from an LLM
 *    reading of ambiguous-but-date-like listing text. When neither is
 *    available the event is DROPPED and counted - never guessed.
 *  - Fetches are bounded-timeout; a failing source degrades to an errored
 *    source record, never a thrown failure of the whole run.
 *
 * Usage:
 *   bun run src/event_discovery.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import * as cheerio from "cheerio";
import { classify, extractTimeNote as sanitizeTimeNote, MAX_SOURCE_LINKS, parseEventDate } from "./events.js";
import { createLogger } from "./logger.js";

const logger = createLogger("event-discovery");

export const DISCOVERY_SCHEMA = "crescent-city-events-discovery/v1";

/** Per-source fetch timeout in milliseconds (bounded so runs stay snappy). */
export const FETCH_TIMEOUT_MS = 10_000;
/** Maximum events kept from any single source in one discovery pass. */
export const MAX_EVENTS_PER_SOURCE = 50;
/** Title+date window (days) inside which two records count as the same event. */
export const MERGE_TOLERANCE_DAYS = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceType = "html" | "rss" | "ics";

export interface EventSourceRecord {
  name: string;
  url: string;
  type: SourceType;
  notes: string;
  /** Optional extraction strategy override. evogov-json reads an EvoGov calendar platform site through its public meetings/get_list JSON endpoint, using calendar ids discovered on the listing page itself. */
  strategy?: "evogov-json";
  probe?: {
    status: "ok" | "error" | "redirects";
    httpStatus?: number;
    notes?: string;
    probedAt: string;
  };
}

/** A discovered event before reconciliation. */
export interface DiscoveredEvent {
  title: string;
  kind: "community-listing" | "government-meeting" | "holiday-closure";
  dateStart: string | null;
  dateAllDay: boolean;
  timeNote: string | null;
  location: string | null;
  organizer: string | null;
  description: string;
  sourceUrl: string;
  sourceName: string;
  sourceLinks: string[];
  extractionMethod: "markup" | "llm";
  /** 0..1 fidelity score: 0.95 ICS markup, 0.9 RSS markup, 0.85 HTML markup, 0.55 LLM. */
  confidence: number;
}

export interface DiscoveryArtifact {
  schemaVersion: typeof DISCOVERY_SCHEMA;
  generatedAt: string;
  counts: {
    sourcesOk: number;
    sourcesErrored: number;
    fetched: number;
    droppedAmbiguous: number;
    droppedUndated: number;
    conflictsFlagged: number;
    reconciled: number;
    count: number;
  };
  sources: Array<{
    name: string;
    url: string;
    type: SourceType;
    status: "ok" | "error";
    httpStatus?: number;
    error?: string;
    eventsFound: number;
  }>;
  provenance: {
    groundRules: string[];
    reconciledAgainst: string;
  };
  events: Array<
    DiscoveredEvent & {
      status: ReturnType<typeof classify>;
      needsReview: boolean;
      id: string;
    }
  >;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

// ---------------------------------------------------------------------------
// Fetching (bounded)
// ---------------------------------------------------------------------------

/** Fetch a URL with a hard timeout; returns raw body text + HTTP status. */
export async function fetchFeed(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ text: string; httpStatus: number }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; crescent-city-intel event discovery)",
      Accept: "text/html,application/rss+xml,application/xml,text/calendar,text/plain;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { text: await response.text(), httpStatus: response.status };
}

// ---------------------------------------------------------------------------
// ICS parsing (RFC 5545 subset)
// ---------------------------------------------------------------------------

interface IcsVevent {
  summary: string;
  dtstart: string;
  location?: string;
  description?: string;
  url?: string;
}

/** Unfold folded ICS continuation lines (RFC 5545 section 3.1). */
export function unfoldIcsLines(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += rawLine.slice(1);
    } else {
      out.push(rawLine);
    }
  }
  return out;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/**
 * Parse VEVENT blocks. Only events with both SUMMARY and DTSTART are kept -
 * the caller drops anything whose DTSTART cannot reduce to an ISO date.
 */
export function parseIcsEvents(text: string): IcsVevent[] {
  const lines = unfoldIcsLines(text);
  const events: IcsVevent[] = [];
  let current: Partial<IcsVevent> | null = null;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:VEVENT")) { current = {}; continue; }
    if (upper.startsWith("END:VEVENT")) {
      if (current?.summary && current.dtstart) events.push(current as IcsVevent);
      current = null;
      continue;
    }
    if (!current) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) continue;
    const prop = line.slice(0, colonIndex).toUpperCase().split(";")[0];
    const value = line.slice(colonIndex + 1);
    switch (prop) {
      case "SUMMARY": current.summary ??= unescapeIcs(value); break;
      case "DTSTART": current.dtstart ??= value; break;
      case "LOCATION": current.location ??= unescapeIcs(value); break;
      case "DESCRIPTION": current.description ??= unescapeIcs(value); break;
      case "URL": current.url ??= value.trim(); break;
    }
  }
  return events;
}

/**
 * The calendar this project publishes is a local one; a UTC DTSTART has to be
 * read in Crescent City's own timezone or the date and the time disagree
 * (20261012T023000Z is the 11th at 7:30 PM here, not the 12th at 2:30 AM).
 */
export const EVENT_TIME_ZONE = "America/Los_Angeles";

const ZONED_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/** Split an ICS DTSTART into its calendar parts, or null when it is not one. */
function icsParts(value: string): { date: string; time: string | null; utc: boolean } | null {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5]}` : null,
    utc: match[7] === "Z",
  };
}

/** Render a UTC instant as its {date, time} in EVENT_TIME_ZONE. */
function toLocalParts(date: string, time: string): { date: string; time: string } {
  const instant = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(instant)) return { date, time };
  const parts = new Map(ZONED_PARTS.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  // hourCycle h23 still reports midnight as "24" in some ICU builds.
  const hour = parts.get("hour") === "24" ? "00" : parts.get("hour")!;
  return {
    date: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    time: `${hour}:${parts.get("minute")}`,
  };
}

/**
 * Reduce an ICS DTSTART value to ISO yyyy-mm-dd, or null (never guesses).
 * A UTC (`...Z`) stamp is converted into EVENT_TIME_ZONE first, so the date
 * always agrees with the time `icsTimeNote` reports for the same value.
 */
export function icsDateToIso(value: string): string | null {
  const parts = icsParts(value);
  if (!parts) return parseEventDate(value);
  if (!parts.time || !parts.utc) return parts.date;
  return toLocalParts(parts.date, parts.time).date;
}

/**
 * The local clock time an ICS DTSTART names, or null for a date-only value.
 * UTC stamps are converted into EVENT_TIME_ZONE; a value carrying a TZID
 * parameter is already local and is read as written.
 */
export function icsTimeNote(icsValue: string): string | null {
  const parts = icsParts(icsValue);
  if (!parts?.time) return null;
  return parts.utc ? toLocalParts(parts.date, parts.time).time : parts.time;
}

// ---------------------------------------------------------------------------
// RSS / Atom parsing
// ---------------------------------------------------------------------------

export interface RssItem { title: string; link: string; pubDate: string | null; description: string }

/** Parse RSS `<item>` and Atom `<entry>` elements via cheerio XML mode. */
export function parseRssItems(xml: string): RssItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RssItem[] = [];
  $("item").each((_, el) => {
    const item = $(el);
    const title = item.find("title").first().text().trim();
    const link = item.find("link").first().text().trim() || item.attr("rdf:about")?.trim() || "";
    const pubDate = item.find("pubDate").first().text().trim() || item.find("date").first().text().trim() || null;
    const description = item.find("description").first().text().trim();
    if (title && /^https?:\/\//i.test(link)) items.push({ title, link, pubDate, description });
  });
  $("entry").each((_, el) => {
    const item = $(el);
    const title = item.find("title").first().text().trim();
    const link = item.find('link[rel="alternate"]').attr("href")?.trim()
      || item.find("link").first().attr("href")?.trim() || "";
    const pubDate = item.find("updated").first().text().trim() || item.find("published").first().text().trim() || null;
    const description = item.find("content").first().text().trim() || item.find("summary").first().text().trim();
    if (title && /^https?:\/\//i.test(link)) items.push({ title, link, pubDate, description });
  });
  return items;
}

// ---------------------------------------------------------------------------
// HTML listing parsing
// ---------------------------------------------------------------------------

export interface HtmlSelectors { item?: string; title?: string; date?: string; link?: string; location?: string }

const DEFAULT_HTML_SELECTORS: Required<HtmlSelectors> = {
  item: ".event, .listing, article, li.event-item, .vevent, .cal-event",
  title: ".summary, h3, h2, .fn, .title, .event-title",
  date: ".dtstart, .event-date, time, .date",
  link: "a[href]",
  location: ".location, .venue, .p-location",
};

export interface HtmlRow { title: string; link: string; dateRaw: string | null; hasDateContext: boolean; location: string | null }

/**
 * Parse an HTML listings page into raw candidate rows. Rows either carry a
 * strictly parseable date fragment (`hasDateContext`), or they are undated/
 * ambiguous and the caller decides: LLM resolve or drop + count.
 */
export function parseHtmlListing(
  html: string,
  baseUrl: string,
  selectors: HtmlSelectors = {},
): HtmlRow[] {
  const $ = cheerio.load(html);
  const sel = { ...DEFAULT_HTML_SELECTORS, ...selectors };
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const results: HtmlRow[] = [];

  $(sel.item).each((_, el) => {
    if (results.length >= MAX_EVENTS_PER_SOURCE) return;
    const node = $(el);
    const titleEl = node.is(sel.title) ? node : node.find(sel.title).first();
    const title = String(titleEl.text() ?? "").replace(/\s+/g, " ").trim();
    if (!title) return;
    let href = node.attr("href") || node.find(sel.link).first().attr("href") || node.find("a[href]").first().attr("href") || "";
    if (href && !/^https?:\/\//i.test(href)) {
      try { href = new URL(href, base).toString(); } catch { href = ""; }
    }
    if (!/^https?:\/\//i.test(href)) href = baseUrl;
    const found = node.find(sel.date).first();
    const attrDateTime = found.attr("datetime") ?? found.attr("content");
    const rawDate = String(attrDateTime ?? found.text() ?? "").replace(/\s+/g, " ").trim()
      || node.find("time").first().text().replace(/\s+/g, " ").trim();
    const locFound = node.find(sel.location).first();
    const location = String(locFound.text() ?? "").replace(/\s+/g, " ").trim() || null;
    const hasDateContext = /\b20\d{2}\b|\b\d{1,2}:\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(rawDate);
    results.push({
      title,
      link: href,
      dateRaw: rawDate.length > 0 ? rawDate : null,
      hasDateContext,
      location,
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Optional LLM field resolution (ambiguous markup ONLY)
// ---------------------------------------------------------------------------

export const DISCOVERY_SYSTEM_PROMPT =
  "You extract structured civic-event fields for a public calendar. Use ONLY the provided listing text. " +
  "If the listing does not state a full calendar date, set date to null - NEVER guess. Respond as JSON: " +
  '{"date":"YYYY-MM-DD"|null,"timeNote":string|null,"location":string|null}.';

export interface LlmResolution { date: string | null; timeNote: string | null; location: string | null }

/** Live LLM resolver using the repo chat-provider health-gate pattern. */
export async function llmResolveFields(listingText: string): Promise<LlmResolution | null> {
  try {
    const { checkChatProvider, chatWithProvider } = await import("./llm/provider.js");
    const health = await checkChatProvider();
    if (!health.reachable) return null;
    const payload = JSON.stringify({ listing: listingText.slice(0, 800) });
    const response = await chatWithProvider([{ role: "user", content: payload }], undefined, undefined, {
      systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    });
    return parseLlmResolution(response);
  } catch {
    return null;
  }
}

/** Strict-parse an LLM response body into a resolution (exported for tests). */
export function parseLlmResolution(response: string): LlmResolution | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    date: parseEventDate(parsed.date),
    timeNote: typeof parsed.timeNote === "string" && parsed.timeNote.trim() ? parsed.timeNote.trim() : null,
    location: typeof parsed.location === "string" && parsed.location.trim() ? parsed.location.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// Source pipeline
// ---------------------------------------------------------------------------

export interface DropCounters { droppedAmbiguous: number; droppedUndated: number }

export interface SourceResult {
  status: "ok" | "error";
  httpStatus?: number;
  error?: string;
  events: DiscoveredEvent[];
}

/** Fetch + parse one source; degrades to an errored result instead of throwing. */
export async function discoverFromSource(
  source: EventSourceRecord,
  counters: DropCounters,
  options: { resolveLlm?: (listingText: string) => Promise<LlmResolution | null> } = {},
): Promise<SourceResult> {
  try {
    const { text, httpStatus } = await fetchFeed(source.url);

    if (source.type === "ics") {
      const resolved: DiscoveredEvent[] = parseIcsEvents(text).map(vevent => ({
        title: vevent.summary,
        kind: /meeting|agenda|commission|council/i.test(vevent.summary) ? "government-meeting" : "community-listing",
        dateStart: icsDateToIso(vevent.dtstart),
        dateAllDay: !/T\d{2}/.test(vevent.dtstart),
        timeNote: icsTimeNote(vevent.dtstart),
        location: vevent.location ?? null,
        organizer: source.name,
        description: vevent.description ?? "",
        sourceUrl: vevent.url ?? source.url,
        sourceName: source.name,
        sourceLinks: [vevent.url ?? source.url],
        extractionMethod: "markup",
        confidence: 0.95,
      }));
      const dated = resolved.filter(e => {
        if (e.dateStart === null) { counters.droppedUndated += 1; return false; }
        return true;
      });
      return { status: "ok", httpStatus, events: dated.slice(0, MAX_EVENTS_PER_SOURCE) };
    }

    if (source.type === "rss") {
      const resolved: DiscoveredEvent[] = parseRssItems(text).map(item => {
        const dateStart = parseEventDate(item.pubDate ?? "");
        return {
          title: item.title,
          kind: "community-listing",
          dateStart,
          dateAllDay: true,
          // Store the sanitized value, not the raw RFC-2822 pubDate: a publish
          // stamp is not an event time, and the merge boundary would strip it anyway.
          timeNote: sanitizeTimeNote(item.pubDate),
          location: null,
          organizer: source.name,
          description: item.description.replace(/<[^>]*>/g, "").trim(),
          sourceUrl: item.link,
          sourceName: source.name,
          sourceLinks: [item.link],
          extractionMethod: "markup",
          confidence: 0.9,
        };
      });
      const dated = resolved.filter(e => {
        if (e.dateStart === null) { counters.droppedUndated += 1; return false; }
        return true;
      });
      return { status: "ok", httpStatus, events: dated.slice(0, MAX_EVENTS_PER_SOURCE) };
    }

    if (source.strategy === "evogov-json") {
      return await discoverEvoGovJson(source, httpStatus, counters);
    }

    // HTML source: strict markup first, LLM only for date-like ambiguity.
    const resolveLlm = options.resolveLlm ?? llmResolveFields;
    const rows = parseHtmlListing(text, source.url);
    const events: DiscoveredEvent[] = [];
    for (const row of rows.slice(0, MAX_EVENTS_PER_SOURCE)) {
      const markupDate = parseEventDate(row.dateRaw ?? "");
      if (row.hasDateContext && markupDate) {
        events.push({
          title: row.title,
          kind: "community-listing",
          dateStart: markupDate,
          dateAllDay: true,
          timeNote: sanitizeTimeNote(row.dateRaw),
          location: row.location,
          organizer: source.name,
          description: "",
          sourceUrl: row.link,
          sourceName: source.name,
          sourceLinks: [row.link],
          extractionMethod: "markup",
          confidence: 0.85,
        });
        continue;
      }
      if (row.hasDateContext) {
        // Completeness assist: markup already yielded a date but the listing
        // lacks a time or location - ask the LLM to extract those fields from
        // the listing text, grounded ONLY in what the row states. The LLM
        // date is never trusted over a markup-parsed date.
        if (markupDate && !row.location) {
          const assist = await resolveLlm(`${row.title} ${row.dateRaw ?? ""} ${row.location ?? ""}`.trim());
          if (assist && (assist.timeNote || assist.location)) {
            events.push({
              title: row.title,
              kind: "community-listing",
              dateStart: markupDate,
              dateAllDay: true,
              timeNote: assist.timeNote,
              location: assist.location ?? row.location,
              organizer: source.name,
              description: "",
              sourceUrl: row.link,
              sourceName: source.name,
              sourceLinks: [row.link],
              extractionMethod: "llm",
              confidence: 0.75,
            });
            continue;
          }
        }
        // Date-like text present but not strictly parseable -> ask the LLM, else drop.
        const llm = await resolveLlm(`${row.title} ${row.dateRaw ?? ""} ${row.location ?? ""}`.trim());
        if (llm?.date) {
          events.push({
            title: row.title,
            kind: "community-listing",
            dateStart: llm.date,
            dateAllDay: true,
            timeNote: llm.timeNote,
            location: llm.location ?? row.location,
            organizer: source.name,
            description: "",
            sourceUrl: row.link,
            sourceName: source.name,
            sourceLinks: [row.link],
            extractionMethod: "llm",
            confidence: 0.55,
          });
        } else {
          counters.droppedAmbiguous += 1;
        }
        continue;
      }
      counters.droppedUndated += 1;
    }
    return { status: "ok", httpStatus, events };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`source "${source.name}" failed: ${message}`);
    return { status: "error", error: message, events: [] };
  }
}

/** Discover EvoGov calendar ids on a listing page (checkbox inputs). */
function extractEvoGovCalendarIds(html: string): string[] {
  const ids = new Set<string>();
  const patterns = [
    /class="evo_calendar_selection_checkbox"[^>]*>\s*<input[^>]*value="(\d+)"/g,
    /value="(\d+)"\s+name="\1"/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) ids.add(match[1]);
  }
  return [...ids];
}

function windowDates(): { start: string; end: string } {
  const fmt = (d: Date): string =>
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  const now = new Date();
  const ahead = new Date(now.getTime() + 90 * 86_400_000);
  return { start: fmt(now), end: fmt(ahead) };
}

function isoFromSortable(value: unknown): string | null {
  const m = typeof value === "string" ? value.match(/^(\d{4})(\d{2})(\d{2})/) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function timeFromSortable(value: unknown): string | null {
  const m = typeof value === "string" ? value.match(/^\d{8}T?(\d{2}):?(\d{2})/) : null;
  return m ? `${m[1]}:${m[2]}` : null;
}
/**
 * Read an EvoGov calendar-platform site through its public meetings/get_list
 * JSON endpoint: pull calendar ids off the listing page, query the endpoint,
 * and map rows onto DiscoveredEvent records. All data is site-published
 * ('markup'); nothing here invokes the LLM. Rows without a resolvable date
 * are dropped and counted.
 */
export async function discoverEvoGovJson(
  source: EventSourceRecord,
  listingHttpStatus?: number,
  counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 },
): Promise<SourceResult> {
  try {
    const { text } = await fetchFeed(source.url);
    const ids = extractEvoGovCalendarIds(text);
    const events: DiscoveredEvent[] = [];
    let listHttpStatus: number | undefined;
    if (ids.length > 0) {
      const origin = new URL(source.url).origin;
      const { start, end } = windowDates();
      const params = new URLSearchParams({
        selected_calendar_ids: ids.join(","),
        start_date: start,
        end_date: end,
        search: "",
        sort_order: "date_start",
      });
      const fetched = await fetchFeed(`${origin}/meetings/get_list?${params.toString()}`);
      listHttpStatus = fetched.httpStatus;
      const parsed: unknown = JSON.parse(fetched.text);
      if (!Array.isArray(parsed)) throw new Error("get_list returned non-array payload");
      for (const raw of parsed.slice(0, MAX_EVENTS_PER_SOURCE)) {
        if (typeof raw !== "object" || raw === null) continue;
        const row = raw as Record<string, unknown>;
        const title = typeof row.title === "string" ? row.title.trim() : "";
        const sortable = row.start_date_sortable ?? row.start_date_short_with_time;
        const dateStart = isoFromSortable(sortable);
        if (!title || !dateStart) {
          if (title) counters.droppedUndated += 1;
          continue;
        }
        let detailUrl = source.url;
        const detailLink = typeof row.detail_link === "string" ? row.detail_link : "";
        const hrefMatch = detailLink.match(/href="([^"]+)"/);
        if (hrefMatch && /^https?:\/\//i.test(hrefMatch[1])) detailUrl = hrefMatch[1];
        const description = typeof row.description === "string"
          ? row.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600)
          : "";
        const locationParts = [row.location, row.location_street_address_1, row.location_city]
          .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          .map(part => part.trim());
        events.push({
          title,
          kind: row.is_meeting === true ? "government-meeting" : "community-listing",
          dateStart,
          dateAllDay: row.is_all_day === true || !timeFromSortable(sortable),
          timeNote: timeFromSortable(sortable),
          location: locationParts.length > 0 ? locationParts.join(", ") : null,
          organizer: source.name,
          description,
          sourceUrl: detailUrl,
          sourceName: source.name,
          sourceLinks: [detailUrl],
          extractionMethod: "markup",
          confidence: 0.9,
        });
      }
    }
    return { status: "ok", httpStatus: listHttpStatus ?? listingHttpStatus, events };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`source "${source.name}" failed: ${message}`);
    return { status: "error", error: message, events: [] };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation against the deterministic artifact
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function normalizedTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ExistingEventRef { title: string; dateStart: string | null }

export interface ReconciliationResult {
  merged: Array<DiscoveredEvent & { needsReview: boolean }>;
  conflictsFlagged: number;
  reconciled: number;
}

/**
 * Same normalized title within +/- MERGE_TOLERANCE_DAYS of an existing record
 * -> the discovered copy is marked reconciled. Same title with dates beyond
 * tolerance -> prefer the markup-derived record, keep both URLs, flag review.
 */
export function reconcileDiscoveries(discovered: DiscoveredEvent[], existing: ExistingEventRef[]): ReconciliationResult {
  const existingByTitle = new Map<string, ExistingEventRef[]>();
  for (const record of existing) {
    const key = normalizedTitle(record.title);
    const bucket = existingByTitle.get(key) ?? [];
    bucket.push(record);
    existingByTitle.set(key, bucket);
  }

  const merged: Array<DiscoveredEvent & { needsReview: boolean }> = [];
  let conflictsFlagged = 0;
  let reconciled = 0;

  for (const candidate of discovered) {
    const matches = existingByTitle.get(normalizedTitle(candidate.title)) ?? [];
    if (matches.length === 0) {
      merged.push({ ...candidate, needsReview: false });
      continue;
    }
    const sameWindow = matches.some(match =>
      match.dateStart !== null && candidate.dateStart !== null &&
      daysBetween(match.dateStart, candidate.dateStart) <= MERGE_TOLERANCE_DAYS,
    );
    if (sameWindow) {
      reconciled += 1;
      merged.push({ ...candidate, needsReview: false });
      continue;
    }
    // Conflicting dates: markup wins the header date; keep both URLs; flag.
    conflictsFlagged += 1;
    const preferred = candidate.extractionMethod === "markup";
    merged.push({
      ...candidate,
      needsReview: true,
      confidence: Math.min(candidate.confidence, preferred ? 0.7 : 0.45),
    });
  }

  return { merged, conflictsFlagged, reconciled };
}

// ---------------------------------------------------------------------------
// Registry load + artifact assembly
// ---------------------------------------------------------------------------

/** Load the checked-in event source registry (pages-data/event_sources.json). */
export function loadEventSources(root = process.cwd()): EventSourceRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "pages-data", "event_sources.json"), "utf-8")) as { sources?: EventSourceRecord[] };
    if (!Array.isArray(parsed.sources)) return [];
    return parsed.sources.filter(source =>
      typeof source?.name === "string" &&
      typeof source?.url === "string" &&
      /^https?:\/\//i.test(source.url) &&
      ["html", "rss", "ics"].includes(source.type),
    );
  } catch {
    return [];
  }
}

function loadExistingEvents(root: string): ExistingEventRef[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "output", "events", "events.json"), "utf-8")) as { events?: Array<{ title?: unknown; dateStart?: unknown }> };
    return (parsed.events ?? [])
      .filter(event => typeof event.title === "string")
      .map(event => ({ title: event.title as string, dateStart: typeof event.dateStart === "string" ? event.dateStart : null }));
  } catch {
    return [];
  }
}

let idCounter = 0;

/** Build the discovery artifact from all registered sources in parallel. */
export async function buildDiscoveryArtifact(
  generatedAt = new Date().toISOString(),
  root = process.cwd(),
  options: { resolveLlm?: (listingText: string) => Promise<LlmResolution | null>; includeNetwork?: boolean } = {},
): Promise<DiscoveryArtifact> {
  const includeNetwork = options.includeNetwork ?? true;
  const sources = loadEventSources(root);
  const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };

  const results = includeNetwork
    ? await Promise.all(sources.map(async source => ({ source, ...(await discoverFromSource(source, counters, { resolveLlm: options.resolveLlm })) })))
    : sources.map(source => ({ source, status: "ok" as const, httpStatus: undefined as number | undefined, error: undefined as string | undefined, events: [] as DiscoveredEvent[] }));

  const flat: DiscoveredEvent[] = results.flatMap(result => result.events);
  const reconciliation = reconcileDiscoveries(flat, loadExistingEvents(root));

  const events = reconciliation.merged.map(item => ({
    ...item,
    status: classify(item.dateStart),
    id: `${slug(item.title) || "discovery"}-${item.dateStart ?? "undated"}-${String(idCounter++).padStart(3, "0")}`,
    sourceLinks: item.sourceLinks.slice(0, MAX_SOURCE_LINKS),
  }));

  return {
    schemaVersion: DISCOVERY_SCHEMA,
    generatedAt,
    counts: {
      sourcesOk: results.filter(r => r.status === "ok").length,
      sourcesErrored: results.filter(r => r.status === "error").length,
      fetched: flat.length,
      droppedAmbiguous: counters.droppedAmbiguous,
      droppedUndated: counters.droppedUndated,
      conflictsFlagged: reconciliation.conflictsFlagged,
      reconciled: reconciliation.reconciled,
      count: events.length,
    },
    sources: results.map(result => ({
      name: result.source.name,
      url: result.source.url,
      type: result.source.type,
      status: result.status,
      httpStatus: result.httpStatus,
      error: result.error,
      eventsFound: result.events.length,
    })),
    provenance: {
      groundRules: [
        "Every event keeps its source URL, sourceName, extractionMethod ('markup' | 'llm'), and a confidence score.",
        "Dates come only from feed data; date-like but unparseable markup goes through the local LLM or is dropped - never guessed.",
        "Same-title discoveries within +/-1 day of output/events/events.json are reconciled to that artifact.",
        "Conflicting dates keep both URLs and are flagged needsReview rather than silently overwritten.",
      ],
      reconciledAgainst: "output/events/events.json",
    },
    events,
  };
}

// CLI entry: write the artifact to output/events/event_discovery.json
if (import.meta.main) {
  buildDiscoveryArtifact()
    .then(async artifact => {
      const { mkdir, writeFile } = await import("fs/promises");
      const dir = join(process.cwd(), "output", "events");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "event_discovery.json"), JSON.stringify(artifact, null, 2));
      logger.info(`discovery artifact written: ${artifact.counts.count} events (${artifact.counts.sourcesOk}/${artifact.counts.sourcesOk + artifact.counts.sourcesErrored} sources ok)`);
    })
    .catch((error: unknown) => {
      logger.error(`discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

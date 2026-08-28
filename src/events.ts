#!/usr/bin/env bun
/**
 * Structured events pipeline — normalizes news, government-meeting, and
 * YouTube output into a single calendar feed (crescent-city-events/v1).
 *
 * Reads whatever each source monitor has already written to output/, does
 * NOT re-fetch from any upstream source itself (that stays each monitor's
 * job). Date handling is strict: dates are only recorded when they can be
 * parsed from the source data itself; items without resolvable dates are
 * either kept as unknown-date meetings/YouTube entries or excluded (news),
 * never guessed.
 *
 * Optional LLM summaries follow the bounded curation pattern: a provider
 * health check first, per-event single-message JSON payloads grounded ONLY
 * in provided fields, trimmed output, and never a thrown error outward.
 *
 * Usage:
 *   bun run src/events.ts [--llm] [--limit N]
 *   bun run events
 */
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from './logger.js';
import { chatWithProvider, checkChatProvider } from './llm/provider.js';
import { writeJsonAtomic } from './shared/source_health.js';

const logger = createLogger('events');

export const EVENTS_SCHEMA = 'crescent-city-events/v1';

/** Hard cap on emitted events so a runaway feed can never bloat Pages. */
export const MAX_EVENTS = 200;
/** Hard cap on merged source links per event. */
export const MAX_SOURCE_LINKS = 8;

export type EventKind =
  | 'government-meeting'
  | 'community-listing'
  | 'civic-news'
  | 'youtube'
  | 'holiday-closure';

export type EventStatus = 'scheduled' | 'completed' | 'unknown';

export interface StructuredEvent {
  id: string;
  title: string;
  kind: EventKind;
  /** ISO yyyy-mm-dd, or null when no date was recorded in the source data. */
  dateStart: string | null;
  dateAllDay: boolean;
  timeNote: string | null;
  location: string | null;
  organizer: string | null;
  status: EventStatus;
  description: string;
  sourceLinks: string[];
  sourceName: string;
  fetchedAt: string | null;
}

export interface EventsArtifact {
  schemaVersion: typeof EVENTS_SCHEMA;
  generatedAt: string;
  count: number;
  llm: {
    attempted: boolean;
    status: 'ok' | 'unavailable' | 'skipped';
    provider: 'ollama' | 'openrouter' | 'none';
    model: string | null;
    summarizedCount: number;
    error?: string;
  };
  provenance: {
    deterministicFrom: ['output/gov_meetings', 'output/news', 'output/youtube'];
    summarizer: string | null;
    boundaries: string[];
  };
  events: StructuredEvent[];
  summaries?: Record<string, {
    text: string;
    status: 'ok' | 'source_only';
    provider: string;
    model: string | null;
    generatedAt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Date parsing & classification
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Values that explicitly mean "no date recorded" rather than a real date. */
const NO_DATE_VALUES = /^(n\/?a|tbd|tba|none|unknown|null)$/i;

/**
 * Parse an ISO yyyy-mm-dd date out of a raw feed value. Returns null for
 * empty, placeholder, or unparseable values — this function never guesses.
 */
export function parseEventDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (NO_DATE_VALUES.test(value)) return null;
  // ISO (or ISO-prefixed) form passes through directly.
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // "Mar 18, 2026" / "March 18, 2026"
  const namedMatch = value.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (namedMatch) {
    const monthIndex = MONTH_NAMES.indexOf(namedMatch[1].toLowerCase());
    if (monthIndex >= 0) {
      const day = Number(namedMatch[2]);
      const year = Number(namedMatch[3]);
      if (day >= 1 && day <= 31 && year >= 1900 && year <= 9999) {
        return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
      return null;
    }
  }
  // Anything else Date.parse can accept (e.g. RFC 822 pubDate values).
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Classify an event by its parsed date: today-or-future is scheduled,
 * past is completed, and a missing date is unknown.
 */
export function classify(dateStart: string | null): EventStatus {
  if (dateStart === null) return 'unknown';
  const today = new Date().toISOString().slice(0, 10);
  return dateStart >= today ? 'scheduled' : 'completed';
}

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

const HOLIDAY_CLOSURE_RE = /holiday|closure|closed|observance/i;

/**
 * Map a source type + raw source name onto an event kind.
 */
export function kindFor(sourceType: string, rawSource?: string): EventKind {
  if (sourceType === 'meetings') return 'government-meeting';
  if (sourceType === 'youtube') return 'youtube';
  const haystack = `${rawSource ?? ''} ${sourceType}`;
  if (HOLIDAY_CLOSURE_RE.test(haystack)) return 'holiday-closure';
  if (/community|listing|event/i.test(`${rawSource ?? ''}`)) return 'community-listing';
  return 'civic-news';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

interface RawEventCandidate {
  title: string;
  link: string;
  sourceLinks: string[];
  kind: EventKind;
  dateStart: string | null;
  dateAllDay: boolean;
  timeNote: string | null;
  location: string | null;
  organizer: string | null;
  description: string;
  sourceName: string;
  fetchedAt: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Convert one raw item into a candidate, or null when it must be excluded. */
function mapCandidate(item: Record<string, unknown>, kind: EventKind, defaultSourceName: string): RawEventCandidate | null {
  const title = str(item.title);
  let link = str(item.link);
  if (!link && typeof item.videoId === 'string' && item.videoId.trim()) {
    link = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId.trim())}`;
  }
  if (!title || !link || !/^https?:\/\//i.test(link)) return null;

  const rawDate = item.date ?? item.pubDate ?? item.uploadDate;
  const dateStart = parseEventDate(rawDate);
  // News items without a resolvable date stay visible as announcements in
  // News but are excluded from the structured calendar.
  if ((kind === 'civic-news' || kind === 'community-listing' || kind === 'holiday-closure') && dateStart === null) {
    return null;
  }

  const content = str(item.content) || str(item.description) || str(item.summary) || str(item.body);
  const rawDateStr = str(rawDate);
  return {
    title,
    link,
    sourceLinks: [link],
    kind,
    dateStart,
    dateAllDay: true,
    timeNote: /\d{1,2}:\d{2}/.test(rawDateStr) ? rawDateStr : null,
    location: str(item.location) || null,
    organizer: str(item.organizer) || str(item.source) || str(item.channel) || null,
    description: content,
    sourceName: str(item.source) || str(item.channel) || defaultSourceName,
    fetchedAt: str(item.fetchedAt) || null,
  };
}

// ---------------------------------------------------------------------------
// Dedupe & merge
// ---------------------------------------------------------------------------

function normalizedTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Stable merge key: normalized title + resolved start date. */
export function dedupeKey(event: Pick<RawEventCandidate, 'title' | 'dateStart'>): string {
  return `${normalizedTitle(event.title)}::${event.dateStart ?? 'no-date'}`;
}

/**
 * Merge candidates sharing a key: union of source links (deduped, capped at
 * MAX_SOURCE_LINKS), first non-null metadata wins. Order is preserved.
 */
export function dedupeAndMerge(candidates: RawEventCandidate[]): RawEventCandidate[] {
  const byKey = new Map<string, RawEventCandidate>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const key = dedupeKey(candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate });
      order.push(key);
      continue;
    }
    existing.sourceLinks.push(...(candidate.sourceLinks ?? []).filter(link => !existing.sourceLinks.includes(link)));
    if (existing.sourceLinks.length > MAX_SOURCE_LINKS) existing.sourceLinks = existing.sourceLinks.slice(0, MAX_SOURCE_LINKS);
    if (existing.dateStart === null) existing.dateStart = candidate.dateStart;
    if (!existing.location) existing.location = candidate.location;
    if (!existing.organizer) existing.organizer = candidate.organizer;
    if (!existing.description) existing.description = candidate.description;
    if (existing.fetchedAt === null) existing.fetchedAt = candidate.fetchedAt;
  }
  return order.map(key => byKey.get(key)!);
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await Bun.file(path).json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    const fsPromises = await import('fs/promises');
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'source-health.json')
      .map(entry => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function loadItems(dir: string, requireItemsArray: boolean): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  for (const path of await listJsonFiles(dir)) {
    const parsed = await readJsonObject(path);
    if (!parsed) continue;
    const batch: unknown[] = Array.isArray(parsed.items)
      ? parsed.items
      : requireItemsArray ? [] : [parsed];
    for (const item of batch) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) items.push(item as Record<string, unknown>);
    }
  }
  return items;
}

/** Read discovered community-calendar events from <outputDir>/events/event_discovery.json. */
async function loadDiscoveryEvents(outputDir: string): Promise<Array<Record<string, unknown>>> {
  const parsed = await readJsonObject(join(outputDir, 'events', 'event_discovery.json'));
  if (!parsed) return [];
  const events = parsed.events;
  if (!Array.isArray(events)) return [];
  return events.flatMap(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    // Discovery artifacts carry `sourceUrl` + `dateStart`; normalize to the
    // `link` + `date` field names mapCandidate expects. A discovery record
    // without both a usable URL and a resolvable date is dropped (never guessed).
    const link = typeof record.sourceUrl === 'string' ? record.sourceUrl.trim() : '';
    if (!/^https?:\/\//i.test(link)) return [];
    return [{ ...record, link, date: record.dateStart ?? record.date }];
  });
}

/**
 * Read deterministic monitor artifacts (<outputDir>/gov_meetings|news|youtube)
 * and produce a sorted, capped list of structured events. Sorts ascending by
 * dateStart with nulls last; caps at MAX_EVENTS. Accepts an explicit output
 * directory so offline tests can point at a temporary fixture tree mirroring
 * the output/ layout.
 */
export async function collectEvents(outputDir = join(process.cwd(), 'output')): Promise<StructuredEvent[]> {
  const base = outputDir.replace(/\/+$/, '');
  const [meetingItems, newsItems, youtubeItems] = await Promise.all([
    loadItems(join(base, 'gov_meetings'), true),
    loadItems(join(base, 'news'), true),
    loadItems(join(base, 'youtube'), false),
  ]);

  const candidates: RawEventCandidate[] = [];
  for (const item of meetingItems) {
    const mapped = mapCandidate(item, kindFor('meetings', str(item.source)), 'Government meeting');
    if (mapped) candidates.push(mapped);
  }
  // Discovered community-calendar events (event_discovery.ts) join the same
  // dedupe/merge pipeline: their date+source grounding is already enforced at
  // discovery time, so any candidate with a URL but no resolvable date is
  // dropped here too — never guessed.
  const discoveryItems = await loadDiscoveryEvents(base);
  for (const item of discoveryItems) {
    // Discovery records name their originating calendar in sourceName; city and
    // county calendars are government sources, so classify accordingly.
    const sourceName = str(item.sourceName);
    const kind: EventKind = /city|county|supervisor|commission|transit|authority|district/i.test(`${sourceName} ${str(item.title)}`)
      ? 'government-meeting'
      : 'community-listing';
    const mapped = mapCandidate(item, kind, 'Community listing');
    if (mapped) candidates.push(mapped);
  }
  for (const item of newsItems) {
    const mapped = mapCandidate(item, kindFor('news', str(item.source)), 'News');
    if (mapped) candidates.push(mapped);
  }
  for (const item of youtubeItems) {
    const mapped = mapCandidate(item, kindFor('youtube'), 'YouTube');
    if (mapped) candidates.push(mapped);
  }

  const withStatus = dedupeAndMerge(candidates).map(candidate => ({
    ...candidate,
    status: classify(candidate.dateStart),
  }));

  const sorted = withStatus.sort((a, b) => {
    if (a.dateStart === null && b.dateStart === null) return a.title.localeCompare(b.title);
    if (a.dateStart === null) return 1;
    if (b.dateStart === null) return -1;
    return a.dateStart.localeCompare(b.dateStart) || a.title.localeCompare(b.title);
  });

  return sorted.slice(0, MAX_EVENTS).map((candidate, index) => ({
    id: `${slug(candidate.title) || 'event'}-${candidate.dateStart ?? 'undated'}-${String(index).padStart(3, '0')}`,
    title: candidate.title,
    kind: candidate.kind,
    dateStart: candidate.dateStart,
    dateAllDay: candidate.dateAllDay,
    timeNote: candidate.timeNote,
    location: candidate.location,
    organizer: candidate.organizer,
    status: candidate.status,
    description: candidate.description,
    sourceLinks: candidate.sourceLinks.slice(0, MAX_SOURCE_LINKS),
    sourceName: candidate.sourceName,
    fetchedAt: candidate.fetchedAt,
  }));
}

// ---------------------------------------------------------------------------
// Optional LLM summarization
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT =
  'You summarize civic events for a public newspaper dashboard. Write a concise, factual preview of at most 3 sentences using ONLY the fields provided. Never invent details, dates, locations, or quotes not present in the input. Respond as JSON: {"summary": "..."}';

const MAX_SUMMARY_CHARS = 480;

function extractSummaryText(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Providers occasionally wrap JSON in prose; fall back to trimmed raw text.
    const text = payload.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const summary = (parsed as Record<string, unknown>).summary;
    if (typeof summary === 'string' && summary.trim()) return summary.trim();
  }
  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  return null;
}

/**
 * Best-effort LLM previews for the first `limit` events. When the configured
 * chat provider is unreachable, returns an empty results object without
 * throwing — callers degrade to source-only rendering.
 */
export async function summarizeEvents(
  events: StructuredEvent[],
  limit = 200,
  generatedAt = new Date().toISOString(),
): Promise<NonNullable<EventsArtifact['summaries']>> {
  const results: NonNullable<EventsArtifact['summaries']> = {};
  const targets = events.slice(0, Math.max(0, limit));
  if (targets.length === 0) return results;

  const health = await checkChatProvider();
  if (!health.reachable) return results;

  for (const event of targets) {
    try {
      const payload = JSON.stringify({
        id: event.id,
        title: event.title,
        kind: event.kind,
        dateStart: event.dateStart,
        location: event.location,
        organizer: event.organizer,
        description: event.description.slice(0, 1200),
        sourceName: event.sourceName,
      });
      const response = await chatWithProvider(
        [{ role: 'user', content: payload }],
        undefined,
        undefined,
        { systemPrompt: SYSTEM_PROMPT },
      );
      const text = extractSummaryText(response)?.slice(0, MAX_SUMMARY_CHARS) ?? '';
      results[event.id] = {
        text,
        status: text.length > 0 ? 'ok' : 'source_only',
        provider: health.provider,
        model: health.model || null,
        generatedAt,
      };
    } catch {
      results[event.id] = { text: '', status: 'source_only', provider: health.provider, model: health.model || null, generatedAt };
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Artifact assembly & CLI
// ---------------------------------------------------------------------------

/** Deterministic wrapper around collected events. */
export function buildEventsArtifact(generatedAt: string, events: StructuredEvent[]): EventsArtifact {
  return {
    schemaVersion: EVENTS_SCHEMA,
    generatedAt,
    count: events.length,
    llm: {
      attempted: false,
      status: 'skipped',
      provider: 'none',
      model: null,
      summarizedCount: 0,
    },
    provenance: {
      deterministicFrom: ['output/gov_meetings', 'output/news', 'output/youtube'],
      summarizer: null,
      boundaries: [
        'Dates are recorded only when present in source data; undated news stays out of the calendar.',
        'LLM summaries are advisory previews; verify against the linked sources.',
        'No live fetching happens here — artifacts come from prior monitor runs.',
      ],
    },
    events,
  };
}

// ---------------------------------------------------------------------------
// iCalendar export
// ---------------------------------------------------------------------------

/** Domain suffix appended after "@" in generated VEVENT UIDs. */
export const ICS_UID_DOMAIN = "crescent-city-intel";
/** Fallback DTSTAMP used when callers omit a stamp — keeps output deterministic. */
export const ICS_DEFAULT_STAMP = "19700101T000000Z";

/**
 * Escape a text value per RFC 5545 §3.3.11: backslashes, semicolons, commas,
 * and newlines must be escaped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Convert an ISO yyyy-mm-dd date to the ICS yyyymmdd form. */
export function formatIcsDate(date: string): string {
  return date.replace(/-/g, "");
}

/** Convert an ISO-ish timestamp (yyyy-mm-ddThh:mm:ss[.mmm]Z) to ICS UTC form. */
export function formatIcsStamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return ICS_DEFAULT_STAMP;
  return `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}Z`;
}

/**
 * The day after an ISO yyyy-mm-dd date, used as the exclusive end for
 * all-day events. Returns null for values it cannot safely advance.
 */
export function nextIsoDay(date: string): string | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const advanced = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${advanced.getUTCFullYear()}-${pad(advanced.getUTCMonth() + 1)}-${pad(advanced.getUTCDate())}`;
}

/**
 * Pure iCalendar builder: renders the structured calendar as RFC 5545 text.
 * Deterministic — no clock reads; DTSTAMP comes from the explicit stamp (or
 * the fixed default). Undated events are skipped because DTSTART is required.
 */
export function buildEventsIcs(
  events: ReadonlyArray<Pick<StructuredEvent, "id" | "title" | "dateStart" | "location" | "description" | "sourceLinks" | "status">>,
  options: { stamp?: string } = {},
): string {
  const dtStamp = options.stamp ? formatIcsStamp(options.stamp) : ICS_DEFAULT_STAMP;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crescent City Intel//Events Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const event of events) {
    if (!event.dateStart) continue;
    const dtEnd = nextIsoDay(event.dateStart);
    if (!dtEnd) continue;
    const links = (Array.isArray(event.sourceLinks) ? event.sourceLinks : []).filter(link =>
      /^https?:\/\//i.test(String(link)),
    );
    // Extendable mapping: extend here when EventStatus gains new values.
    const statusMap: Record<string, string> = { scheduled: "CONFIRMED", completed: "CONFIRMED", unknown: "TENTATIVE", cancelled: "CANCELLED" };
    const status = statusMap[event.status] ?? "TENTATIVE";
    const eventLines = [
      "BEGIN:VEVENT",
      `UID:${event.id || "event"}@${ICS_UID_DOMAIN}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;VALUE=DATE:${formatIcsDate(event.dateStart)}`,
      `DTEND;VALUE=DATE:${formatIcsDate(dtEnd)}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
    ];
    if (event.description && event.description.trim()) {
      eventLines.push(`DESCRIPTION:${escapeIcsText(event.description.trim())}`);
    }
    if (event.location && event.location.trim()) {
      eventLines.push(`LOCATION:${escapeIcsText(event.location.trim())}`);
    }
    if (links.length > 0) eventLines.push(`URL:${links[0]}`);
    eventLines.push(`STATUS:${status}`, "END:VEVENT");
    for (const line of eventLines) lines.push(...foldIcsLine(line));
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Fold one content line to at most 75 octets per RFC 5545 §3.1.
 * Continuation lines start with one space; UTF-8 sequences are never split.
 */
export function foldIcsLine(line: string): string[] {
  if (line.length === 0) return [line];
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return [line];
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    let budget = parts.length === 0 ? 75 : 74;
    const chunkStart = cursor;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (width > budget) break;
      cursor += width;
      budget -= width;
    }
    if (cursor === chunkStart) break;
    parts.push(new TextDecoder().decode(bytes.slice(chunkStart, cursor)));
  }
  return [parts[0]!, ...parts.slice(1).map(part => ` ${part}`)];
}

async function main(argv: string[]): Promise<void> {
  const wantsLlm = argv.includes('--llm');
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 200;
  const generatedAt = new Date().toISOString();

  const events = await collectEvents();
  let summaries: NonNullable<EventsArtifact['summaries']> | undefined;
  let llm: EventsArtifact['llm'] = { attempted: wantsLlm, status: 'skipped', provider: 'none', model: null, summarizedCount: 0 };

  if (wantsLlm) {
    const health = await checkChatProvider();
    if (!health.reachable) {
      llm = { attempted: true, status: 'unavailable', provider: health.provider, model: health.model || null, summarizedCount: 0, error: health.error };
      logger.warn(`chat provider unreachable (${health.provider}); skipping event summaries`);
    } else {
      summaries = await summarizeEvents(events, Number.isFinite(limit) ? limit : 200, generatedAt);
      llm = {
        attempted: true,
        status: 'ok',
        provider: health.provider,
        model: health.model || null,
        summarizedCount: Object.values(summaries).filter(entry => entry.status === 'ok').length,
      };
    }
  }

  const artifact = buildEventsArtifact(generatedAt, events);
  if (summaries !== undefined && Object.keys(summaries).length > 0) {
    artifact.summaries = summaries;
  }
  artifact.llm = llm;

  const destination = join(process.cwd(), 'output', 'events', 'events.json');
  await mkdir(join(process.cwd(), 'output', 'events'), { recursive: true });
  await writeJsonAtomic(destination, artifact);
  const icsDestination = join(process.cwd(), 'output', 'events', 'events.ics');
  await Bun.write(icsDestination, buildEventsIcs(artifact.events, { stamp: generatedAt }));
  logger.info(`wrote ${artifact.count} events (${artifact.llm.status}${artifact.summaries ? `, ${Object.keys(artifact.summaries).length} summaries` : ''}) -> ${destination} + ${icsDestination}`);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}

#!/usr/bin/env bun
/**
 * Government meeting tracking automation for Crescent City.
 * Tracks agendas and minutes for city council, planning commission, and harbor commission.
 * Implements proper HTML parsing and change detection for monitoring updates.
 * Last run: 2026-03-14T17:09:13.120Z
 */
import { createLogger } from './logger.js';
import { computeSha256, htmlToText } from './utils.js';
import { join } from 'path';
import { IdempotencyStore } from './shared/idempotency.js';
import { paths } from './shared/paths.js';
import { errorMessage, sourceHealth, SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic } from './shared/source_health.js';
import { computeDocumentHashes, diffDocumentHashes, extractVotes, fetchDocumentText } from './minutes_extraction.js';
import type { DocumentDrift } from './minutes_extraction.js';
import type { SourceHealth } from './types.js';

const logger = createLogger('gov_meeting_monitor');

// Government meeting sources.
//
// The city migrated its site to the EvoGov CMS at some point after these
// URLs were first configured; all three 404'd (confirmed live 2026-07-24).
// EvoGov renders its meeting calendar client-side via JS, but the widget
// itself calls a same-origin JSON endpoint to populate it — found by
// capturing network traffic with Playwright against the real
// https://www.crescentcity.org/meetings page. That endpoint is what
// fetchGovMeetings() now calls for every source below; City Council and
// Planning Commission meetings both live on the SAME calendar ("Meetings
// and Events", id 666) and are distinguished only by `title`, not by a
// separate URL or calendar id — confirmed by inspecting a full year of
// real response data (title values included "City Council Meeting",
// "Special City Council Meeting", "City Council Budget Workshop",
// "Planning Commission Meeting", among others).
//
// Harbor Commission has no presence on this endpoint at all (checked
// against a full year of titles), and its own domain
// (crescentcityharbor.com / www.crescentcityharbor.com) no longer resolves
// in DNS (confirmed live 2026-07-24: "Could not resolve host"). There is
// currently no known digital source for Harbor Commission agendas — kept
// here so the filter runs (and honestly returns zero rather than the
// misleading "unreachable" it would 404 with previously), not because a
// real source was found. See TODO.md Phase 4.2.
const EVOGOV_MEETINGS_API = 'https://www.crescentcity.org/meetings/get_list';
const GOV_SOURCES = {
  'City Council': EVOGOV_MEETINGS_API,
  'Planning Commission': EVOGOV_MEETINGS_API,
  'Harbor Commission': EVOGOV_MEETINGS_API,
};

/**
 * Persistent change-detection index (id = meeting link, hash = content hash).
 * Was previously an in-memory-only Map (PROCESSED_MEETING_CACHE) that never
 * survived across separate CLI invocations, so every run silently treated
 * every item as new — this is a real cross-run idempotency fix, not just a
 * refactor. Cap of 500 preserved from the prior in-memory cache's own limit.
 *
 * Lives under output/state/, NOT output/gov_meetings/ — colocating it with
 * the batch output broke tests/gov_meeting_monitor.test.ts's naive "sort
 * output/gov_meetings/*.json and take the last" lookup, since
 * "seen-meetings.json" sorts alphabetically after every "gov_meetings-*"
 * timestamped file and has a different (non-batch) shape.
 */
const MEETING_CACHE_PATH = join(process.cwd(), 'output', 'state', 'gov-meetings-seen.json');
const meetingCache = new IdempotencyStore(MEETING_CACHE_PATH, 500);

/**
 * Generate a hash for content to detect changes.
 *
 * Was previously declared to return `string` while actually returning the
 * unawaited `computeSha256(...)` Promise object itself — `tsc --noEmit`
 * confirms this was a genuine pre-existing type error (TS2322), and at
 * runtime it meant every "hash" was a fresh Promise instance, so the
 * `cached.hash !== hash` change-detection comparison two Promise objects
 * were (by reference) essentially always unequal — change detection was
 * silently non-functional. Fixed by making this properly async/awaited.
 */
async function generateContentHash(content: string): Promise<string> {
  return computeSha256(content.trim());
}

/** Raw shape of one item from the EvoGov `/meetings/get_list` JSON endpoint (fields we use only). */
interface EvoGovMeetingItem {
  id: number;
  title: string;
  description?: string;
  start_date_short?: string;
  start_date_day_of_week?: string;
  agenda_links?: string[];
  minute_links?: string[];
}

/** A parsed document link with its display title (agenda/minutes). */
export interface LinkItem {
  title: string;
  url: string;
}

/**
 * Pure: parse an array of raw anchor-tag HTML strings into structured
 * {title, url} items (used for agenda/minutes). Falls back to the URL when the
 * anchor has no text, and resolves relative hrefs against the city origin.
 */
export function extractLinkItems(htmlAnchors: string[] | undefined): LinkItem[] {
  if (!htmlAnchors) return [];
  const items: LinkItem[] = [];
  for (const anchor of htmlAnchors) {
    const hrefMatch = anchor.match(/href=["']([^"']+)["']/);
    if (!hrefMatch) continue;
    const url = new URL(hrefMatch[1], "https://www.crescentcity.org").toString();
    const titleText = anchor
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#039;|&apos;/g, "'")
      .trim();
    items.push({ title: titleText || url, url });
  }
  return items;
}

/** Extract every `href="..."` URL out of an array of raw anchor-tag HTML strings. */
function extractLinkUrls(htmlAnchors: string[] | undefined): string[] {
  if (!htmlAnchors) return [];
  const urls: string[] = [];
  for (const anchor of htmlAnchors) {
    const match = anchor.match(/href="([^"]+)"/);
    // Some agenda/minute links are absolute (evogov's S3 bucket), others are
    // site-relative ("/meetingfiles/..."); resolve both against the site
    // origin so every stored URL is directly fetchable/clickable on its own
    // (confirmed live 2026-07-24: relative links appear alongside absolute
    // ones in the same response, not just historically).
    if (match) urls.push(new URL(match[1], "https://www.crescentcity.org").toString());
  }
  return urls;
}

// ─── Vote extraction ──────────────────────────────────────────────

/** Structured result of parsing yea/nay/abstain votes from meeting minutes text. */
export interface VoteResult {
  yea: number;
  nay: number;
  abstain: number;
  passed: boolean;
  details: string[];
}

/**
 * Parse vote tallies from meeting minutes or agenda text.
 *
 * Detects patterns such as:
 *   "Vote: 5 yea, 2 nay, 0 abstain"
 *   "Motion: ... passes 5-2"
 *   "Motion: ... fails 3-4"
 *   "Councilmember Smith: Yea, Councilmember Jones: Nay" (roll call)
 *   "5 AYES, 2 NOES, 0 ABSTENTIONS"
 *   "Approved 5-0" / "Denied 3-2"
 *
 * Returns a structured VoteResult when a vote pattern is recognisable,
 * or null when the text contains no parseable vote data. Never throws.
 */
export function parseVotes(text: string): VoteResult | null {
  if (!text || typeof text !== 'string') return null;

  const cleaned = text.replace(/\s+/g, ' ').trim();
  const details: string[] = [];
  let yea: number | null = null;
  let nay: number | null = null;
  let abstain: number | null = null;
  let passed: boolean | null = null;
  const lower = cleaned.toLowerCase();

  // Pattern 1: "Vote: X yea, Y nay, Z abstain" (and variants)
  //   e.g. "Vote: 5 yea, 2 nay, 0 abstain"
  //   e.g. "5 AYES, 2 NOES, 0 ABSTENTIONS"
  const voteTallyMatch = cleaned.match(
    /(\d+)\s+(yea|ayes?|yes|in\s+favor)\D+(\d+)\s+(nay|noes?|no|opposed|against)\D*(?:(\d+)\s+(abstain|abstentions?|absent))?/i
  );
  if (voteTallyMatch) {
    yea = parseInt(voteTallyMatch[1], 10);
    nay = parseInt(voteTallyMatch[3], 10);
    abstain = voteTallyMatch[5] ? parseInt(voteTallyMatch[5], 10) : 0;
    details.push(`Vote tally: ${yea}-${nay}-${abstain}`);
  }

  // Pattern 2: "Motion ... passes/fails/adopted/denied X-Y" or "Passed X-Y"
  //   e.g. "Motion passes 5-2"
  //   e.g. "Motion carries 5-0"
  //   e.g. "Motion fails 3-4"
  //   e.g. "Approved 5-0"
  //   e.g. "Denied 3-2"
  const motionMatch = cleaned.match(
    /(?:motion\s+|\b)(passes|passed|carries|carried|adopted?|approved|fails?|failed|denied|rejected|defeated|lost)\b\s*(\d+)\s*[-–]\s*(\d+)/i
  );
  if (motionMatch) {
    const verb = motionMatch[1].toLowerCase();
    // passed verbs
    if (/^(passes|passed|carries|carried|adopted|approved)$/i.test(verb)) {
      passed = true;
    } else {
      passed = false;
    }
    // The first number is the winning side
    const num1 = parseInt(motionMatch[2], 10);
    const num2 = parseInt(motionMatch[3], 10);
    // num1 is always the yea/for count, num2 is the nay/against count
    // regardless of whether the motion passed or failed
    yea = yea ?? num1;
    nay = nay ?? num2;
    abstain = abstain ?? 0;
    details.push(`Motion ${verb}: ${num1}-${num2}`);
  }

  // Pattern 3: Roll call — extract named votes
  //   e.g. "Councilmember Smith: Yea, Councilmember Jones: Nay"
  //   e.g. "Smith - Yea / Jones - Nay / Brown - Abstain"
  const rollCallMatches = cleaned.matchAll(
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[:–\-—]\s*(Yea|Aye|Yes|Nay|No|Abstain|Absent)/gi
  );
  let rollCallCount = 0;
  for (const rc of rollCallMatches) {
    const person = rc[1].trim();
    const vote = rc[2].toLowerCase();
    details.push(`${person}: ${rc[2]}`);
    rollCallCount++;
  }
  if (rollCallCount > 0 && yea === null) {
    // Count the roll call votes if we didn't already get a tally
    // We re-collect here since we already consumed the iterator
    const rcMatches = cleaned.matchAll(
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[:–\-—]\s*(Yea|Aye|Yes|Nay|No|Abstain|Absent)/gi
    );
    let rcYea = 0, rcNay = 0, rcAbs = 0;
    for (const rc of rcMatches) {
      const vote = rc[2].toLowerCase();
      if (/^(yea|aye|yes)$/i.test(vote)) rcYea++;
      else if (/^(nay|no)$/i.test(vote)) rcNay++;
      else if (/^(abstain|absent)$/i.test(vote)) rcAbs++;
    }
    // Only use roll call counts if we have enough named entries (>= 2)
    if (rcYea + rcNay + rcAbs >= 2) {
      yea = rcYea;
      nay = rcNay;
      abstain = rcAbs;
    }
  }

  // Pattern 4: "X yea, Y nay" without the word "Vote:" (common in agenda descriptions)
  if (yea === null) {
    const simpleTally = cleaned.match(
      /(\d+)\s+(yea|aye)\D+(\d+)\s+(nay|no)\b/i
    );
    if (simpleTally) {
      yea = parseInt(simpleTally[1], 10);
      nay = parseInt(simpleTally[3], 10);
      abstain = abstain ?? 0;
      details.push(`Tally: ${yea}-${nay}`);
    }
  }

  // If we have numbers, determine passed
  if (yea !== null && nay !== null) {
    if (passed === null) {
      passed = yea > nay;
    }
    return {
      yea,
      nay,
      abstain: abstain ?? 0,
      passed,
      details: details.filter((d, i, a) => a.indexOf(d) === i), // dedupe
    };
  }

  // Pattern 5: "Approved/Denied/Passed/Failed" without numbers — mark as passed/failed but cannot count
  const approvalMatch = cleaned.match(
    /\b(unanimously\s+)?(approved|denied|rejected|defeated|passed|failed|adopted)\b/i
  );
  if (approvalMatch) {
    const verb = approvalMatch[2].toLowerCase();
    if (/^(approved|adopted|passed)$/i.test(verb)) {
      return { yea: 0, nay: 0, abstain: 0, passed: true, details: [`Motion ${verb}`] };
    } else if (/^(denied|rejected|defeated|failed)$/i.test(verb)) {
      return { yea: 0, nay: 0, abstain: 0, passed: false, details: [`Motion ${verb}`] };
    }
  }

  return null;
}

// ─── EvoGov fetch ─────────────────────────────────────────────────

// City Council/Planning Commission/Harbor Commission all read from the same
// EvoGov endpoint, filtered down by title per source (see GOV_SOURCES
// comment above). Each GOV_SOURCES entry does its own real fetch here
// (deliberately not cached across sources) so a bad/unreachable `apiUrl`
// passed to any single source — including the direct unit tests that pass a
// nonexistent or 404 URL — always exercises a real fetch of exactly that
// URL, never stale data left over from a different source's successful call.
async function fetchEvoGovMeetings(apiUrl: string): Promise<EvoGovMeetingItem[]> {
  // Recent past (catch newly-posted minutes for meetings that already
  // happened) through upcoming (catch newly-posted agendas).
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

  const url = `${apiUrl}?selected_calendar_ids=685,739,666,670,689&start_date=${fmt(start)}&end_date=${fmt(end)}&search=&sort_order=date_start&current_webpage=meeting`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)' },
    signal: AbortSignal.timeout(Number(process.env.GOV_MEETINGS_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS)),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return (await response.json()) as EvoGovMeetingItem[];
}

/**
 * Fetch government meetings for one source (City Council / Planning
 * Commission / Harbor Commission) from the city's EvoGov meetings API,
 * filtering the shared feed down to items whose title names this source.
 */
export interface GovMeetingFetchResult {
  items: Array<{title: string, link: string, date: string, content: string, hash: string, agendaItems?: LinkItem[], minuteItems?: LinkItem[], vote?: VoteResult | null, docHashes?: Record<string, string>, voteTable?: import('./minutes_extraction.js').VoteResult[]}>;
  health: SourceHealth;
}

export async function fetchGovMeetingsDetailed(url: string, sourceName: string): Promise<GovMeetingFetchResult> {
  const checkedAt = new Date().toISOString();
  try {
    logger.info(`Fetching government meetings from ${sourceName}`, { url });

    const allItems = await fetchEvoGovMeetings(url);
    const matching = allItems.filter(item => item.title.toLowerCase().includes(sourceName.toLowerCase()));

    const items: Array<{title: string, link: string, date: string, content: string, hash: string, agendaItems?: LinkItem[], minuteItems?: LinkItem[], vote?: VoteResult | null}> = [];
    for (const item of matching) {
      const link = `https://www.crescentcity.org/events/${item.id}/`;
      const date = item.start_date_short ?? item.start_date_day_of_week ?? '';
      const agendaUrls = extractLinkUrls(item.agenda_links);
      const minuteUrls = extractLinkUrls(item.minute_links);
      const agendaItems = extractLinkItems(item.agenda_links);
      const minuteItems = extractLinkItems(item.minute_links);
      const descriptionText = htmlToText(item.description ?? '').substring(0, 800);
      const contentParts = [descriptionText];
      if (agendaUrls.length) contentParts.push(`Agenda: ${agendaUrls.join(', ')}`);
      if (minuteUrls.length) contentParts.push(`Minutes: ${minuteUrls.join(', ')}`);
      const content = contentParts.filter(Boolean).join(' | ');

      // Try to parse votes from the description text
      const vote = parseVotes(item.description ?? '');

      // Phase 4.2: fetch agenda/minutes documents (bounded), hash them for
      // change detection, and extract every vote tally from minutes text.
      const docUrls = [...new Set([...agendaUrls, ...minuteUrls])];
      const docs: Array<{ url: string; text: string }> = [];
      const docTimeoutMs = Number(process.env.GOV_MEETINGS_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS);
      for (const docUrl of docUrls) {
        const text = await fetchDocumentText(docUrl, docTimeoutMs);
        if (text !== null) docs.push({ url: docUrl, text });
      }
      let docHashes: Record<string, string> | undefined;
      let voteTable: import('./minutes_extraction.js').VoteResult[] | undefined;
      if (docs.length > 0) {
        docHashes = await computeDocumentHashes(docs);
        const minutesTexts = docs.filter(d => minuteUrls.includes(d.url)).map(d => d.text);
        const allVotes = minutesTexts.flatMap(t => extractVotes(t));
        if (allVotes.length > 0) voteTable = allVotes;
      }

      const hashContent = `${item.title}|${link}|${date}|${content}`;
      const hash = await generateContentHash(hashContent);

      items.push({ title: item.title, link, date, content, hash, vote, ...(agendaItems.length ? { agendaItems } : {}), ...(minuteItems.length ? { minuteItems } : {}), ...(docHashes ? { docHashes } : {}), ...(voteTable ? { voteTable } : {}) });
    }

    logger.info(`Found ${items.length} meeting-related items from ${sourceName}`, { count: items.length });
    return {
      items,
      health: sourceHealth(sourceName, items.length > 0 ? 'ok' : 'empty', checkedAt, {
        url,
        fetchedAt: checkedAt,
        itemCount: items.length,
        provenance: 'EvoGov meetings JSON endpoint',
      }),
    };

  } catch (error: unknown) {
    logger.error(`Failed to fetch government meetings from ${sourceName}`, { error: errorMessage(error), url });
    return {
      items: [],
      health: sourceHealth(sourceName, 'unavailable', checkedAt, {
        url,
        itemCount: 0,
        error: errorMessage(error),
        provenance: 'EvoGov meetings JSON endpoint',
      }),
    };
  }
}

/** Backwards-compatible item-only meeting fetch API. */
export async function fetchGovMeetings(url: string, sourceName: string): Promise<Array<{title: string, link: string, date: string, content: string, hash: string}>> {
  return (await fetchGovMeetingsDetailed(url, sourceName)).items;
}

/**
 * Save meeting items to a JSON file for historical tracking with change detection
 */
export async function saveMeetingItems(items: Array<{title: string, link: string, date: string, content: string, source: string, fetchedAt: string, isNew: boolean, changed: boolean, vote?: VoteResult | null}>): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  const dataDir = path.join(process.cwd(), 'output', 'gov_meetings');
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (e) {
    // Directory might already exist
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(dataDir, `gov_meetings-${timestamp}.json`);
  
  // Separate new and changed items for better tracking
  const newItems = items.filter(item => item.isNew);
  const changedItems = items.filter(item => item.changed && !item.isNew);
  const unchangedItems = items.filter(item => !item.changed && !item.isNew);
  
  const data = {
    fetchedAt: new Date().toISOString(),
    totalItems: items.length,
    newItems: newItems.length,
    changedItems: changedItems.length,
    unchangedItems: unchangedItems.length,
    itemsBySource: {} as Record<string, number>,
    items: items
  };
  
  // Count items by source
  items.forEach(item => {
    data.itemsBySource[item.source] = (data.itemsBySource[item.source] || 0) + 1;
  });
  
  await fs.writeFile(filename, JSON.stringify(data, null, 2));
  logger.info(`Saved meeting items to ${filename}`);
  
  if (newItems.length > 0) {
    logger.info(`Found ${newItems.length} NEW meeting items`);
  }
  if (changedItems.length > 0) {
    logger.info(`Found ${changedItems.length} CHANGED meeting items`);
  }
}

const MEETING_DOC_HASHES_PATH = join(process.cwd(), 'output', 'state', 'meeting-doc-hashes.json');

/** Load the previously recorded agenda/minutes document hash map (empty when absent). */
async function loadMeetingDocHashes(): Promise<Record<string, string>> {
  try {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(MEETING_DOC_HASHES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomically persist the current agenda/minutes document hash map. */
async function saveMeetingDocHashes(hashes: Record<string, string>): Promise<void> {
  await writeJsonAtomic(MEETING_DOC_HASHES_PATH, { savedAt: new Date().toISOString(), hashes });
}

/**
 * Main government meeting monitoring function with change detection
 */
export interface GovMeetingItem {
  title: string;
  link: string;
  date: string;
  content: string;
  source: string;
  fetchedAt: string;
  isNew: boolean;
  changed: boolean;
  vote?: VoteResult | null;
  docHashes?: Record<string, string>;
  voteTable?: import('./minutes_extraction.js').VoteResult[];
}

export async function monitorGovMeetings(): Promise<GovMeetingItem[]> {
  logger.info('=== Starting Crescent City Government Meeting Monitoring ===');

  // Load the persistent change-detection index (shared store — this is what
  // gives cross-run idempotency; the prior in-memory Map never had it)
  await meetingCache.load();

  const allItems: GovMeetingItem[] = [];
  const health: SourceHealth[] = [];

  // Fetch from each government source
  for (const [sourceName, url] of Object.entries(GOV_SOURCES)) {
    try {
      const result = await fetchGovMeetingsDetailed(url, sourceName);
      health.push(result.health);
      const items = result.items;
      for (const item of items) {
        // Check for changes
        const changeResult = meetingCache.seen(item.link, item.hash);

        allItems.push({
          ...item,
          source: sourceName,
          fetchedAt: new Date().toISOString(),
          isNew: changeResult.isNew,
          changed: changeResult.changed
        });
      }
    } catch (error: unknown) {
      const checkedAt = new Date().toISOString();
      health.push(sourceHealth(sourceName, 'unavailable', checkedAt, {
        url,
        error: errorMessage(error),
        provenance: 'EvoGov meetings JSON endpoint',
      }));
      logger.error(`Error processing ${sourceName}`, { error: errorMessage(error) });
    }
  }

  // Persist the updated change-detection index
  await meetingCache.save();

  // Phase 4.2: agenda/minutes document hash drift, surfaced in the meeting report.
  let documentDrift: DocumentDrift[] = [];
  try {
    const previous = await loadMeetingDocHashes();
    const current: Record<string, string> = {};
    for (const item of allItems) {
      if (item.docHashes) Object.assign(current, item.docHashes);
    }
    documentDrift = diffDocumentHashes(previous, current);
    await saveMeetingDocHashes(current);
    const changedDocs = documentDrift.filter(d => d.changed);
    if (changedDocs.length > 0) {
      logger.info(`Document hash drift detected for ${changedDocs.length} agenda/minutes document(s)`);
    }
  } catch (error: unknown) {
    logger.warn(`Document hash drift tracking failed: ${errorMessage(error)}`);
  }
  await writeJsonAtomic(paths.govMeetingsHealth, {
    checkedAt: new Date().toISOString(),
    sources: health,
    // Phase 4.2: agenda/minutes SHA-256 drift surfaced in the meeting report.
    documentDrift,
  });

  // Sort by date (newest first), then by source
  allItems.sort((a, b) => {
    // Try to parse dates for sorting
    const dateA = a.date ? new Date(a.date.replace(/[\\/\\-]/g, '/')).getTime() : 0;
    const dateB = b.date ? new Date(b.date.replace(/[\\/\\-]/g, '/')).getTime() : 0;
    
    if (dateA !== dateB) {
      return dateB - dateA; // Newest first
    }
    return a.source.localeCompare(b.source); // Then by source name
  });
  
  // Save the results
  if (allItems.length > 0) {
    await saveMeetingItems(allItems);
    logger.info(`Government meeting monitoring complete: ${allItems.length} items found`);
    
    // Log summary
    const newCount = allItems.filter(item => item.isNew).length;
    const changedCount = allItems.filter(item => item.changed && !item.isNew).length;
    
    if (newCount > 0) {
      logger.info(`Found ${newCount} NEW meeting items`);
    }
    if (changedCount > 0) {
      logger.info(`Found ${changedCount} CHANGED meeting items`);
    }
    
    // Log the top 3 items for immediate visibility (prioritizing new/changed)
    const priorityItems = [...allItems.filter(item => item.isNew || item.changed), ...allItems.filter(item => !(item.isNew || item.changed))];
    for (let i = 0; i < Math.min(3, priorityItems.length); i++) {
      const item = priorityItems[i];
      logger.info(`Top meeting item ${i+1}:`, {
        title: item.title,
        source: item.source,
        date: item.date || 'No date',
        status: item.isNew ? 'NEW' : item.changed ? 'CHANGED' : 'UNCHANGED'
      });
    }
  } else {
    logger.warn('No government meeting items found in this cycle');
  }

  logger.info('=== Government Meeting Monitoring Complete ===');
  return allItems;
}

// Run the monitoring if this script is executed directly
if (import.meta.main) {
  monitorGovMeetings().catch(error => {
    logger.error('Government meeting monitoring failed', { error: error.message });
    process.exit(1);
  });
}

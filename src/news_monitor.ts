#!/usr/bin/env bun
/**
 * News monitoring automation for Crescent City.
 *
 * Fetches RSS/Atom/JSON feeds from current North Coast civic and news sources.
 * Uses proper XML parsing via @xmldom/xmldom for reliability.
 * Deduplicates across sources and filters for Crescent City–relevant content.
 *
 * Usage:
 *   bun run src/news_monitor.ts
 *   bun run news
 *
 * Output: JSON files written to output/news/
 */
import { createLogger } from './logger.js';
import { htmlToText } from './utils.js';
import { DOMParser } from '@xmldom/xmldom';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { IdempotencyStore } from './shared/idempotency.js';
import { boundedHttpFetch as fetch, type TransportOptions, withinDeadline, waitWithSignal } from './shared/transport.js';
import { paths, outputRoot } from './shared/paths.js';
import { errorMessage, sourceHealth, SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonl } from './shared/source_health.js';
import { sourceIdForMonitor } from './source_registry.js';
import type { SourceHealth } from './types.js';
import { replaceArtifacts, recoverArtifactTransactions, type ArtifactReplacement } from './shared/artifact_transaction.js';
import { withProducerScope, currentRunSignal, type ProducerOptions } from './shared/run_scope.js';
import { currentCivicProfile, isCrescentCityProfile } from './civic_profile.js';

const logger = createLogger('news_monitor');

function newsSourceHealth(...args: Parameters<typeof sourceHealth>): SourceHealth {
  const [name, status, checkedAt, details] = args;
  const canonicalId = isCrescentCityProfile() && Object.hasOwn(NEWS_FEEDS, name) ? sourceIdForMonitor(name === "Del Norte Triplicate" ? "triplicate" : `news:${name}`) : undefined;
  const customId = `${currentCivicProfile().id}-news-${new Bun.CryptoHasher("sha256").update(JSON.stringify([name, details?.url ?? null])).digest("hex").slice(0, 20)}`;
  return sourceHealth(name, status, checkedAt, { ...details, sourceId: canonicalId ?? customId });
}

/** RSS feed URLs for local news sources covering the NorCal coast */
export const NEWS_FEEDS: Readonly<Record<string, string>> = Object.freeze({
  // Del Norte Triplicate: the 2025 Cloudflare block is gone and the site now
  // publishes a full RSS feed (verified live 2026-08-30: 20 items with titles,
  // links, pubDates, descriptions at https://www.triplicate.com/rss.xml).
  // Stories currently date from 2025; the feed goes live the moment the
  // newsroom publishes. Deep article content still flows through
  // src/triplicate_monitor.ts under the reference-citation-only policy.
  'Del Norte Triplicate': 'https://www.triplicate.com/rss.xml',
  'Lost Coast Outpost': 'https://lostcoastoutpost.com/feed',
  'Humboldt County official news': 'https://humboldtgov.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml',
  // KIEM now publishes under the Redwood News brand on TownNews.
  'KIEM-TV NBC Eureka': 'https://www.redwoodnews.tv/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc',
  'Redwood Voice': 'https://www.redwoodvoice.org/feed/',
  'North Coast Journal': 'https://www.northcoastjournal.com/feed/',
});

/** True only for sources currently configured for automated news collection. */
export function configuredNewsFeeds(): Record<string, string> { return isCrescentCityProfile() ? { ...NEWS_FEEDS } : {}; }
export function isActiveNewsSource(source: unknown, feeds: Readonly<Record<string, string>> = configuredNewsFeeds()): source is string {
  return typeof source === 'string' && Object.hasOwn(feeds, source);
}

/** Explicit operator-controlled suppression for feeds known to be retired or blocked. */
export const NEWS_HTML_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  'KIEM-TV NBC Eureka': 'https://www.redwoodnews.tv/news/',
});
/** Canonical publisher names retain exact reviewed endpoints; custom feeds own independent IDs. */
function assertNewsEndpointIdentity(url: string, name: string, fallback = false): void {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /[\x00-\x20\x7f]/.test(url)) throw new Error("Invalid news endpoint");
  if (Object.hasOwn(NEWS_FEEDS, name)) {
    const expected = fallback ? NEWS_HTML_FALLBACKS[name] : NEWS_FEEDS[name];
    if (!expected || parsed.toString() !== new URL(expected).toString()) throw new Error("Canonical news source name requires its reviewed endpoint; give a custom feed an independent name");
  }
}
export const NEWS_DISABLED_SOURCES = (process.env.NEWS_DISABLED_SOURCES ?? "")
  .split(",")
  .map(source => source.trim())
  .filter(Boolean);

const NEWS_OUTPUT_DIR = () => paths.news;
/** Persistent deduplication index — survives restarts. Lives under
 * output/state/, NOT output/news/, so it never collides with a naive
 * "list output/news/*.json and take the latest" consumer (this exact bug
 * class broke tests/gov_meeting_monitor.test.ts when a sibling monitor's
 * state file was colocated with its batch output — see gov_meeting_monitor.ts).
 * IdempotencyStore.load() transparently migrates the legacy bare string[]
 * shape on first read, so no separate migration step is needed. */
const SEEN_IDS_PATH = () => paths.newsSeenIds;

async function fetchFeedWithRetry(url: string, init: TransportOptions): Promise<Response> {
  return withinDeadline(async signal => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url, { ...init, signal });
      if (response.status !== 429 || attempt === 2) return response;
      const retryAfter = Number(response.headers.get('retry-after') ?? 0);
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : (attempt + 1) * 1000;
      await waitWithSignal(delayMs, signal);
    }
    throw new Error('Feed retry loop exhausted');
  }, init.timeoutMs ?? Number(process.env.NEWS_FETCH_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS), init.signal);
}

/** Normalize a URL to a stable dedup key (strip tracking params, trailing slash) */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove common tracking parameters
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref'].forEach(p => u.searchParams.delete(p));
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

/**
 * Build the persistent dedup key for a news item: the normalized URL plus the
 * normalized title. A URL-only key (prior behavior) collapsed distinct
 * paginated items that share a canonical path; the title qualifier keeps
 * genuinely different articles while still de-duplicating the same article
 * surfaced from multiple feeds. Pure — exported so the unit test can lock the
 * contract (including tracking-param stripping) without a network fetch.
 */
export function dedupKey(url: string, title: string): string {
  return `${normalizeUrl(url)}|${title.trim().toLowerCase()}`;
}

/** Keywords triggering inclusion — case-insensitive substring match */
const CRESCENT_CITY_KEYWORDS = [
  'crescent city',
  'del norte',
  'tsunami',
  'harbor',
  'fishing',
  'crabbing',
  'pelican bay',
  'emergency',
  'evacuation',
  'weather',
  'storm',
  'earthquake',
  'fire',
  'police',
  'city council',
  'planning commission',
  'harbor commission',
  'noaa',
  'usgs',
];

export interface NewsHtmlFallback { url: string; articlePathIncludes?: string }
export interface NewsFeedPolicy { keywords?: readonly string[]; htmlFallback?: NewsHtmlFallback | null }
export interface NewsMonitorOptions extends ProducerOptions {
  noDedup?: boolean;
  feeds?: Readonly<Record<string, string>>;
  keywords?: readonly string[];
  htmlFallbacks?: Readonly<Record<string, string | NewsHtmlFallback>>;
  disabledSources?: readonly string[];
  transport?: TransportOptions;
}
function defaultNewsKeywords(): string[] { return isCrescentCityProfile() ? [...CRESCENT_CITY_KEYWORDS] : [currentCivicProfile().name.toLowerCase(), currentCivicProfile().county.toLowerCase()]; }
function checkedKeywords(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\r\n]/.test(value))) throw new Error('Invalid news keyword policy');
  return [...new Set(values.map(value => value.trim().toLowerCase()))];
}
function relevantNews(title: string, content: string, keywords: readonly string[]): boolean {
  const haystack = `${title} ${content}`.toLowerCase();
  return keywords.length === 0 || keywords.some(keyword => haystack.includes(keyword));
}
function defaultHtmlFallback(sourceName: string): NewsHtmlFallback | null {
  const url = isCrescentCityProfile() ? NEWS_HTML_FALLBACKS[sourceName] : undefined;
  return url ? { url, articlePathIncludes: '/article_' } : null;
}
function checkedHtmlFallback(value: NewsHtmlFallback | null): NewsHtmlFallback | null {
  if (value === null) return null;
  if (!value || typeof value.url !== 'string' || value.url.length > 4096 || value.articlePathIncludes !== undefined && (typeof value.articlePathIncludes !== 'string' || !value.articlePathIncludes || value.articlePathIncludes.length > 200)) throw new Error('Invalid news HTML fallback policy');
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid news HTML fallback URL');
  return { url: url.toString(), ...(value.articlePathIncludes === undefined ? {} : { articlePathIncludes: value.articlePathIncludes }) };
}

export interface NewsFeedResult {
  source: string;
  items: Array<Omit<NewsItem, 'source' | 'fetchedAt'>>;
  health: SourceHealth;
}

type MonitoredFeedResult = NewsFeedResult & { sourceName: string };

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  content: string;
  source: string;
  fetchedAt: string;
}

/**
 * Read a configured HTML news fallback and return relevant items with source health.
 */
async function fetchHtmlNewsFallback(
  fallback: NewsHtmlFallback,
  sourceName: string,
  checkedAt: string,
  keywords: readonly string[],
  transport: TransportOptions,
): Promise<NewsFeedResult> {
  const url = fallback.url;
  const response = await fetch(url, {
    ...transport,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    },
    signal: transport.signal ?? currentRunSignal(),
  });
  if (!response.ok) throw new Error(`HTML fallback returned ${response.status}: ${response.statusText}`);
  const document = new DOMParser().parseFromString(await response.text(), 'text/html');
  const anchors = document.getElementsByTagName('a');
  const items: Array<Omit<NewsItem, 'source' | 'fetchedAt'>> = [];
  const seenLinks = new Set<string>();
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const href = anchor.getAttribute('href')?.trim() ?? '';
    const title = anchor.getAttribute('aria-label')?.trim() || htmlToText(anchor.textContent ?? '').trim();
    if (!href || fallback.articlePathIncludes !== undefined && !href.includes(fallback.articlePathIncludes) || !title || seenLinks.has(href)) continue;
    seenLinks.add(href);
    const link = new URL(href, url).toString();
    if (!/^https?:\/\//i.test(link) || !relevantNews(title, '', keywords)) continue;
    items.push({ title, link, pubDate: '', content: '' });
  }
  return {
    source: sourceName,
    items,
    health: newsSourceHealth(sourceName, items.length > 0 ? 'ok' : 'empty', checkedAt, {
      url,
      fetchedAt: checkedAt,
      itemCount: items.length,
      provenance: 'Configured HTML listing fallback after primary feed failure',
    }),
  };
}

export async function fetchRSSFeedDetailed(
  url: string,
  sourceName: string,
  transport: TransportOptions = {},
  policy: NewsFeedPolicy = {},
): Promise<NewsFeedResult> {
  assertNewsEndpointIdentity(url, sourceName);
  const checkedAt = new Date().toISOString();
  const keywords = checkedKeywords(policy.keywords ?? defaultNewsKeywords());
  const htmlFallback = checkedHtmlFallback(policy.htmlFallback === undefined ? defaultHtmlFallback(sourceName) : policy.htmlFallback);
  if (htmlFallback) assertNewsEndpointIdentity(htmlFallback.url, sourceName, true);
  const boundedTransport: TransportOptions = { ...transport, signal: transport.signal ?? currentRunSignal(), timeoutMs: transport.timeoutMs ?? Number(process.env.NEWS_FETCH_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS) };
  try {
    logger.info(`Fetching RSS feed from ${sourceName}`, { url });

    const response = await fetchFeedWithRetry(url, {
      ...boundedTransport,
      headers: {
        'User-Agent': `CivicIntelligenceSystem/1.0 (${currentCivicProfile().publication.repositoryUrl})`,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      },
    });
    if (!response.ok) {
      if (htmlFallback) {
        try {
          logger.warn(`Primary feed unavailable for ${sourceName}; trying HTML listing fallback`, { primaryUrl: url, htmlFallbackUrl: htmlFallback.url, httpStatus: response.status });
          return await fetchHtmlNewsFallback(htmlFallback, sourceName, checkedAt, keywords, boundedTransport);
        } catch (fallbackError) {
          logger.warn(`HTML listing fallback failed for ${sourceName}`, { error: errorMessage(fallbackError) });
        }
      }
      return {
        source: sourceName,
        items: [],
        health: newsSourceHealth(sourceName, 'unavailable', checkedAt, {
          url,
          itemCount: 0,
          httpStatus: response.status,
          error: `HTTP ${response.status}: ${response.statusText}`,
          provenance: 'RSS/Atom feed fetch',
        }),
      };
    }

    const xmlText = await response.text();

    // Parse with DOMParser — more robust than regex for real-world RSS
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

    if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('Failed to parse XML');
    }

    const items: Array<Omit<NewsItem, 'source' | 'fetchedAt'>> = [];
    const seenLinks = new Set<string>();
    const itemNodes = xmlDoc.getElementsByTagName('item').length > 0
      ? xmlDoc.getElementsByTagName('item')
      : xmlDoc.getElementsByTagName('entry');

    for (let i = 0; i < itemNodes.length; i++) {
      const item = itemNodes[i];

      const titleEl = item.getElementsByTagName('title')[0];
      const linkEl = item.getElementsByTagName('link')[0];
      const pubDateEl = item.getElementsByTagName('pubDate')[0] ?? item.getElementsByTagName('published')[0] ?? item.getElementsByTagName('updated')[0];
      const descEl = item.getElementsByTagName('description')[0] ?? item.getElementsByTagName('summary')[0] ?? item.getElementsByTagName('content')[0];

      if (!titleEl || !linkEl) continue;

      const title = titleEl.textContent?.replace(/<[^>]*>/g, '').trim() ?? '';
      const link = linkEl.getAttribute?.('href')?.trim() || linkEl.textContent?.trim() || '';

      const normalizedLink = normalizeUrl(link);
      if (!normalizedLink || seenLinks.has(normalizedLink)) continue;
      seenLinks.add(normalizedLink);

      const pubDate = pubDateEl?.textContent?.trim() ?? '';
      const content = descEl
        ? htmlToText(descEl.textContent ?? '').substring(0, 500)
        : '';

      const isRelevant = relevantNews(title, content, keywords);

      if (isRelevant) {
        // Preserve the publisher URL for citations; use normalizedLink only
        // for deduplication so canonicalization never breaks source links.
        items.push({ title, link, pubDate, content });
      }
    }

    logger.info(`Fetched ${items.length} relevant items from ${sourceName}`, {
      count: items.length,
    });
    return {
      source: sourceName,
      items,
      health: newsSourceHealth(sourceName, items.length > 0 ? 'ok' : 'empty', checkedAt, {
        url,
        fetchedAt: checkedAt,
        itemCount: items.length,
        provenance: 'RSS/Atom feed fetch',
      }),
    };
  } catch (error: unknown) {
    if (htmlFallback && !boundedTransport.signal?.aborted) {
      try {
        logger.warn(`Primary feed failed for ${sourceName}; trying HTML listing fallback`, { primaryUrl: url, htmlFallbackUrl: htmlFallback.url, error: errorMessage(error) });
        return await fetchHtmlNewsFallback(htmlFallback, sourceName, checkedAt, keywords, boundedTransport);
      } catch (fallbackError) {
        logger.warn(`HTML listing fallback failed for ${sourceName}`, { error: errorMessage(fallbackError) });
      }
    }
    logger.error(`Failed to fetch RSS feed from ${sourceName}`, {
      error: errorMessage(error),
      url,
    });
    return {
      source: sourceName,
      items: [],
      health: newsSourceHealth(sourceName, 'unavailable', checkedAt, {
        url,
        itemCount: 0,
        error: errorMessage(error),
        provenance: 'RSS/Atom feed fetch',
      }),
    };
  }
}

/**
 * Persist a batch of news items to output/news/ as a timestamped JSON file.
 */
export async function saveNewsItems(items: NewsItem[]): Promise<string> {
  await mkdir(NEWS_OUTPUT_DIR(), { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = join(NEWS_OUTPUT_DIR(), `news-${timestamp}.json`);

  const payload = {
    fetchedAt: new Date().toISOString(),
    totalItems: items.length,
    items,
  };

  await writeJsonAtomic(filename, payload);
  logger.info(`Saved ${items.length} news items to ${filename}`);
  return filename;
}

export async function saveNewsHealth(health: SourceHealth[]): Promise<void> {
  await writeJsonAtomic(paths.newsHealth, {
    schemaVersion: 'crescent-city-source-health/v1',
    checkedAt: new Date().toISOString(),
    sources: health,
  });
}

/**
 * Main news monitoring function.
 *
 * Fetches all configured feeds concurrently, deduplicates across sources
 * AND against the persistent seen-ids index (survives restarts),
 * sorts by publication date (newest first), and persists to disk.
 *
 * @param filterKeywords - Optional additional keywords to filter by (combined with defaults via OR)
 */
export async function monitorNews(
  filterKeywords?: string[],
  options: NewsMonitorOptions = {},
): Promise<NewsItem[]> {
  for (const [name, url] of Object.entries(options.feeds ?? configuredNewsFeeds())) assertNewsEndpointIdentity(url, name);
  for (const [name, fallback] of Object.entries(options.htmlFallbacks ?? {})) assertNewsEndpointIdentity(typeof fallback === "string" ? fallback : fallback.url, name, true);
  return withProducerScope('news', options, () => monitorNewsOwned(filterKeywords, options));
}
async function monitorNewsOwned(filterKeywords: string[] | undefined, options: NewsMonitorOptions): Promise<NewsItem[]> {
  logger.info(`=== Starting ${currentCivicProfile().name} News Monitoring ===`);
  await recoverArtifactTransactions(outputRoot());

  const effectiveKeywords = checkedKeywords(options.keywords ?? [...defaultNewsKeywords(), ...(filterKeywords ?? [])]);
  const feeds = { ...(options.feeds ?? configuredNewsFeeds()) };
  if (Object.keys(feeds).length > 64 || Object.entries(feeds).some(([name, url]) => !name.trim() || name.length > 200 || /[\0\r\n]/.test(name) || typeof url !== 'string' || url.length > 4096)) throw new Error('Invalid configured news feed roster');
  const disabledSources = [...(options.disabledSources ?? NEWS_DISABLED_SOURCES)];
  const htmlFallbacks = { ...(options.htmlFallbacks ?? {}) };

  // Load persistent dedup index (shared store — survives restarts, same file
  // path as the legacy seen-ids.json, transparently migrated on first load)
  const idempotency = new IdempotencyStore(SEEN_IDS_PATH());
  if (!options.noDedup) await idempotency.load();
  const allItems: NewsItem[] = [];
  let newCount = 0;

  // Fetch all feeds concurrently
  const disabledResults: MonitoredFeedResult[] = Object.entries(feeds)
    .filter(([sourceName]) => disabledSources.includes(sourceName))
    .map(([sourceName, url]) => ({
      sourceName,
      source: sourceName,
      items: [],
      health: newsSourceHealth(sourceName, 'unavailable', new Date().toISOString(), {
        url,
        itemCount: 0,
        error: 'Feed disabled by NEWS_DISABLED_SOURCES configuration',
        provenance: 'Operator feed configuration',
      }),
    }));
  const fetchResults: MonitoredFeedResult[] = disabledResults.concat(await Promise.all(
    Object.entries(feeds).filter(([sourceName]) => !disabledSources.includes(sourceName)).map(async ([sourceName, url]) => {
      try {
        const configuredFallback = htmlFallbacks[sourceName];
        const result = await fetchRSSFeedDetailed(url, sourceName, options.transport, { keywords: effectiveKeywords, ...(configuredFallback === undefined ? {} : { htmlFallback: typeof configuredFallback === 'string' ? { url: configuredFallback } : configuredFallback }) });
        return { sourceName, ...result };
      } catch (error: unknown) {
        logger.error(`Error processing ${sourceName}`, { error: errorMessage(error) });
        return {
          sourceName,
          source: sourceName,
          items: [],
          health: newsSourceHealth(sourceName, 'unavailable', new Date().toISOString(), {
            url,
            error: errorMessage(error),
            provenance: 'RSS/Atom feed fetch',
          }),
        };
      }
    })
  ));

  const healthPayload = { schemaVersion: 'crescent-city-source-health/v1', checkedAt: new Date().toISOString(), sources: fetchResults.map(({ health }) => health) };

  const fetchedAt = new Date().toISOString();
  for (const { sourceName, items } of fetchResults) {
    currentRunSignal()?.throwIfAborted();
    for (const item of items) {
      // Dedup key = normalized URL + normalized title. A bare URL key (the prior
      // behavior) collapsed distinct paginated items that share a path; including
      // the title keeps genuinely different articles while still de-duplicating the
      // same article surfacing from multiple feeds / the same canonical path.
      // (Legacy URL-only keys in the persisted store simply stop matching; those
      // items may be re-surfaced once after upgrade — a harmless one-time cost.)
      const key = dedupKey(item.link, item.title);
      const { isNew } = options.noDedup ? { isNew: true } : idempotency.seen(key); // presence-only dedup, cross-source + cross-run
      if (!isNew) continue;
      newCount++;
      allItems.push({ ...item, source: sourceName, fetchedAt });
    }
  }

  // Sort newest first
  allItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  const artifacts: ArtifactReplacement[] = [{ path: 'news/source-health.json', text: JSON.stringify(healthPayload, null, 2) }];
  if (allItems.length > 0) {
    const name = `news/news-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
    artifacts.push({ path: name, text: JSON.stringify({ fetchedAt, totalItems: allItems.length, items: allItems }, null, 2) });
  }
  // Identity publication can never suppress a source batch that failed to persist.
  if (newCount > 0 && !options.noDedup) await idempotency.publish(outputRoot(), artifacts, { signal: currentRunSignal() });
  else await replaceArtifacts(outputRoot(), artifacts, { signal: currentRunSignal() });
  await appendBoundedJsonl(paths.newsHealth.replace(/source-health\.json$/, 'source-health-history.jsonl'), healthPayload);
  if (allItems.length > 0) {
    logger.info(`News monitoring complete: ${allItems.length} new relevant items found`);
    for (let i = 0; i < Math.min(3, allItems.length); i++) {
      const { title, source, pubDate } = allItems[i];
      logger.info(`  #${i + 1}: [${source}] ${title}`, { pubDate });
    }
  } else {
    logger.info('No new relevant items found (all already seen or no matches)');
  }

  logger.info('=== News Monitoring Complete ===');
  return allItems;
}

// CLI entry point
if (import.meta.main) {
  monitorNews().catch((error: any) => {
    logger.error('News monitoring failed', { error: error.message });
    process.exit(1);
  });
}

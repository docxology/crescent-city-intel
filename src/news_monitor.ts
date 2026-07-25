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
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { IdempotencyStore } from './shared/idempotency.js';
import { paths } from './shared/paths.js';
import { errorMessage, sourceHealth, SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic } from './shared/source_health.js';
import type { SourceHealth } from './types.js';

const logger = createLogger('news_monitor');

/** RSS feed URLs for local news sources covering the NorCal coast */
export const NEWS_FEEDS: Record<string, string> = {
  'Lost Coast Outpost': 'https://lostcoastoutpost.com/feed',
  'Humboldt County official news': 'https://humboldtgov.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml',
  // KIEM now publishes under the Redwood News brand on TownNews.
  'KIEM-TV NBC Eureka': 'https://www.redwoodnews.tv/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc',
  'Redwood Voice': 'https://www.redwoodvoice.org/feed/',
  'North Coast Journal': 'https://www.northcoastjournal.com/feed/',
};

/** True only for sources currently configured for automated news collection. */
export function isActiveNewsSource(source: unknown): source is string {
  return typeof source === 'string' && Object.hasOwn(NEWS_FEEDS, source);
}

/** Explicit operator-controlled suppression for feeds known to be retired or blocked. */
export const NEWS_HTML_FALLBACKS: Record<string, string> = {
  'KIEM-TV NBC Eureka': 'https://www.redwoodnews.tv/news/',
};
export const NEWS_DISABLED_SOURCES = (process.env.NEWS_DISABLED_SOURCES ?? "")
  .split(",")
  .map(source => source.trim())
  .filter(Boolean);

const NEWS_OUTPUT_DIR = paths.news;
/** Persistent deduplication index — survives restarts. Lives under
 * output/state/, NOT output/news/, so it never collides with a naive
 * "list output/news/*.json and take the latest" consumer (this exact bug
 * class broke tests/gov_meeting_monitor.test.ts when a sibling monitor's
 * state file was colocated with its batch output — see gov_meeting_monitor.ts).
 * IdempotencyStore.load() transparently migrates the legacy bare string[]
 * shape on first read, so no separate migration step is needed. */
const SEEN_IDS_PATH = paths.newsSeenIds;

async function fetchFeedWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === 2) return response;
    const retryAfter = Number(response.headers.get('retry-after') ?? 0);
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : (attempt + 1) * 1000;
    logger.warn(`Feed rate-limited for ${delayMs}ms; retrying`, { sourceUrl: url, attempt: attempt + 1 });
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('Feed retry loop exhausted');
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
 * Fetch and parse a single RSS feed, returning only Crescent City–relevant items.
 * Returns an empty array on any network or parse error (graceful degradation).
 */
async function fetchHtmlNewsFallback(
  url: string,
  sourceName: string,
  checkedAt: string,
): Promise<NewsFeedResult> {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    },
    signal: AbortSignal.timeout(Number(process.env.NEWS_FETCH_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS)),
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
    if (!href.includes('/article_') || !title || seenLinks.has(href)) continue;
    seenLinks.add(href);
    const link = new URL(href, url).toString();
    const haystack = title.toLowerCase();
    if (!CRESCENT_CITY_KEYWORDS.some(keyword => haystack.includes(keyword))) continue;
    items.push({ title, link, pubDate: '', content: '' });
  }
  return {
    source: sourceName,
    items,
    health: sourceHealth(sourceName, items.length > 0 ? 'ok' : 'empty', checkedAt, {
      url,
      fetchedAt: checkedAt,
      itemCount: items.length,
      provenance: 'Redwood News HTML listing fallback after RSS rate limit',
    }),
  };
}

export async function fetchRSSFeedDetailed(
  url: string,
  sourceName: string
): Promise<NewsFeedResult> {
  const checkedAt = new Date().toISOString();
  try {
    logger.info(`Fetching RSS feed from ${sourceName}`, { url });

    const response = await fetchFeedWithRetry(url, {
      headers: {
        'User-Agent': 'CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      },
      signal: AbortSignal.timeout(Number(process.env.NEWS_FETCH_TIMEOUT_MS ?? SOURCE_FETCH_TIMEOUT_MS)),
    });
    if (!response.ok) {
      const htmlFallbackUrl = NEWS_HTML_FALLBACKS[sourceName];
      if (htmlFallbackUrl) {
        try {
          logger.warn(`Primary feed unavailable for ${sourceName}; trying HTML listing fallback`, { primaryUrl: url, htmlFallbackUrl, httpStatus: response.status });
          return await fetchHtmlNewsFallback(htmlFallbackUrl, sourceName, checkedAt);
        } catch (fallbackError) {
          logger.warn(`HTML listing fallback failed for ${sourceName}`, { error: errorMessage(fallbackError) });
        }
      }
      return {
        source: sourceName,
        items: [],
        health: sourceHealth(sourceName, 'unavailable', checkedAt, {
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

      // Filter for Crescent City relevance
      const haystack = `${title} ${content}`.toLowerCase();
      const isRelevant = CRESCENT_CITY_KEYWORDS.some((kw) => haystack.includes(kw));

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
      health: sourceHealth(sourceName, items.length > 0 ? 'ok' : 'empty', checkedAt, {
        url,
        fetchedAt: checkedAt,
        itemCount: items.length,
        provenance: 'RSS/Atom feed fetch',
      }),
    };
  } catch (error: unknown) {
    const htmlFallbackUrl = NEWS_HTML_FALLBACKS[sourceName];
    if (htmlFallbackUrl) {
      try {
        logger.warn(`Primary feed failed for ${sourceName}; trying HTML listing fallback`, { primaryUrl: url, htmlFallbackUrl, error: errorMessage(error) });
        return await fetchHtmlNewsFallback(htmlFallbackUrl, sourceName, checkedAt);
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
      health: sourceHealth(sourceName, 'unavailable', checkedAt, {
        url,
        itemCount: 0,
        error: errorMessage(error),
        provenance: 'RSS/Atom feed fetch',
      }),
    };
  }
}

/** Backwards-compatible item-only feed API. Diagnostics are available via the detailed variant. */
export async function fetchRSSFeed(
  url: string,
  sourceName: string,
): Promise<Array<Omit<NewsItem, 'source' | 'fetchedAt'>>> {
  return (await fetchRSSFeedDetailed(url, sourceName)).items;
}

/**
 * Persist a batch of news items to output/news/ as a timestamped JSON file.
 */
export async function saveNewsItems(items: NewsItem[]): Promise<string> {
  await mkdir(NEWS_OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = join(NEWS_OUTPUT_DIR, `news-${timestamp}.json`);

  const payload = {
    fetchedAt: new Date().toISOString(),
    totalItems: items.length,
    items,
  };

  await writeFile(filename, JSON.stringify(payload, null, 2));
  logger.info(`Saved ${items.length} news items to ${filename}`);
  return filename;
}

export async function saveNewsHealth(health: SourceHealth[]): Promise<void> {
  await writeJsonAtomic(paths.newsHealth, {
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
  options: { noDedup?: boolean } = {},
): Promise<NewsItem[]> {
  logger.info('=== Starting Crescent City News Monitoring ===');

  const effectiveKeywords = filterKeywords?.length
    ? filterKeywords.map(k => k.toLowerCase())
    : CRESCENT_CITY_KEYWORDS;

  // Load persistent dedup index (shared store — survives restarts, same file
  // path as the legacy seen-ids.json, transparently migrated on first load)
  const idempotency = new IdempotencyStore(SEEN_IDS_PATH);
  if (!options.noDedup) await idempotency.load();
  const allItems: NewsItem[] = [];
  let newCount = 0;

  // Fetch all feeds concurrently
  const disabledResults: MonitoredFeedResult[] = Object.entries(NEWS_FEEDS)
    .filter(([sourceName]) => NEWS_DISABLED_SOURCES.includes(sourceName))
    .map(([sourceName, url]) => ({
      sourceName,
      source: sourceName,
      items: [],
      health: sourceHealth(sourceName, 'unavailable', new Date().toISOString(), {
        url,
        itemCount: 0,
        error: 'Feed disabled by NEWS_DISABLED_SOURCES configuration',
        provenance: 'Operator feed configuration',
      }),
    }));
  const fetchResults: MonitoredFeedResult[] = disabledResults.concat(await Promise.all(
    Object.entries(NEWS_FEEDS).filter(([sourceName]) => !NEWS_DISABLED_SOURCES.includes(sourceName)).map(async ([sourceName, url]) => {
      try {
        const result = await fetchRSSFeedDetailed(url, sourceName);
        return { sourceName, ...result };
      } catch (error: unknown) {
        logger.error(`Error processing ${sourceName}`, { error: errorMessage(error) });
        return {
          sourceName,
          source: sourceName,
          items: [],
          health: sourceHealth(sourceName, 'unavailable', new Date().toISOString(), {
            url,
            error: errorMessage(error),
            provenance: 'RSS/Atom feed fetch',
          }),
        };
      }
    })
  ));

  await saveNewsHealth(fetchResults.map(({ health }) => health));

  const fetchedAt = new Date().toISOString();
  for (const { sourceName, items } of fetchResults) {
    for (const item of items) {
      // Apply keyword filter if custom keywords provided
      if (filterKeywords) {
        const haystack = `${item.title} ${item.content}`.toLowerCase();
        if (!effectiveKeywords.some(kw => haystack.includes(kw))) continue;
      }

      const key = normalizeUrl(item.link);
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

  // Persist updated seen-ids
  if (newCount > 0 && !options.noDedup) {
    await idempotency.save();
    logger.info(`Added ${newCount} new URL(s) to dedup index (total: ${idempotency.size})`);
  }

  if (allItems.length > 0) {
    await saveNewsItems(allItems);
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

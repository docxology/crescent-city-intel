#!/usr/bin/env bun
/**
 * Del Norte Triplicate (triplicate.com) source connector.
 *
 * The site's public RSS listing is collected separately by news_monitor.ts.
 * This deep reference connector renders section listings through the shared
 * Playwright browser layer, extracts article links/titles with cheerio, and
 * optionally enriches articles through bounded __data.json requests. It
 * deduplicates by normalized article URL through the shared IdempotencyStore
 * and persists reference records under the selected output/triplicate/ root.
 *
 * ─── ROBOTS.TXT / AI-USAGE POLICY — READ BEFORE CONSUMING THIS CONTENT ──────
 * triplicate.com's robots.txt permits general indexing ("search") and declares
 * a default "reference" mode for AI input, but DISALLOWS AI-training use of its
 * content. Binding, practical implication for this codebase:
 *   Triplicate records are retained for source references and citations only.
 *   Project consumers exclude them from LLM curation, prompts, embeddings,
 *   training inputs and public article-content export.
 * Every stored record carries `usagePolicy = TRIPLICATE_USAGE_POLICY` and every
 * downstream indexer/consumer MUST honor it. The same note is repeated inline
 * at the exact points where article content is extracted and persisted.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   bun run src/triplicate_monitor.ts
 * Output: JSON files written to output/triplicate/
 */
import * as cheerio from 'cheerio';
import { mkdir } from 'fs/promises';
import { join, resolve, relative, isAbsolute } from 'path';
import { createLogger } from './logger.js';
import { newPage, navigateWithCloudflare, closeBrowser, withPageDeadline, closePageBounded } from './browser.js';
import { boundedHttpFetch as fetch } from './shared/transport.js';
import { withRetry, detectCloudflareStall } from './scraper_utils.js';
import { replaceArtifacts, recoverArtifactTransactions, type ArtifactReplacement } from './shared/artifact_transaction.js';
import { IdempotencyStore } from './shared/idempotency.js';
import { normalizeUrl } from './news_monitor.js';
import { SCRAPE_TIMEOUT_MS } from './constants.js';
import { paths, outputRoot } from './shared/paths.js';
import { sourceHealth, writeJsonAtomic, appendBoundedJsonl } from './shared/source_health.js';
import { withProducerScope, currentRunSignal } from './shared/run_scope.js';
import { sourceIdForMonitor } from './source_registry.js';
import type { SourceHealth } from './types.js';

const logger = createLogger('triplicate_monitor');

function triplicateSourceHealth(...args: Parameters<typeof sourceHealth>): SourceHealth {
  const [name, status, checkedAt, details] = args;
  return sourceHealth(name, status, checkedAt, { ...details, sourceId: sourceIdForMonitor('triplicate:deep-content') });
}

/**
 * Binding, machine-visible AI-usage tag stamped on every stored Triplicate
 * record. See the project policy block above: downstream consumers must retain
 * the reference/citation-only boundary and exclude article content from LLM
 * prompts, embeddings, curation, training and public article-content export.
 */
export const TRIPLICATE_USAGE_POLICY =
  'reference-citation-only; NEVER AI-training input' as const;

/** Same-host suffix used to reject off-site links during extraction. */
const TRIPLICATE_HOST = 'triplicate.com';

/**
 * Section listing pages to scan. The homepage plus the main news section —
 * both render an article list once the Cloudflare challenge clears.
 */
export const TRIPLICATE_SECTIONS: Record<string, string> = {
  Home: 'https://www.triplicate.com/',
  News: 'https://www.triplicate.com/news/',
};

const triplicateOutputDir = () => join(outputRoot(), 'triplicate');
/** Persistent dedup index — normalized article URL keys, survives restarts.
 * Lives under output/state/, NOT output/triplicate/, so it never collides
 * with a listing of the batch article-output files. */
const seenArticlesPath = () => join(outputRoot(), 'state', 'triplicate-seen-articles.json');

/** Minimum link-text length for a candidate to be treated as a real headline. */
const MIN_TITLE_LEN = 15;

/**
 * Path segments that mark a non-article listing/utility page anywhere in the
 * path (author pages, tag/category indexes, staff, topic hubs).
 */
const PATH_SEGMENT_STOPWORDS = new Set<string>([
  'author', 'authors', 'tag', 'tags', 'category', 'categories',
  'section', 'sections', 'staff', 'topic', 'topics',
]);

/**
 * Leaf (last) path segments that mark a section landing/utility page rather
 * than an individual article.
 */
const NAV_LEAF_STOPWORDS = new Set<string>([
  'news', 'sports', 'opinion', 'obituaries', 'community', 'subscribe',
  'subscriptions', 'login', 'logout', 'register', 'e-edition', 'contact',
  'about', 'search', 'weather', 'newsletters', 'newsletter',
  'privacy-policy', 'terms-of-use', 'advertise', 'feed', 'rss', 'sitemap',
]);

export interface TriplicateArticle {
  title: string;
  link: string;
  section: string;
  fetchedAt: string;
  /** Binding AI-usage restriction — reference/citation only; excluded from LLM and training inputs. */
  usagePolicy: typeof TRIPLICATE_USAGE_POLICY;
}

/** A function that returns the fully-rendered HTML of a page URL. Injectable so
 *  tests can supply real captured HTML without launching a headless browser. */
export type PageFetcher = (url: string) => Promise<string>;

/**
 * Heuristic: does this absolute URL look like an individual Triplicate article
 * (as opposed to a section index, tag/author page, external link, or asset)?
 *
 * The live Triplicate DOM cannot be captured in this environment (Cloudflare
 * 403), so — mirroring gov_meeting_monitor.ts's anchor-scan approach — this
 * deliberately relies on general, defensive URL heuristics rather than an
 * overfit CSS class name:
 *   - same-host http(s) links only (rejects mailto:, off-site, assets)
 *   - reject any path containing an author/tag/category-style segment
 *   - reject section-landing leaf segments (e.g. /news/, /sports/)
 *   - accept a link whose path carries a 4-digit year OR whose leaf segment is
 *     a multi-word hyphenated slug (the shape of a real headline URL)
 */
export function isLikelyArticleUrl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname.toLowerCase().endsWith(TRIPLICATE_HOST)) return false;

  const segs = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segs.length === 0) return false; // homepage / bare host
  if (segs.some((s) => PATH_SEGMENT_STOPWORDS.has(s))) return false;

  const last = segs[segs.length - 1];
  if (NAV_LEAF_STOPWORDS.has(last)) return false;

  const hasYear = segs.some((s) => /^(19|20)\d{2}$/.test(s));
  const slugLike = last.includes('-') && last.replace(/[^a-z0-9]/g, '').length >= 8;
  return hasYear || slugLike;
}

/**
 * Pure: parse rendered HTML and return the article links + titles found on it.
 *
 * AI-USAGE: the article text/links are reference/citation-only records.
 * LLM curation, prompts, embeddings, training and public body export are
 * excluded. See the file header and TRIPLICATE_USAGE_POLICY.
 *
 * Relative hrefs are resolved against `pageUrl`; off-site, asset, and
 * non-article links are dropped; duplicates (by normalized URL) are collapsed.
 */
export function extractArticles(
  html: string,
  pageUrl: string,
): Array<{ title: string; link: string }> {
  const $ = cheerio.load(html);
  const seenKeys = new Set<string>();
  const out: Array<{ title: string; link: string }> = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || !title || title.length < MIN_TITLE_LEN) return;

    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      return; // unparseable href (e.g. malformed) — skip
    }

    if (!isLikelyArticleUrl(abs)) return;

    const key = normalizeUrl(abs.toString());
    if (seenKeys.has(key)) return; // in-page dedup (e.g. a headline + "share" copy)
    seenKeys.add(key);

    out.push({ title, link: abs.toString() });
  });

  return out;
}

/**
 * Default page fetcher: drives the shared Playwright + Cloudflare-bypass layer.
 * Returns the fully-rendered HTML. Throws on navigation/Cloudflare failure so
 * the caller can classify it as a distinguishable failure (see fetchSection).
 */
async function fetchRenderedHtml(url: string): Promise<string> {
  const page = await newPage();
  const startedAt = Date.now();
  try {
    return await withPageDeadline(page, async () => {
    await navigateWithCloudflare(page, url);
    // Belt-and-suspenders: navigateWithCloudflare enforces its own timeout, but
    // an over-budget elapsed time is treated as a stuck Turnstile challenge.
    if (detectCloudflareStall(startedAt, SCRAPE_TIMEOUT_MS)) {
      throw new Error(
        `Cloudflare stall: navigation exceeded ${SCRAPE_TIMEOUT_MS}ms for ${url}`,
      );
    }
    return await page.content();
    }, SCRAPE_TIMEOUT_MS);
  } finally {
    // Best-effort close; the page may already be gone. Nothing to recover here,
    // so the failure is intentionally swallowed rather than masking a real error.
    await closePageBounded(page);
  }
}

/** Discriminated outcome of fetching one section — never conflates failure with
 *  "fetched but empty", which is what the anti-criterion demands. */
type SectionFetchOutcome =
  | { status: 'ok'; articles: Array<{ title: string; link: string }> }
  | { status: 'failed'; error: string };

/**
 * Fetch + extract one section, with bounded exponential-backoff retry. Returns
 * a discriminated outcome; only a genuine navigation/Cloudflare failure (after
 * retries) yields `status: 'failed'`.
 */
async function fetchSection(
  sectionName: string,
  url: string,
  fetchHtml: PageFetcher,
  maxRetries: number,
  baseDelayMs: number,
): Promise<SectionFetchOutcome> {
  try {
    const { result: html, retried, attempts } = await withRetry(
      () => fetchHtml(url),
      maxRetries,
      baseDelayMs,
    );
    if (retried) {
      logger.warn(`Triplicate [${sectionName}] recovered after retry`, { attempts, url });
    }
    const articles = extractArticles(html, url);
    if (articles.length === 0) {
      // Distinguishable from a hard failure AND from "no new": the page rendered
      // but no article link matched — a strong signal the layout/selectors moved.
      logger.warn(
        `Triplicate [${sectionName}] rendered but yielded 0 article links — possible selector/layout change`,
        { url },
      );
    }
    return { status: 'ok', articles };
  } catch (error: any) {
    logger.error(
      `Triplicate fetch FAILED — Cloudflare bypass or navigation error [${sectionName}]`,
      { error: error?.message ?? String(error), url },
    );
    return { status: 'failed', error: error?.message ?? String(error) };
  }
}

/**
 * Persist new Triplicate articles to output/triplicate/ as a timestamped JSON
 * file. The payload carries the binding AI-usage policy so any consumer of the
 * file sees it without reading this module.
 */
// ─── Deep content channel (verified live 2026-08-30) ─────────────────────────
// The 2025 Cloudflare block is gone and the site is now a SvelteKit app that
// ships machine-readable data: every article has /news/{uuid}/__data.json with
// headline, released_at, byline, and body_html. The reference-citation-only
// usage policy is unchanged: article bodies remain reference/citation-only;
// LLM prompts, curation, embeddings, training and public body export are excluded.
export const TRIPLICATE_RSS_URL = 'https://www.triplicate.com/rss.xml';

export interface TriplicateDeepArticle {
  uuid: string;
  url: string;
  section: string;
  headline: string;
  releasedAt: string | null;
  byline: string | null;
  bodyText: string;
  fetchedAt: string;
  usagePolicy: typeof TRIPLICATE_USAGE_POLICY;
}

/** Walk a streamed SvelteKit response (concatenated JSON objects). */
export function splitStreamedJsonObjects(raw: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  let position = 0;
  while (position < raw.length) {
    while (position < raw.length && ' \n\r\t'.includes(raw[position])) position++;
    if (position >= raw.length || raw[position] !== '{') break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = position; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) break;
    try {
      const parsed = JSON.parse(raw.slice(position, end)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch { /* truncated trailing chunk: earlier objects stay valid */ }
    position = end;
  }
  return objects;
}

/** Resolve devalue index-references in one payload's node array. */
export function resolveDevalueArticle(nodes: unknown[], value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value < nodes.length) {
      return resolveDevalueArticle(nodes, nodes[value], depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveDevalueArticle(nodes, v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveDevalueArticle(nodes, v, depth + 1);
    }
    return out;
  }
  return value;
}

function articleNodeData(raw: string): unknown[] | null {
  for (const obj of splitStreamedJsonObjects(raw)) {
    const nodes = (obj as { nodes?: Array<{ data?: unknown }> }).nodes;
    if (!Array.isArray(nodes)) continue;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const data = nodes[i]?.data;
      if (Array.isArray(data) && data.some((v) => v !== null && typeof v === 'object' && 'headline' in (v as object))) {
        return data as unknown[];
      }
    }
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch one article's deep content through its __data.json endpoint. */
export async function fetchTriplicateArticleContent(
  articleUrl: string,
  fetchText: (url: string) => Promise<string> = (u) => fetch(u, { headers: { Accept: 'application/json' } }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    return r.text();
  }),
): Promise<TriplicateDeepArticle | null> {
  const match = /\/([a-z-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(articleUrl);
  if (!match) return null;
  const [, section, uuid] = match;
  try {
    // AI-USAGE: body text is a local reference/citation record, excluded from LLM inputs.
    const raw = await fetchText(`https://www.triplicate.com/${section}/${uuid}/__data.json`);
    const nodes = articleNodeData(raw);
    if (!nodes) return null;
    for (const node of nodes) {
      if (node === null || typeof node !== 'object' || !('headline' in node)) continue;
      const resolved = resolveDevalueArticle(nodes, node) as Record<string, unknown>;
      const headline = typeof resolved.headline === 'string' ? resolved.headline : '';
      const bodyHtml = typeof resolved.body_html === 'string' ? resolved.body_html : '';
      if (!headline || !bodyHtml) continue;
      return {
        uuid,
        url: articleUrl,
        section,
        headline,
        releasedAt: typeof resolved.released_at === 'string' ? resolved.released_at : null,
        byline: [resolved.byline_given, resolved.byline_family].filter((v) => typeof v === 'string' && v).join(' ') || null,
        bodyText: stripHtml(bodyHtml),
        fetchedAt: new Date().toISOString(),
        usagePolicy: TRIPLICATE_USAGE_POLICY,
      };
    }
    return null;
  } catch (error) {
    logger.warn('Deep article fetch failed', { url: articleUrl, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function saveTriplicateArticles(
  articles: TriplicateArticle[],
  outputDir: string = triplicateOutputDir(),
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = join(outputDir, `triplicate-${timestamp}.json`);

  const payload = {
    fetchedAt: new Date().toISOString(),
    // Reference/citation-only records are excluded from LLM prompts, curation,
    // embeddings, training and public article-content export.
    usagePolicy: TRIPLICATE_USAGE_POLICY,
    totalItems: articles.length,
    items: articles,
  };

  await writeJsonAtomic(filename, payload);
  logger.info(`Saved ${articles.length} Triplicate article(s) to ${filename}`);
  return filename;
}

export interface MonitorTriplicateOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  artifactRoot?: string;
  /** Override the page fetcher (default: real browser-driven fetch). */
  fetchHtml?: PageFetcher;
  /** Override the persistent dedup index path (default: output/triplicate/seen-articles.json). */
  seenPath?: string;
  /** Override the section listing pages to scan (default: TRIPLICATE_SECTIONS). */
  sections?: Record<string, string>;
  /** Override the output directory for saved article batches. */
  outputDir?: string;
  /** Override the source-health artifact path (defaults to output/triplicate/source-health.json). */
  healthPath?: string;
  /** Bounded deep-content enrichment (article bodies via __data.json). */
  deep?: { limit?: number };
  /** Retry policy for section fetches. */
  retry?: { maxRetries?: number; baseDelayMs?: number };
}

/**
 * Main Triplicate monitoring function.
 *
 * Renders each configured section via the Cloudflare-bypass browser layer,
 * extracts article links, deduplicates against the persistent index, persists
 * new items, and returns them (newest sections first). Matches the
 * source-degradation contract of monitorNews/monitorGovMeetings. Source failures
 * are recorded; cancellation, ownership and publication failures throw.
 *
 * Anti-criterion (enforced here): a hard fetch failure, a "rendered but zero
 * links extracted" event, and an ordinary "no new articles" cycle are logged
 * distinguishably. A silent `[]` that reads like "no news today" is never
 * emitted for a broken bypass.
 */
export async function monitorTriplicate(
  opts: MonitorTriplicateOptions = {},
): Promise<TriplicateArticle[]> {
  const root = resolve(opts.artifactRoot ?? outputRoot());
  for (const path of [opts.seenPath, opts.outputDir, opts.healthPath]) if (path) { const local = relative(root, resolve(path)); if (local.startsWith('..') || isAbsolute(local)) throw new Error('Triplicate destinations must belong to its captured artifact root'); }
  return withProducerScope('triplicate', { signal: opts.signal, deadlineMs: opts.deadlineMs, outputDir: opts.artifactRoot }, () => monitorTriplicateOwned(opts));
}
async function monitorTriplicateOwned(opts: MonitorTriplicateOptions): Promise<TriplicateArticle[]> {
  const fetchHtml = opts.fetchHtml ?? fetchRenderedHtml;
  const seenPath = opts.seenPath ?? seenArticlesPath();
  const sections = opts.sections ?? TRIPLICATE_SECTIONS;
  const outputDir = opts.outputDir ?? triplicateOutputDir();
  const healthPath = opts.healthPath ?? paths.triplicateHealth;
  const maxRetries = opts.retry?.maxRetries ?? 2;
  const baseDelayMs = opts.retry?.baseDelayMs ?? 2000;
  const sectionCount = Object.keys(sections).length;

  logger.info('=== Starting Del Norte Triplicate Monitoring ===');
  await recoverArtifactTransactions(outputRoot());

  const store = new IdempotencyStore(seenPath, 5000);
  await store.load();

  const fetchedAt = new Date().toISOString();
  const newArticles: TriplicateArticle[] = [];
  let anyFetchSucceeded = false;
  let anyFetchFailed = false;
  let totalExtracted = 0;

  for (const [sectionName, url] of Object.entries(sections)) {
    currentRunSignal()?.throwIfAborted();
    const outcome = await fetchSection(sectionName, url, fetchHtml, maxRetries, baseDelayMs);
    if (outcome.status === 'failed') {
      anyFetchFailed = true;
      continue;
    }
    anyFetchSucceeded = true;
    totalExtracted += outcome.articles.length;

    for (const article of outcome.articles) {
      // AI-USAGE: reference/citation only; excluded from LLM inputs. The
      // usagePolicy tag rides along on every record for downstream consumers.
      const key = normalizeUrl(article.link);
      const { isNew } = store.seen(key, '', {
        title: article.title,
        section: sectionName,
        usagePolicy: TRIPLICATE_USAGE_POLICY,
      });
      if (!isNew) continue;

      newArticles.push({
        title: article.title,
        link: article.link,
        section: sectionName,
        fetchedAt,
        usagePolicy: TRIPLICATE_USAGE_POLICY,
      });
    }
  }

  // ── Distinguishable-outcome logging (anti-criterion) ───────────────────────
  if (!anyFetchSucceeded && anyFetchFailed) {
    logger.error(
      'Triplicate monitoring FAILED for EVERY section — no page rendered. The Cloudflare bypass or navigation is broken. Returning no articles because none could be fetched — this is NOT "no new articles today".',
      { sections: sectionCount },
    );
  } else if (anyFetchSucceeded && totalExtracted === 0) {
    logger.error(
      'Triplicate rendered but extracted ZERO article links across all reachable sections — the Cloudflare bypass may have broken or the site layout/selectors changed. This is NOT the same as "no new articles today".',
      { sections: sectionCount },
    );
  }

  if (newArticles.length > 0) {
    logger.info(`Triplicate monitoring complete: ${newArticles.length} new article(s)`, {
      totalExtracted,
    });
    for (let i = 0; i < Math.min(3, newArticles.length); i++) {
      const { section, title } = newArticles[i];
      logger.info(`  #${i + 1}: [${section}] ${title}`);
    }
  } else if (anyFetchSucceeded && totalExtracted > 0) {
    logger.info(`No new Triplicate articles (all ${totalExtracted} extracted already seen)`);
  }

  const health: SourceHealth = !anyFetchSucceeded && anyFetchFailed
    ? triplicateSourceHealth('Del Norte Triplicate deep content', 'unavailable', fetchedAt, {
      url: Object.values(sections)[0],
      itemCount: 0,
      error: 'Every configured section failed to render',
      provenance: 'Playwright Cloudflare-bypass rendered pages',
    })
    : totalExtracted === 0
      ? triplicateSourceHealth('Del Norte Triplicate deep content', 'stale', fetchedAt, {
        url: Object.values(sections)[0],
        itemCount: 0,
        error: 'Rendered pages yielded no article links; selectors or layout may have changed',
        provenance: 'Playwright Cloudflare-bypass rendered pages',
      })
      : triplicateSourceHealth('Del Norte Triplicate deep content', anyFetchFailed ? 'stale' : 'ok', fetchedAt, {
        url: Object.values(sections)[0],
        fetchedAt,
        itemCount: totalExtracted,
        error: anyFetchFailed ? 'One or more configured sections failed to render' : undefined,
        provenance: 'Playwright Cloudflare-bypass rendered pages; reference/citation only',
      });
  const healthPayload = {
    schemaVersion: 'crescent-city-source-health/v1',
    checkedAt: new Date().toISOString(),
    sources: [health],
  };
  const artifacts: ArtifactReplacement[] = [{ path: relative(outputRoot(), healthPath), text: JSON.stringify(healthPayload, null, 2) }];
  if (newArticles.length > 0) artifacts.push({ path: relative(outputRoot(), join(outputDir, `triplicate-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`)), text: JSON.stringify({ fetchedAt, totalItems: newArticles.length, usagePolicy: TRIPLICATE_USAGE_POLICY, items: newArticles }, null, 2) });
  if (newArticles.length > 0) await store.publish(outputRoot(), artifacts, { signal: currentRunSignal() });
  else await replaceArtifacts(outputRoot(), artifacts, { signal: currentRunSignal() });
  await appendBoundedJsonl(`${healthPath.replace(/\.json$/, '')}-history.jsonl`, healthPayload);

  logger.info('=== Triplicate Monitoring Complete ===');
  return newArticles;
}

// CLI entry point
if (import.meta.main) {
  monitorTriplicate()
    .catch((error: any) => {
      logger.error('Triplicate monitoring failed', { error: error?.message ?? String(error) });
      process.exitCode = 1;
    })
    .finally(() => closeBrowser());
}

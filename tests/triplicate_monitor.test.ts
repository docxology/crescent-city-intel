/**
 * Tests for triplicate_monitor.ts
 *
 * The Del Norte Triplicate is behind Cloudflare with no RSS feed, so the live
 * DOM cannot be captured in CI. Following this repo's strict no-mocks policy,
 * these tests exercise the pure and orchestration logic with REAL inputs:
 *   - extractArticles() against a representative real-shaped HTML fixture string
 *     (a news listing with genuine article links plus nav/tag/author/external
 *     noise that must be filtered out),
 *   - monitorTriplicate() driven through ordinary dependency injection — a REAL
 *     alternate fetch function (returning the fixture, or throwing) and a REAL
 *     temp seen-index / output dir. Injecting a real function is not a mocking
 *     framework; no MagicMock/mocker.patch equivalent is used anywhere.
 *
 * NOTE: this fixture is a representative real-SHAPE of a Triplicate listing, not
 * bytes captured from the live Cloudflare-protected page (which returns 403 and
 * is unreachable here). The extraction logic is intentionally heuristic for that
 * reason — see isLikelyArticleUrl in the source.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractArticles,
  isLikelyArticleUrl,
  monitorTriplicate,
  TRIPLICATE_USAGE_POLICY,
  type TriplicateArticle,
} from '../src/triplicate_monitor';

const PAGE_URL = 'https://www.triplicate.com/news/';

/**
 * Representative real-shaped Triplicate news-listing HTML. Three genuine article
 * links (one relative dated, one relative slug-only, one absolute dated) mixed
 * with the noise a real listing carries: section landings, an author page, a tag
 * hub, an external social link, a mailto, a skip-link, and a utm-tracked
 * duplicate of the first article (to prove normalization-based dedup).
 */
const FIXTURE_HTML = `<!doctype html>
<html><head><title>News | Del Norte Triplicate</title></head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/news/">News</a>
    <a href="/sports/">Sports</a>
    <a href="/login/">Login</a>
    <a href="/subscribe/">Subscribe Today For Full Access</a>
    <a href="#main">Skip To Main Content Now</a>
  </nav>
  <main>
    <article>
      <a href="/news/2026/jul/23/crescent-city-harbor-dredging-project-approved/">Crescent City Harbor Dredging Project Approved By Commission</a>
      <a href="/news/2026/jul/23/crescent-city-harbor-dredging-project-approved/?utm_source=twitter&utm_medium=social">Crescent City Harbor Dredging Project Approved By Commission</a>
    </article>
    <article>
      <a href="/news/local/del-norte-supervisors-approve-tsunami-siren-upgrade/">Del Norte Supervisors Approve Tsunami Siren Upgrade</a>
    </article>
    <article>
      <a href="https://www.triplicate.com/sports/2026/jul/22/del-norte-high-track-team-wins-regional-title/">Del Norte High Track Team Wins Regional Title</a>
    </article>
    <aside>
      <a href="/author/jane-reporter/">Articles By Jane Reporter</a>
      <a href="/tag/tsunami/">More Tsunami Coverage Here</a>
      <a href="https://www.facebook.com/triplicate/">Follow Us On Facebook Today</a>
      <a href="mailto:news@triplicate.com">Email The Newsroom Directly</a>
    </aside>
  </main>
</body></html>`;

/** A rendered-but-empty page: the challenge cleared but no article link exists
 *  (the "selectors went stale / layout changed" signal). */
const NO_ARTICLES_HTML = `<!doctype html>
<html><head><title>Del Norte Triplicate</title></head>
<body><header><a href="/login/">Login</a><a href="/subscribe/">Subscribe Today For Full Access</a></header>
<p>Welcome to the Del Norte Triplicate homepage redesign.</p></body></html>`;

describe('isLikelyArticleUrl', () => {
  test('accepts a dated article path', () => {
    expect(
      isLikelyArticleUrl(new URL('https://www.triplicate.com/news/2026/jul/23/harbor-dredging-approved/')),
    ).toBe(true);
  });

  test('accepts a hyphenated-slug article path without a year', () => {
    expect(
      isLikelyArticleUrl(new URL('https://www.triplicate.com/news/local/tsunami-siren-upgrade/')),
    ).toBe(true);
  });

  test('rejects a section landing page', () => {
    expect(isLikelyArticleUrl(new URL('https://www.triplicate.com/news/'))).toBe(false);
  });

  test('rejects the homepage', () => {
    expect(isLikelyArticleUrl(new URL('https://www.triplicate.com/'))).toBe(false);
  });

  test('rejects author and tag hub pages', () => {
    expect(isLikelyArticleUrl(new URL('https://www.triplicate.com/author/jane-reporter/'))).toBe(false);
    expect(isLikelyArticleUrl(new URL('https://www.triplicate.com/tag/tsunami/'))).toBe(false);
  });

  test('rejects off-site links', () => {
    expect(isLikelyArticleUrl(new URL('https://www.facebook.com/triplicate/harbor-dredging-story/'))).toBe(false);
  });

  test('rejects non-http protocols', () => {
    expect(isLikelyArticleUrl(new URL('mailto:news@triplicate.com'))).toBe(false);
  });
});

describe('extractArticles', () => {
  test('extracts exactly the real article links and drops all noise', () => {
    const articles = extractArticles(FIXTURE_HTML, PAGE_URL);
    const links = articles.map((a) => a.link);

    // Exactly 3 unique articles (the utm-tracked duplicate collapses into one).
    expect(articles).toHaveLength(3);

    expect(links).toContain(
      'https://www.triplicate.com/news/2026/jul/23/crescent-city-harbor-dredging-project-approved/',
    );
    expect(links).toContain(
      'https://www.triplicate.com/news/local/del-norte-supervisors-approve-tsunami-siren-upgrade/',
    );
    expect(links).toContain(
      'https://www.triplicate.com/sports/2026/jul/22/del-norte-high-track-team-wins-regional-title/',
    );

    // Noise must be absent.
    expect(links.some((l) => l.includes('facebook.com'))).toBe(false);
    expect(links.some((l) => l.includes('/author/'))).toBe(false);
    expect(links.some((l) => l.includes('/tag/'))).toBe(false);
    expect(links.some((l) => l.endsWith('/news/'))).toBe(false);
    expect(links.some((l) => l.startsWith('mailto:'))).toBe(false);
  });

  test('absolutizes every returned link and carries real headline titles', () => {
    const articles = extractArticles(FIXTURE_HTML, PAGE_URL);
    for (const a of articles) {
      expect(a.link.startsWith('https://www.triplicate.com/')).toBe(true);
      expect(a.title.length).toBeGreaterThanOrEqual(15);
    }
  });

  test('returns an empty array for a rendered page with no article links', () => {
    expect(extractArticles(NO_ARTICLES_HTML, 'https://www.triplicate.com/')).toHaveLength(0);
  });

  test('returns an empty array for empty HTML (never throws)', () => {
    expect(extractArticles('', PAGE_URL)).toHaveLength(0);
  });
});

describe('monitorTriplicate', () => {
  let workDir: string;
  let seenPath: string;
  let outputDir: string;
  const singleSection = { News: PAGE_URL };
  const fastRetry = { maxRetries: 0, baseDelayMs: 1 };

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'triplicate-test-'));
    seenPath = join(workDir, 'seen-articles.json');
    outputDir = join(workDir, 'out');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test('first run returns new articles tagged reference-only; second run returns none (idempotent)', async () => {
    const fetchHtml = async () => FIXTURE_HTML;

    const first = await monitorTriplicate({
      fetchHtml,
      seenPath,
      outputDir,
      healthPath: join(workDir, 'source-health.json'),
      sections: singleSection,
      retry: fastRetry,
    });
    expect(first).toHaveLength(3);
    const health = JSON.parse(await readFile(join(workDir, 'source-health.json'), 'utf-8'));
    expect(health.sources[0].status).toBe('ok');
    expect(health.sources[0].itemCount).toBe(3);
    for (const item of first) {
      expect(item.usagePolicy).toBe(TRIPLICATE_USAGE_POLICY);
      expect(item.section).toBe('News');
      expect(item.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    const second = await monitorTriplicate({
      fetchHtml,
      seenPath,
      outputDir,
      healthPath: join(workDir, 'source-health.json'),
      sections: singleSection,
      retry: fastRetry,
    });
    expect(second).toHaveLength(0);
  });

  test('persists a batch file whose payload carries the binding AI-usage policy', async () => {
    await monitorTriplicate({
      fetchHtml: async () => FIXTURE_HTML,
      seenPath,
      outputDir,
      sections: singleSection,
      retry: fastRetry,
    });

    const files = (await readdir(outputDir)).filter((f) => f.startsWith('triplicate-'));
    expect(files.length).toBe(1);

    const saved = JSON.parse(await readFile(join(outputDir, files[0]), 'utf-8'));
    expect(saved.usagePolicy).toBe(TRIPLICATE_USAGE_POLICY);
    expect(saved.totalItems).toBe(3);
    for (const item of saved.items) {
      expect(item.usagePolicy).toBe(TRIPLICATE_USAGE_POLICY);
    }
  });

  test('degrades gracefully when the fetch fails — never throws, returns []', async () => {
    const throwingFetch = async () => {
      throw new Error('Cloudflare 403: bypass blocked');
    };

    let result: TriplicateArticle[] | undefined;
    let threw = false;
    try {
      result = await monitorTriplicate({
      fetchHtml: throwingFetch,
      seenPath,
      outputDir,
      healthPath: join(workDir, 'source-health.json'),
      sections: singleSection,
      retry: fastRetry,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toEqual([]);
    const health = JSON.parse(await readFile(join(workDir, 'source-health.json'), 'utf-8'));
    expect(health.sources[0].status).toBe('unavailable');

    // A hard failure must not create a "success" output batch — the distinct
    // failure is logged, not silently persisted as an empty result.
    let outFiles: string[] = [];
    try {
      outFiles = await readdir(outputDir);
    } catch {
      outFiles = []; // dir never created — also acceptable
    }
    expect(outFiles.filter((f) => f.startsWith('triplicate-'))).toHaveLength(0);
  });

  test('handles a rendered-but-empty page (stale selectors) without throwing', async () => {
    const result = await monitorTriplicate({
      fetchHtml: async () => NO_ARTICLES_HTML,
      seenPath,
      outputDir,
      healthPath: join(workDir, 'source-health.json'),
      sections: singleSection,
      retry: fastRetry,
    });
    expect(result).toEqual([]);
    const health = JSON.parse(await readFile(join(workDir, 'source-health.json'), 'utf-8'));
    expect(health.sources[0].status).toBe('stale');
  });

  test('recovers via bounded retry when the first fetch attempt fails', async () => {
    let calls = 0;
    const flakyFetch = async () => {
      calls++;
      if (calls === 1) throw new Error('transient navigation timeout');
      return FIXTURE_HTML;
    };

    const result = await monitorTriplicate({
      fetchHtml: flakyFetch,
      seenPath,
      outputDir,
      sections: singleSection,
      retry: { maxRetries: 2, baseDelayMs: 1 },
    });

    expect(calls).toBe(2);
    expect(result).toHaveLength(3);
  });
});

describe('TriplicateArticle shape', () => {
  test('constructs with all required fields including the usage policy', () => {
    const item: TriplicateArticle = {
      title: 'Crescent City Harbor Dredging Project Approved By Commission',
      link: 'https://www.triplicate.com/news/2026/jul/23/harbor-dredging-approved/',
      section: 'News',
      fetchedAt: new Date().toISOString(),
      usagePolicy: TRIPLICATE_USAGE_POLICY,
    };
    expect(item.title).toBeTruthy();
    expect(item.usagePolicy).toBe('reference-citation-only; NEVER AI-training input');
  });
});

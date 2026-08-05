#!/usr/bin/env bun
/**
 * Main scraper entry point.
 *
 * Workflow:
 *   1. Fetch the full table of contents from ecode360 API
 *   2. Identify all article (chapter) pages that contain section text
 *   3. Navigate to each article page and extract content
 *   4. Save raw HTML, parsed sections, and a manifest for verification
 *
 * Output:
 *   output/toc.json           - Full table of contents tree
 *   output/manifest.json      - Scrape manifest with hashes
 *   output/articles/{guid}.json - Per-article content files
 */
import { mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { newPage, closeBrowser } from "./browser.js";
import { fetchToc, getArticlePages, getSections, tocSummary } from "./toc.js";
import { getSectionGuids, scrapeArticlePage } from "./content.js";
import { ARTICLES_DIR, RATE_LIMIT_MS, BASE_URL, MUNICIPALITY_CODE, MAX_RETRIES } from "./constants.js";
import { computeSha256, flattenToc } from "./utils.js";
import { isArticleArtifactShapeValid, isTocShapeValid, withRetry } from "./scraper_utils.js";
import { paths } from "./shared/paths.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { createLogger } from "./logger.js";
import type { Page } from "playwright";
import type { TocNode, ScrapeManifest } from "./types.js";

const log = createLogger("scraper");

/** Get or recreate a working page */
async function ensurePage(currentPage: Page | null): Promise<Page> {
  if (currentPage) {
    try {
      // Test if page is still alive
      await currentPage.evaluate(() => true);
      return currentPage;
    } catch {
      // Page is dead, create new one
    }
  }
  return await newPage();
}

async function persistManifest(manifest: ScrapeManifest): Promise<void> {
  await writeJsonAtomic(paths.manifest, manifest);
}

async function readCachedArticleIfValid(article: TocNode, manifest: ScrapeManifest): Promise<boolean> {
  const entry = manifest.articles[article.guid];
  const filePath = paths.article(article.guid);
  if (!entry || !existsSync(filePath)) return false;
  try {
    const data = JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
    const expectedGuids = getSectionGuids(article).map(section => section.guid);
    if (!isArticleArtifactShapeValid(data, expectedGuids, true) || data.guid !== article.guid) return false;
    const computedHash = await computeSha256(String(data.rawHtml));
    return data.sha256 === entry.sha256 && data.sha256 === computedHash;
  } catch {
    return false;
  }
}

async function scrapeWithRetries(article: TocNode, currentPage: Page | null): Promise<{ result: Awaited<ReturnType<typeof scrapeArticlePage>>; page: Page | null; attempts: number }> {
  let page = currentPage;
  const outcome = await withRetry(async () => {
    try {
      page = await ensurePage(page);
      const result = await scrapeArticlePage(page, article);
      const expectedGuids = getSectionGuids(article).map(section => section.guid);
      if (!isArticleArtifactShapeValid(result, expectedGuids, true)) {
        throw new Error(`Scrape for ${article.guid} did not contain all expected sections`);
      }
      return result;
    } catch (error) {
      try { await page?.close(); } catch { /* force a fresh page on retry */ }
      page = null;
      throw error;
    }
  }, Math.max(0, MAX_RETRIES), Math.max(250, Math.floor(RATE_LIMIT_MS / 2)));
  return { result: outcome.result, page, attempts: outcome.attempts };
}

async function main() {
  log.info("=== Crescent City Municipal Code Scraper ===");

  await mkdir(ARTICLES_DIR, { recursive: true });

  let toc: TocNode;
  let manifest: ScrapeManifest;

  let page: Page | null = await newPage();

  // Step 1: Fetch TOC
  const cachedToc = existsSync(paths.toc)
    ? await readFile(paths.toc, "utf-8")
      .then(raw => JSON.parse(raw) as unknown)
      .then(value => isTocShapeValid(value) ? value : null)
      .catch(() => null)
    : null;
  const cachedOnly = Bun.argv.includes("--cached-toc");
  let tocSource: "live" | "cached" = "live";
  if (cachedOnly) {
    if (!cachedToc) throw new Error("--cached-toc requested, but output/toc.json is absent or invalid");
    toc = cachedToc;
    tocSource = "cached";
    log.info("Loading cached TOC (--cached-toc)");
  } else {
    try {
      log.info("Fetching current table of contents...");
      toc = await fetchToc(page);
      await writeJsonAtomic(paths.toc, toc);
      log.info("TOC saved to output/toc.json");
    } catch (error) {
      if (!cachedToc) throw error;
      toc = cachedToc;
      tocSource = "cached";
      log.warn("Live TOC fetch failed; continuing from cached TOC", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  log.info(tocSummary(toc));

  const articles = getArticlePages(toc);
  const allSections = getSections(toc);

  log.info(`Articles to scrape: ${articles.length}`);
  log.info(`Expected sections: ${allSections.length}`);

  // Load existing manifest for resume support
  const runStartedAt = new Date().toISOString();
  const currentArticleGuids = new Set(articles.map(article => article.guid));
  const existingManifest = existsSync(paths.manifest)
    ? await readFile(paths.manifest, "utf-8")
      .then(raw => JSON.parse(raw) as unknown)
      .then(value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const candidate = value as Partial<ScrapeManifest>;
        return candidate.articles && typeof candidate.articles === "object" && !Array.isArray(candidate.articles)
          ? candidate
          : null;
      })
      .catch(() => null)
    : null;
  if (existingManifest && existingManifest.articles && typeof existingManifest.articles === "object") {
    manifest = existingManifest as ScrapeManifest;
    log.info(`Resuming: ${Object.keys(manifest.articles).length}/${articles.length} articles already scraped`);
  } else {
    manifest = {
      municipality: toc.tocName,
      municipalityGuid: toc.guid,
      sourceUrl: `${BASE_URL}/${MUNICIPALITY_CODE}`,
      version: "",
      scrapedAt: new Date().toISOString(),
      completedAt: "",
      tocNodeCount: flattenToc(toc).length,
      articlePageCount: articles.length,
      sectionCount: allSections.length,
      articles: {},
    };
  }
  manifest.version ??= "";
  manifest.scrapedAt ??= runStartedAt;
  manifest.completedAt ??= "";
  manifest.articles ??= {};
  for (const guid of Object.keys(manifest.articles)) {
    if (!currentArticleGuids.has(guid)) delete manifest.articles[guid];
  }
  manifest.municipality = toc.tocName;
  manifest.municipalityGuid = toc.guid;
  manifest.sourceUrl = `${BASE_URL}/${MUNICIPALITY_CODE}`;
  manifest.tocFingerprint = await computeSha256(JSON.stringify(toc));
  manifest.tocFetchedAt = tocSource === "live" ? runStartedAt : manifest.tocFetchedAt;
  manifest.tocSource = tocSource;
  manifest.lastRunAt = runStartedAt;
  manifest.tocNodeCount = flattenToc(toc).length;
  manifest.articlePageCount = articles.length;
  manifest.sectionCount = allSections.length;
  manifest.completedAt = "";
  await persistManifest(manifest);

  // Step 2: Scrape each article page
  let scraped = 0;
  let skipped = 0;
  const failedGuids: string[] = [];
  let processed = 0;

  for (const article of articles) {
    processed++;
    if (await readCachedArticleIfValid(article, manifest)) {
      skipped++;
      log.info(`[${processed}/${articles.length}] Cached and verified: ${article.indexNum} ${article.title}`);
      continue;
    }

    log.info(`[${processed}/${articles.length}] Scraping: ${article.indexNum} ${article.title}`, { guid: article.guid });

    try {
      const outcome = await scrapeWithRetries(article, page);
      page = outcome.page;
      const result = outcome.result;

      // Save article content
      const filePath = paths.article(article.guid);
      await writeJsonAtomic(filePath, result);

      // Update manifest
      manifest.articles[article.guid] = {
        guid: article.guid,
        title: article.title,
        number: article.number,
        sectionCount: result.sections.length,
        sha256: result.sha256,
        filePath: `articles/${article.guid}.json`,
        lastScrapedAt: new Date().toISOString(),
      };

      scraped++;
      log.info(`  -> ${result.sections.length} sections, SHA-256: ${result.sha256.substring(0, 16)}... (${outcome.attempts} attempt${outcome.attempts === 1 ? "" : "s"})`);

      // Save manifest after each article (for resume)
      await persistManifest(manifest);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      failedGuids.push(article.guid);
      log.error(`FAILED: ${msg.split("\n")[0]}`, { guid: article.guid });
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  // Finalize
  const failed = failedGuids.length;
  manifest.completedAt = failed === 0 ? new Date().toISOString() : "";
  await persistManifest(manifest);

  await closeBrowser();

  // Summary
  log.info("=== Scrape Complete ===");
  log.info(`  Scraped: ${scraped}`);
  log.info(`  Skipped (cached): ${skipped}`);
  log.info(`  Failed: ${failed}`);
  log.info(`  Total articles: ${articles.length}`);
  log.info(`  Expected sections: ${allSections.length}`);
  const totalSections = Object.values(manifest.articles).reduce(
    (sum, a) => sum + a.sectionCount,
    0
  );
  log.info(`  Actual sections scraped: ${totalSections}`);
  log.info(`Manifest: ${paths.manifest}`);

  if (failed > 0) {
    log.error(`WARNING: ${failed} articles failed to scrape.`);
    log.error("Re-run 'bun run scrape' to retry (resume support will skip completed articles).");
    process.exit(1);
  }
}

// Guarded: importing this module (e.g. from a test) must never launch a
// browser or start scraping as a side effect.
if (import.meta.main) {
  main().catch((err) => {
    log.error("Fatal error", { error: String(err) });
    closeBrowser().finally(() => process.exit(1));
  });
}

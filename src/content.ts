/**
 * Content scraper module.
 * Navigates to each article page and extracts section content.
 * Supports two scraping modes:
 *   1. Standard: article pages that inline all section content
 *   2. Deep: subarticle pages where sections must be scraped individually
 */
import type { Page } from "playwright";
import type { TocNode, ArticlePage, SectionContent } from "./types.js";
import { navigateWithCloudflare, withPageDeadline, newPage, closePageBounded } from "./browser.js";
import { readFile } from "node:fs/promises";
import { BASE_URL, RATE_LIMIT_MS, SCRAPE_TIMEOUT_MS, SPA_RENDER_MS } from "./constants.js";
import { computeSha256 } from "./utils.js";
import { createLogger } from "./logger.js";
import { bindArticleExtraction, custodyHash, validateArticleCustody, type BoundArticle, type ExtractionReceipt } from "./corpus_editions.js";
import { throwIfAborted, waitWithSignal } from "./shared/transport.js";
import { writeJsonAtomic } from "./shared/source_health.js";

const log = createLogger("content");

/**
 * Extract all section-type descendant GUIDs from a TOC node.
 */
export function getSectionGuids(node: TocNode): { guid: string; number: string; title: string }[] {
  const results: { guid: string; number: string; title: string }[] = [];
  if (node.type === "section") {
    results.push({ guid: node.guid, number: node.number ?? node.indexNum ?? "", title: node.title ?? "" });
  }
  for (const child of node.children ?? []) {
    results.push(...getSectionGuids(child));
  }
  return results;
}

/**
 * Scrape a single section page and extract its content.
 * Used for sections in subarticle-layout pages.
 */
async function scrapeSectionPage(
  page: Page,
  sectionGuid: string,
  sectionNumber: string,
  sectionTitle: string,
  signal: AbortSignal,
): Promise<{ section: SectionContent; source: ExtractionReceipt["sourceFragments"][number] } | null> {
  const url = `${BASE_URL}/${sectionGuid}`;
  throwIfAborted(signal);
  try {
    await navigateWithCloudflare(page, url);
    await page.waitForSelector("#codeContent", { timeout: SCRAPE_TIMEOUT_MS / 2 })
      .catch(() => { });
    await page.waitForTimeout(SPA_RENDER_MS / 2);

    const result = await page.evaluate((guid) => {
      // Try the standard pattern first
      const contentDiv = document.querySelector(`.section_content.content`) as HTMLElement | null;
      if (contentDiv) {
        const clone = contentDiv.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".history, .footnotes").forEach((el) => el.remove());
        const historyEl = contentDiv.querySelector(".history");
        return {
          sourceHtml: document.querySelector("#codeContent")?.innerHTML ?? "",
          html: contentDiv.innerHTML,
          text: clone.textContent?.trim() ?? "",
          history: historyEl?.textContent?.trim() ?? "",
        };
      }

      // Fallback: grab all text from codeContent
      const codeContent = document.querySelector("#codeContent") as HTMLElement | null;
      if (codeContent) {
        const clone = codeContent.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".history, .footnotes, .contentTitle").forEach((el) => el.remove());
        const historyEl = codeContent.querySelector(".history");
        return {
          sourceHtml: codeContent.innerHTML,
          html: codeContent.innerHTML,
          text: clone.textContent?.trim() ?? "",
          history: historyEl?.textContent?.trim() ?? "",
        };
      }

      return null;
    }, sectionGuid);

    if (!result || (!result.text && !/reserved/i.test(sectionTitle))) return null;

    return { section: {
      guid: sectionGuid,
      number: sectionNumber,
      title: sectionTitle,
      html: result.html,
      text: result.text,
      history: result.history,
    }, source: { guid: sectionGuid, url: page.url(), html: result.sourceHtml, sha256: custodyHash(result.sourceHtml) } };
  } catch (err: any) {
    if (signal.aborted || page.isClosed()) throw err;
    log.warn(`Failed to deep-scrape section ${sectionNumber}`, { error: err.message?.split("\n")[0] });
    return null;
  }
}

/**
 * Scrape an article page and extract all section content.
 * Article pages contain full text of all child sections.
 * Falls back to deep-scraping individual section pages for subarticle layouts.
 */
export async function scrapeArticlePage(
  page: Page,
  article: TocNode,
  options: { timeoutMs?: number; checkpointPath?: string; resumeDeepSections?: boolean } = {},
): Promise<ArticlePage> {
  const timeout = options.timeoutMs ?? articleDeadlineMs(article);
  return withPageDeadline(page, signal => scrapeArticleWithinDeadline(page, article, signal, options), timeout);
}
export function articleDeadlineMs(article: TocNode): number {
  const configured = process.env.ARTICLE_DEADLINE_MS === undefined ? Math.min(900_000, Math.max(180_000, getSectionGuids(article).length * 7000)) : Number(process.env.ARTICLE_DEADLINE_MS);
  if (!Number.isFinite(configured) || configured <= 0 || configured > 1_800_000) throw new Error("ARTICLE_DEADLINE_MS must be positive and at most 1800000ms");
  return configured;
}
export interface DeepSectionCheckpoint { schemaVersion: "deep-sections/v1"; createdAt: string; savedAt: string; expectedSectionsSha256: string; article: BoundArticle }
/** Partial evidence is reusable only after source replay; it is never a publication article. */
export function isDeepSectionCheckpointValid(value: unknown, article: TocNode, rawHtml: string, now = Date.now()): value is DeepSectionCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as DeepSectionCheckpoint;
  const created = Date.parse(checkpoint.createdAt); const saved = Date.parse(checkpoint.savedAt);
  if (checkpoint.schemaVersion !== "deep-sections/v1" || !Number.isFinite(created) || !Number.isFinite(saved) || created > saved || saved > now || now - created > 86_400_000) return false;
  const expected = getSectionGuids(article);
  if (checkpoint.expectedSectionsSha256 !== custodyHash(JSON.stringify(expected)) || checkpoint.article?.guid !== article.guid || checkpoint.article.title !== article.title || checkpoint.article.number !== article.number || checkpoint.article.rawHtml !== rawHtml || checkpoint.article.extraction?.mode !== "section-pages") return false;
  const members = new Map(expected.map(section => [section.guid, section]));
  if (!Array.isArray(checkpoint.article.sections) || checkpoint.article.sections.some(section => !members.has(section.guid) || members.get(section.guid)!.number !== section.number || members.get(section.guid)!.title !== section.title)) return false;
  return validateArticleCustody(checkpoint.article, checkpoint.article.sections.map(section => section.guid), true).length === 0;
}
async function scrapeArticleWithinDeadline(page: Page, article: TocNode, signal: AbortSignal, options: { checkpointPath?: string; resumeDeepSections?: boolean }): Promise<ArticlePage> {
  throwIfAborted(signal);
  const url = `${BASE_URL}/${article.guid}`;
  await navigateWithCloudflare(page, url);

  // Wait for code content to render
  await page.waitForSelector("#codeContent", { timeout: SCRAPE_TIMEOUT_MS / 2 })
    .catch((e) => log.warn("codeContent selector timeout", { error: e.message }));
  await page.waitForTimeout(SPA_RENDER_MS);

  // Extract the raw HTML of the code content area
  const rawHtml = await page.evaluate(() => {
    const el = document.querySelector("#codeContent");
    return el ? el.innerHTML : "";
  });

  // Extract individual sections (standard extraction)
  const sections = await page.evaluate(() => {
    const results: {
      guid: string;
      number: string;
      title: string;
      html: string;
      text: string;
      history: string;
    }[] = [];

    // Each section has a content div with id like "44236161_content"
    const contentDivs = document.querySelectorAll(
      '.section_content.content'
    );

    contentDivs.forEach((div) => {
      const id = div.id; // e.g., "44236161_content"
      const guid = id.replace("_content", "");

      // Find the corresponding title element (use getElementById since IDs start with digit)
      const titleEl = document.getElementById(`${guid}_title`) || document.getElementById(guid);
      const numberEl = titleEl?.querySelector(".titleNumber");
      const titleTextEl = titleEl?.querySelector(".titleTitle");

      const number = numberEl?.textContent?.trim() ?? "";
      const title = titleTextEl?.textContent?.trim() ?? "";

      // Get the section content
      const html = div.innerHTML;

      // Get plain text from all content elements (paras, definitions, tables, etc.)
      // Exclude .history and .footnotes which are handled separately
      const clone = div.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".history, .footnotes").forEach((el) => el.remove());
      const text = clone.textContent?.trim() ?? "";

      // Get history
      const historyEl = div.querySelector(".history");
      const history = historyEl?.textContent?.trim() ?? "";

      results.push({ guid, number, title, html, text, history });
    });

    return results;
  });

  let finalSections = sections as SectionContent[];
  let mode: "inline" | "section-pages" = "inline";
  const sourceFragments: ExtractionReceipt["sourceFragments"] = [];

  // Deep-scrape fallback: if article has child sections in TOC but none were extracted,
  // the article uses subarticle layout, so scrape each section page individually
  const expectedSections = getSectionGuids(article);
  if (finalSections.length === 0 && expectedSections.length > 0) {
    mode = "section-pages";
    log.info(`Subarticle layout detected — deep-scraping ${expectedSections.length} sections individually`);
    const deepSections: SectionContent[] = [];
    let createdAt = new Date().toISOString();
    if (options.checkpointPath && options.resumeDeepSections !== false) {
      try {
        const value: unknown = JSON.parse(await readFile(options.checkpointPath, "utf8"));
        if (isDeepSectionCheckpointValid(value, article, rawHtml)) {
          createdAt = value.createdAt; deepSections.push(...value.article.sections); sourceFragments.push(...value.article.extraction.sourceFragments);
          log.info(`Resuming ${deepSections.length}/${expectedSections.length} source-bound deep sections`);
        }
      } catch { /* Missing or invalid partial evidence is reacquired. */ }
    }
    let deepPage = page;
    const closeOnAbort = () => { if (deepPage !== page) void closePageBounded(deepPage); };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      for (const { guid, number, title } of expectedSections) {
        throwIfAborted(signal);
        if (deepSections.some(section => section.guid === guid)) continue;
        let sectionContent: Awaited<ReturnType<typeof scrapeSectionPage>> = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          throwIfAborted(signal);
          try {
            if (deepPage.isClosed()) { deepPage = await newPage(); if (signal.aborted) { await closePageBounded(deepPage); throwIfAborted(signal); } }
            sectionContent = await scrapeSectionPage(deepPage, guid, number, title, signal);
            if (sectionContent) break;
          } catch (error) { throwIfAborted(signal); log.warn(`Deep section ${number} attempt ${attempt + 1} failed`, { error: String(error).split("\n")[0] }); }
          await closePageBounded(deepPage); await waitWithSignal(RATE_LIMIT_MS, signal);
        }
        if (!sectionContent) throw new Error(`Deep section ${number} unavailable after three attempts; completed evidence checkpoint retained`);
        deepSections.push(sectionContent.section); sourceFragments.push(sectionContent.source);
        if (options.checkpointPath) {
          throwIfAborted(signal);
          const partial = bindArticleExtraction({ guid: article.guid, url, title: article.title, number: article.number, rawHtml, sha256: custodyHash(rawHtml), scrapedAt: createdAt, sections: deepSections }, "section-pages", sourceFragments);
          await writeJsonAtomic(options.checkpointPath, { schemaVersion: "deep-sections/v1", createdAt, savedAt: new Date().toISOString(), expectedSectionsSha256: custodyHash(JSON.stringify(expectedSections)), article: partial } satisfies DeepSectionCheckpoint);
        }
        if (deepSections.length % 10 === 0 || deepSections.length === expectedSections.length) log.info(`Deep-section progress: ${deepSections.length}/${expectedSections.length}`);
        await waitWithSignal(RATE_LIMIT_MS / 2, signal);
      }
    } finally { signal.removeEventListener("abort", closeOnAbort); if (deepPage !== page) await closePageBounded(deepPage); }

    finalSections = expectedSections.map(expected => deepSections.find(section => section.guid === expected.guid)!);
    log.info(`Deep-scraped ${deepSections.length}/${expectedSections.length} sections`);
  }

  if (expectedSections.length > 0 && finalSections.length === 0) {
    throw new Error(`No sections were extracted from article ${article.guid}; refusing to persist an empty scrape`);
  }

  const sha256 = await computeSha256(rawHtml);
  throwIfAborted(signal);

  return bindArticleExtraction({
    guid: article.guid,
    url,
    title: article.title,
    number: article.number,
    rawHtml,
    sections: finalSections,
    sha256,
    scrapedAt: new Date().toISOString(),
  }, mode, sourceFragments);
}

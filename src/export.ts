#!/usr/bin/env bun
/**
 * Export module.
 *
 * Converts scraped data into usable formats:
 *   1. Full consolidated JSON (all sections in one file)
 *   2. Markdown files organized by title/chapter/section
 *   3. Plain text corpus
 *   4. Section index CSV
 *
 * The four format builders are PURE functions (they take the loaded TOC +
 * articles and return the JSON object / text strings / markdown file map).
 * They are exported so they can be unit-tested in isolation
 * (tests/export.test.ts) without touching the filesystem. `main()` (guarded by
 * `import.meta.main`) wires them to disk using the shared atomic writers, so
 * importing this module from a test never triggers an export as a side effect.
 */
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { TocNode, ArticlePage } from "./types.js";
import { flattenToc, htmlToText, csvEscape, sanitizeFilename } from "./utils.js";
import { loadToc, loadManifest, loadAllArticles } from "./shared/data.js";
import { writeJsonAtomic, writeTextAtomic } from "./shared/source_health.js";
import { paths } from "./shared/paths.js";
import { createLogger } from "./logger.js";

const log = createLogger("export");

/** Build the consolidated JSON object (municipality envelope + all articles/sections). */
export function buildConsolidatedJson(toc: TocNode, articles: ArticlePage[]): Record<string, unknown> {
  return {
    municipality: toc.tocName,
    guid: toc.guid,
    source: "https://ecode360.com/CR4919",
    exportedAt: new Date().toISOString(),
    articles: articles.map((a) => ({
      guid: a.guid,
      title: a.title,
      number: a.number,
      url: a.url,
      sha256: a.sha256,
      sections: a.sections.map((s) => ({
        guid: s.guid,
        number: s.number,
        title: s.title,
        text: s.text,
        history: s.history,
      })),
    })),
  };
}

/**
 * Build the panel of Markdown files to write.
 * Returns [{ relPath, content }] relative to the markdown root; each `content`
 * is one complete file body (title index README, per-chapter file, or appendix).
 */
export function buildMarkdownFiles(
  toc: TocNode,
  articles: ArticlePage[]
): Array<{ relPath: string; content: string }> {
  const files: Array<{ relPath: string; content: string }> = [];

  // Build title grouping from TOC
  const titleNodes = flattenToc(toc).filter(
    (n) => n.type === "chapter" && n.label === "Title"
  );

  for (const title of titleNodes) {
    const titleDir = `Title_${title.number.padStart(2, "0")}_${sanitizeFilename(title.title)}`;
    const titleIndex = [`# Title ${title.number}: ${title.title}\n`];
    const chapterNodes = title.children.filter((c) => c.type === "article");

    for (const chapter of chapterNodes) {
      const article = articles.find((a) => a.guid === chapter.guid);
      if (!article) continue;
      titleIndex.push(`## Chapter ${chapter.number}: ${chapter.title}\n`);
      const mdLines = [
        `# Chapter ${chapter.number}: ${chapter.title}\n`,
        `> Part of Title ${title.number}: ${title.title}\n`,
        `> Source: ${article.url}\n`,
      ];
      for (const section of article.sections) {
        mdLines.push(`\n## ${section.number}: ${section.title}\n`);
        mdLines.push(section.text || htmlToText(section.html));
        if (section.history) mdLines.push(`\n*${section.history}*\n`);
        titleIndex.push(
          `- [${section.number}: ${section.title}](${sanitizeFilename(chapter.number)}.md#${section.number.replace(/§\s*/, "").replace(/\s/g, "-")})`
        );
      }
      files.push({
        relPath: `${titleDir}/${sanitizeFilename(chapter.number)}.md`,
        content: mdLines.join("\n"),
      });
    }

    files.push({ relPath: `${titleDir}/README.md`, content: titleIndex.join("\n") });
  }

  // Handle appendices
  const appendixArticles = flattenToc(toc).filter(
    (n) => n.type === "article" && !titleNodes.some((t) => t.guid === n.parent)
  );
  for (const chapter of appendixArticles) {
    const article = articles.find((a) => a.guid === chapter.guid);
    if (!article) continue;
    const mdLines = [`# ${chapter.indexNum}: ${chapter.title}\n`, `> Source: ${article.url}\n`];
    for (const section of article.sections) {
      mdLines.push(`\n## ${section.number}: ${section.title}\n`);
      mdLines.push(section.text || htmlToText(section.html));
      if (section.history) mdLines.push(`\n*${section.history}*\n`);
    }
    files.push({
      relPath: `Other/${sanitizeFilename(chapter.indexNum || chapter.guid)}.md`,
      content: mdLines.join("\n"),
    });
  }

  return files;
}

/** Build the plain-text corpus body (sorting a copy, never mutating the input). */
export function buildPlainText(articles: ArticlePage[]): string {
  const textLines: string[] = [
    `CRESCENT CITY, CA - CODE OF ORDINANCES`,
    `Source: https://ecode360.com/CR4919`,
    `Exported: ${new Date().toISOString()}`,
    `${"=".repeat(60)}\n`,
  ];
  for (const article of [...articles].sort((a, b) => a.number.localeCompare(b.number))) {
    textLines.push(`\nCHAPTER ${article.number}: ${article.title}`);
    textLines.push("-".repeat(40));
    for (const section of article.sections) {
      textLines.push(`\n${section.number}: ${section.title}`);
      textLines.push(section.text || htmlToText(section.html));
      if (section.history) textLines.push(`[${section.history}]`);
    }
  }
  return textLines.join("\n");
}

/** Build the section-index CSV body (header + one row per section). */
export function buildSectionIndexCsv(articles: ArticlePage[]): string {
  const csvLines = ["guid,number,title,chapter_guid,chapter_number,chapter_title,history"];
  for (const article of articles) {
    for (const section of article.sections) {
      csvLines.push(
        [
          section.guid,
          csvEscape(section.number),
          csvEscape(section.title),
          article.guid,
          csvEscape(article.number),
          csvEscape(article.title),
          csvEscape(section.history),
        ].join(",")
      );
    }
  }
  return csvLines.join("\n");
}

async function main() {
  log.info("=== Crescent City Municipal Code Exporter ===");

  if (!existsSync(paths.toc) || !existsSync(paths.manifest)) {
    log.error("Run the scraper first (bun run scrape)");
    process.exit(1);
  }

  const toc = await loadToc();
  const manifest = await loadManifest();
  const articles = await loadAllArticles();

  log.info(`Loaded ${articles.length} article files`);

  // Run all four exports concurrently for maximum throughput
  log.info("Running all four export formats concurrently...");
  await Promise.all([
    // Export 1: Consolidated JSON
    (async () => {
      await writeJsonAtomic(paths.consolidatedJson, buildConsolidatedJson(toc, articles));
      log.info(`  [JSON] -> ${paths.consolidatedJson}`);
    })(),

    // Export 2: Markdown by title/chapter
    (async () => {
      const mdDir = paths.markdown;
      await mkdir(mdDir, { recursive: true });
      const files = buildMarkdownFiles(toc, articles);
      await Promise.all(files.map(async (f) => {
        await writeTextAtomic(join(mdDir, f.relPath), f.content);
      }));
      log.info(`  [Markdown] -> ${paths.markdown}/`);
    })(),

    // Export 3: Plain text corpus
    (async () => {
      await writeTextAtomic(paths.plainText, buildPlainText(articles));
      log.info(`  [Text] -> ${paths.plainText}`);
    })(),

    // Export 4: Section index CSV
    (async () => {
      await writeTextAtomic(paths.sectionIndex, buildSectionIndexCsv(articles));
      log.info(`  [CSV] -> ${paths.sectionIndex}`);
    })(),
  ]);

  // Summary
  const totalSections = articles.reduce((s, a) => s + a.sections.length, 0);
  log.info("=== Export Complete ===");
  log.info(`  Articles: ${articles.length}`);
  log.info(`  Sections: ${totalSections}`);
  log.info(`  Formats: JSON, Markdown, Plain Text, CSV (all concurrent)`);
}

// Guarded: importing this module (e.g. from a test, to reach the pure builders
// above) must never trigger a full export as a side effect.
if (import.meta.main) {
  main().catch((err) => {
    log.error("Fatal error", { error: String(err) });
    process.exit(1);
  });
}

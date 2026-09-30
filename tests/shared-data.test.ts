import { beginSeedCorpus, endCorpusCopy, withEmptyCorpus } from "./helpers/output-root.ts";
import { invalidateSectionsCache } from "../src/shared/data.ts";
beforeAll(async () => { await beginSeedCorpus(); invalidateSectionsCache(); });
afterAll(async () => { await endCorpusCopy(); invalidateSectionsCache(); });
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  loadToc,
  loadManifest,
  loadAllArticles,
  loadAllSections,
  loadSection,
  loadMonitorReport,
  hasScrapedData,
  hasArticles,
} from "../src/shared/data";
import { paths } from "../src/shared/paths";
import { runMonitor } from "../src/monitor.ts";

// Corpus tests always use reviewed seed text; absence cases use a separate empty root.

const hasOutput = true; // Every corpus case uses the reviewed seed fixture below.

describe("shared/data — core loaders", () => {
  test("loadToc returns a TocNode with expected fields", async () => {
    if (!hasOutput) return;
    const toc = await loadToc();
    expect(toc).toBeDefined();
    expect(toc.guid).toBeDefined();
    expect(toc.tocName).toBeDefined();
    expect(Array.isArray(toc.children)).toBe(true);
    expect(toc.type).toBe("code");
  });

  test("loadToc throws with actionable message when output absent", async () => {
    // Always tests: if output missing, error message is descriptive
    await withEmptyCorpus(async () => { await expect(loadToc()).rejects.toThrow("Run 'bun run scrape' first"); });
  });

  test("loadManifest returns a ScrapeManifest with expected fields", async () => {
    if (!hasOutput) return;
    const manifest = await loadManifest();
    expect(manifest).toBeDefined();
    expect(manifest.municipality).toBeDefined();
    expect(typeof manifest.articlePageCount).toBe("number");
    expect(typeof manifest.sectionCount).toBe("number");
    expect(manifest.articles).toBeDefined();
    expect(typeof manifest.articles).toBe("object");
  });

  test("loadAllArticles returns array of ArticlePage objects", async () => {
    if (!hasOutput) return;
    const articles = await loadAllArticles();
    expect(Array.isArray(articles)).toBe(true);
    if (articles.length > 0) {
      const first = articles[0];
      expect(first.guid).toBeDefined();
      expect(first.url).toBeDefined();
      expect(first.title).toBeDefined();
      expect(Array.isArray(first.sections)).toBe(true);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("loadAllArticles returns empty array when output dir absent", async () => {
    // The function always returns [] gracefully if dir missing
    await withEmptyCorpus(async () => { expect(await loadAllArticles()).toEqual([]); });
  });
});

describe("shared/data — loadAllSections", () => {
  test("FlatSection includes history and articleNumber fields", async () => {
    if (!hasOutput) return;
    const sections = await loadAllSections();
    expect(Array.isArray(sections)).toBe(true);
    if (sections.length > 0) {
      const first = sections[0];
      expect(first.guid).toBeDefined();
      expect(first.number).toBeDefined();
      expect(first.title).toBeDefined();
      expect(first.text).toBeDefined();
      expect(first.articleGuid).toBeDefined();
      expect(first.articleTitle).toBeDefined();
      expect("history" in first).toBe(true);
      expect("articleNumber" in first).toBe(true);
    }
  });
});

describe("shared/data — loadSection", () => {
  test("returns undefined for unknown guid when output absent", async () => {
    await withEmptyCorpus(async () => { expect(await loadSection("nonexistent-guid")).toBeUndefined(); });
  });

  test("finds section by guid in real data", async () => {
    if (!hasOutput) return;
    const sections = await loadAllSections();
    if (sections.length === 0) return;
    const target = sections[0];
    const found = await loadSection(target.guid);
    expect(found).toBeDefined();
    expect(found!.guid).toBe(target.guid);
    expect(found!.articleGuid).toBe(target.articleGuid);
  });
});

describe("shared/data — loadMonitorReport", () => {
  test("returns undefined when monitor-report.json does not exist", async () => {
    await withEmptyCorpus(async () => { expect(await loadMonitorReport()).toBeUndefined(); });
  });

  test("loads the exact current monitor producer report from the selected fixture root", async () => {
    const produced = await runMonitor();
    const report = await loadMonitorReport();
    expect(report).toEqual(produced);
    expect(typeof report!.timestamp).toBe("string");
    expect(typeof report!.articlesChecked).toBe("number");
    expect(Array.isArray(report!.hashMismatches)).toBe(true);
    expect(["clean", "changed", "error"]).toContain(report!.overallStatus);
  });
});

describe("shared/data — existence checks", () => {
  test("hasScrapedData matches actual file existence", () => {
    const result = hasScrapedData();
    expect(typeof result).toBe("boolean");
    expect(result).toBe(hasOutput);
  });

  test("hasArticles is a function that returns a promise", async () => {
    const result = await hasArticles();
    expect(typeof result).toBe("boolean");
  });
});

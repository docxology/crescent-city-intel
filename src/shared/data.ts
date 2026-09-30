/** Shared data loading layer for reading scraped output */
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import type {
  TocNode,
  ScrapeManifest,
  ArticlePage,
  FlatSection,
  MonitorReport,
} from "../types.js";
import { paths, outputRoot } from "./paths.js";
import { validateArticleCustody } from "../corpus_editions.js";
import { createLogger } from "../logger.js";

const logger = createLogger("data");

// ─── In-process TTL cache ─────────────────────────────────────────

/** Cache entry for all sections (60 second TTL) */
let _sectionsCache: FlatSection[] | null = null;
let _sectionsCacheTs = 0;
/** The artifact root the cached sections were read from: a test that redirects
 * CC_OUTPUT_DIR to a corpus copy mid-process must never be served the other
 * root's sections through this cache. */
let _sectionsCacheRoot = "";
/** In-flight load promise — prevents concurrent callers from duplicating work. */
const _sectionsLoads = new Map<string, Promise<FlatSection[]>>();
const SECTIONS_CACHE_TTL_MS = 60_000; // 60 seconds

/** Invalidate the sections cache (call after re-scrape or export). */
export function invalidateSectionsCache(): void {
  _sectionsCache = null;
  _sectionsCacheTs = 0;
  _sectionsCacheRoot = "";
}

// ─── Core loaders ────────────────────────────────────────────────

/** Load the TOC tree from output/toc.json */
export async function loadToc(): Promise<TocNode> {
  try {
    const raw = await readFile(paths.toc, "utf-8");
    return JSON.parse(raw) as TocNode;
  } catch (err: any) {
    throw new Error(`Failed to load TOC from ${paths.toc}: ${err.message}. Run 'bun run scrape' first.`);
  }
}

/** Load the scrape manifest from output/manifest.json */
export async function loadManifest(): Promise<ScrapeManifest> {
  try {
    const raw = await readFile(paths.manifest, "utf-8");
    return JSON.parse(raw) as ScrapeManifest;
  } catch (err: any) {
    throw new Error(`Failed to load manifest from ${paths.manifest}: ${err.message}. Run 'bun run scrape' first.`);
  }
}

/** Load a single article by GUID */
export async function loadArticle(guid: string): Promise<ArticlePage> {
  if (!/^[A-Za-z0-9_-]+$/.test(guid)) throw new Error("Invalid article GUID");
  const root = outputRoot();
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8")) as ScrapeManifest;
  const entry = manifest.articles?.[guid];
  if (!entry) throw new Error(`Article '${guid}' is absent from current manifest`);
  const value: unknown = JSON.parse(await readFile(`${root}/articles/${guid}.json`, "utf8"));
  const errors = validateArticleCustody(value, undefined, true);
  if (errors.length) throw new Error(`Article '${guid}' failed custody: ${errors.join("; ")}`);
  const article = value as ArticlePage;
  if (article.guid !== guid || article.sha256 !== entry.sha256 || article.sections.length !== entry.sectionCount) throw new Error(`Article '${guid}' differs from manifest`);
  return article;
}

/** Load all article files from the articles directory (in parallel) */
export async function loadAllArticles(root = outputRoot()): Promise<ArticlePage[]> {
  const dir = `${root}/articles`;
  if (!existsSync(dir)) return [];
  // Sort for deterministic corpus ordering — `readdir` order is filesystem-
  // dependent, and every downstream consumer (search, export, structured
  // queries, index fingerprints) would otherwise inherit run-to-run
  // nondeterminism (see embeddings.ts index-fingerprint determinism claim).
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8")) as ScrapeManifest;
  if (!manifest.articles || typeof manifest.articles !== "object" || Array.isArray(manifest.articles)) throw new Error("Invalid corpus manifest membership");
  const jsonFiles = Object.keys(manifest.articles).sort().map(guid => {
    if (!/^[A-Za-z0-9_-]+$/.test(guid)) throw new Error("Unsafe article GUID in manifest");
    return `${guid}.json`;
  });
  // Load all articles in parallel for speed
  const articles = await Promise.allSettled(
    jsonFiles.map(async f => {
      const article: unknown = JSON.parse(await readFile(`${dir}/${f}`, "utf-8"));
      const errors = validateArticleCustody(article, undefined, true);
      if (errors.length) throw new Error(`${f}: ${errors.join("; ")}`);
      const value = article as ArticlePage; const entry = manifest.articles[value.guid];
      if (!entry || value.guid !== f.slice(0, -5) || entry.sha256 !== value.sha256 || entry.sectionCount !== value.sections.length) throw new Error(`${f}: manifest membership/hash/count differs`);
      return value;
    })
  );
  const result: ArticlePage[] = [];
  let skipped = 0;
  for (const outcome of articles) {
    if (outcome.status === "fulfilled") {
      result.push(outcome.value);
    } else {
      // A corrupt/unreadable article is silent data loss for every consumer
      // that relies on this corpus — surface it loudly so monitor/verify
      // failures aren't masked by a merely-reduced section set.
      skipped += 1;
      logger.warn("loadAllArticles: skipping unreadable/corrupt article", { reason: outcome.reason?.message ?? String(outcome.reason) });
    }
  }
  if (skipped > 0) {
    throw new Error(`loadAllArticles: ${skipped} of ${jsonFiles.length} manifest article(s) failed validation; corpus is incomplete`);
  }
  return result;
}

/** Load all sections as a flat array with article metadata attached.
 * Cached in-process for 60 seconds to avoid redundant disk reads.
 * Concurrent callers share a single in-flight load. */
export async function loadAllSections(): Promise<FlatSection[]> {
  const now = Date.now();
  const root = outputRoot();
  // A cached read is only valid for the artifact root it came from: tests
  // redirect CC_OUTPUT_DIR to a corpus copy mid-process, and serving the other
  // root's sections here would quietly score queries against the wrong corpus.
  if (_sectionsCache && _sectionsCacheRoot === root && now - _sectionsCacheTs < SECTIONS_CACHE_TTL_MS) {
    return _sectionsCache;
  }
  const pending = _sectionsLoads.get(root);
  if (pending) return pending;
  const load = (async () => {
    try {
      const articles = await loadAllArticles(root);
      const sections: FlatSection[] = [];
      for (const article of articles) {
        for (const s of article.sections) {
          sections.push({
            guid: s.guid,
            number: s.number,
            title: s.title,
            text: s.text,
            history: s.history,
            articleGuid: article.guid,
            articleTitle: article.title,
            articleNumber: article.number,
          });
        }
      }
      _sectionsCache = sections;
      _sectionsCacheTs = Date.now();
      _sectionsCacheRoot = root;
      return sections;
    } finally {
      _sectionsLoads.delete(root);
    }
  })();
  _sectionsLoads.set(root, load);
  return load;
}

/**
 * Load a single section by GUID across all articles.
 * Uses the in-process 60s TTL cache (loadAllSections) for O(1) lookup
 * instead of scanning every article file on disk.
 * Returns undefined if not found.
 */
export async function loadSection(guid: string): Promise<FlatSection | undefined> {
  const sections = await loadAllSections();
  return sections.find(s => s.guid === guid);
}

// ─── Monitoring data ─────────────────────────────────────────────

/**
 * Load the latest monitor report from output/monitor-report.json.
 * Returns undefined if the file does not exist (monitor has never been run).
 */
export async function loadMonitorReport(): Promise<MonitorReport | undefined> {
  const reportPath = `${paths.output}/monitor-report.json`;
  if (!existsSync(reportPath)) return undefined;
  try {
    const raw = await readFile(reportPath, "utf-8");
    return JSON.parse(raw) as MonitorReport;
  } catch (err: any) {
    throw new Error(`Failed to load monitor report: ${err.message}`);
  }
}

// ─── Existence checks ────────────────────────────────────────────

/** Returns true if scraped data exists (toc.json + manifest.json) */
export function hasScrapedData(): boolean {
  return existsSync(paths.toc) && existsSync(paths.manifest);
}

/** Returns true if the articles directory exists and is non-empty */
export async function hasArticles(): Promise<boolean> {
  if (!existsSync(paths.articles)) return false;
  const files = await readdir(paths.articles);
  return files.some(f => f.endsWith(".json"));
}

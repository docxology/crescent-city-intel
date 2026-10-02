import { currentCivicProfile } from "./civic_profile.js";
/** Municipal-code custody: source fragments, parsed text, and immutable edition receipts. */
import { load } from "cheerio";
import { readFile, mkdir, readdir, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArticlePage, SectionContent } from "./types.js";
import { isArticleArtifactShapeValid } from "./scraper_utils.js";
import { writeJsonAtomic } from "./shared/source_health.js";

export const EXTRACTION_PARSER_VERSION = "ecode360-sections/v2";
export interface ExtractionReceipt {
  parserVersion: typeof EXTRACTION_PARSER_VERSION;
  rawHtmlSha256: string;
  sectionsSha256: string;
  exportedArticleSha256: string;
  mode: "inline" | "section-pages";
  sourceFragments: Array<{ guid: string; url: string; html: string; sha256: string }>;
}
export type BoundArticle = ArticlePage & { extraction: ExtractionReceipt; extractionSha256: string };
export function custodyHash(bytes: string | Uint8Array): string { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }
export function exportedArticleValue(article: ArticlePage): Record<string, unknown> {
  return { guid: article.guid, title: article.title, number: article.number, url: article.url, sha256: article.sha256,
    sections: article.sections.map(({ guid, number, title, text, history }) => ({ guid, number, title, text, history })) };
}
export function exportedArticleSha256(article: ArticlePage): string { return custodyHash(JSON.stringify(exportedArticleValue(article))); }
export function articleSetSha256(articles: ArticlePage[]): string {
  return custodyHash(JSON.stringify([...articles].sort((a, b) => a.guid.localeCompare(b.guid)).map(article => [article.guid, exportedArticleSha256(article)])));
}
export function sectionText(html: string, fallback = false): string {
  const $ = load(html, {}, false);
  $(".history,.footnotes").remove();
  if (fallback) $(".contentTitle").remove();
  return $.root().text().trim();
}
/** Replay HTML5 parsing on both sides; browser processing-instruction serialization becomes a bogus comment. */
export function canonicalSourceFragment(html: string): string { return load(html, {}, false).root().html() ?? ""; }
export function bindArticleExtraction(article: ArticlePage, mode: ExtractionReceipt["mode"] = "inline", sourceFragments: ExtractionReceipt["sourceFragments"] = []): BoundArticle {
  const extraction: ExtractionReceipt = { parserVersion: EXTRACTION_PARSER_VERSION, rawHtmlSha256: custodyHash(article.rawHtml),
    sectionsSha256: custodyHash(JSON.stringify(article.sections)), exportedArticleSha256: exportedArticleSha256(article), mode,
    sourceFragments };
  return { ...article, extraction, extractionSha256: custodyHash(JSON.stringify(extraction)) };
}
// A successful replay is immutable under this content hash. Every call still
// validates shape/membership and recomputes raw/section/export/receipt hashes.
// Keep only hashes, bounded independently of artifact roots or cache TTLs.
const successfulReplays = new Set<string>();
const REPLAY_CACHE_LIMIT = 512;
/** A hash only identifies bytes; this additionally replays text extraction from retained source fragments. */
export function validateArticleCustody(value: unknown, expectedGuids?: readonly string[], requireBinding = false): string[] {
  if (!isArticleArtifactShapeValid(value, expectedGuids ?? [], expectedGuids !== undefined)) return ["Invalid article or section shape/membership"];
  const article = value as BoundArticle;
  const errors: string[] = [];
  if (custodyHash(article.rawHtml) !== article.sha256) errors.push("Raw HTML SHA-256 mismatch");
  const receipt = article.extraction;
  if (!receipt) return requireBinding ? [...errors, "Extraction receipt absent; legacy artifact has no parsed-source custody"] : errors;
  if (receipt.parserVersion !== EXTRACTION_PARSER_VERSION || !Array.isArray(receipt.sourceFragments)) return [...errors, "Unsupported extraction receipt"];
  const receiptHash = custodyHash(JSON.stringify(receipt));
  if (article.extractionSha256 !== receiptHash) errors.push("Extraction receipt hash mismatch");
  if (receipt.rawHtmlSha256 !== article.sha256 || receipt.sectionsSha256 !== custodyHash(JSON.stringify(article.sections)) || receipt.exportedArticleSha256 !== exportedArticleSha256(article)) errors.push("Parsed/source/export binding mismatch");
  if (!errors.length && successfulReplays.has(receiptHash)) return [];
  const $ = load(article.rawHtml, {}, false);
  const nodesById = new Map<string, ReturnType<typeof $>>();
  $("[id]").each((_, element) => { const node = $(element); const id = node.attr("id")!; if (!nodesById.has(id)) nodesById.set(id, node); });
  const fragments = new Map(receipt.sourceFragments.map(fragment => [fragment.guid, fragment]));
  if (fragments.size !== receipt.sourceFragments.length || (receipt.mode === "section-pages" && fragments.size !== article.sections.length)) errors.push("Source fragment membership mismatch");
  for (const section of article.sections) {
    const parsedSection = load(section.html, {}, false);
    const canonicalSection = parsedSection.root().html() ?? "";
    const history = parsedSection(".history").first().text().trim();
    if (receipt.mode === "inline") {
      const node = nodesById.get(`${section.guid}_content`);
      if (!node || node.html() !== canonicalSection) errors.push(`Source fragment mismatch: ${section.guid}`);
      if (!section.text.trim() && !/reserved/i.test(nodesById.get(`${section.guid}_title`)?.text() ?? "")) errors.push(`Reserved status absent from retained source heading: ${section.guid}`);
    } else if (receipt.mode === "section-pages") {
      const fragment = fragments.get(section.guid);
      if (!fragment || fragment.sha256 !== custodyHash(fragment.html)) errors.push(`Deep source fragment mismatch: ${section.guid}`);
      else {
        try { const url = new URL(fragment.url); if (url.origin !== "https://ecode360.com" || url.pathname !== `/${section.guid}`) errors.push(`Deep source URL mismatch: ${section.guid}`); } catch { errors.push(`Invalid deep source URL: ${section.guid}`); }
        const source = load(fragment.html, {}, false); const selected = source(".section_content.content").first();
        if ((selected.length ? selected.html() ?? "" : source.root().html() ?? "") !== canonicalSection) errors.push(`Deep selector replay mismatch: ${section.guid}`);
        if (!section.text.trim() && !/reserved/i.test(source(".contentTitle").text())) errors.push(`Reserved status absent from deep source heading: ${section.guid}`);
      }
    } else errors.push("Invalid extraction mode");
    parsedSection(".history,.footnotes").remove();
    const text = parsedSection.root().text().trim();
    parsedSection(".contentTitle").remove();
    const fallbackText = parsedSection.root().text().trim();
    if (section.text !== text && section.text !== fallbackText) errors.push(`Parsed text differs from source: ${section.guid}`);
    if (history !== section.history) errors.push(`Parsed history differs from source: ${section.guid}`);
  }
  if (!errors.length) {
    successfulReplays.add(receiptHash);
    if (successfulReplays.size > REPLAY_CACHE_LIMIT) successfulReplays.delete(successfulReplays.values().next().value!);
  }
  return errors;
}

/** Preserve complete prior bytes before replacement; this receipt is custody, not live validation. */
export async function captureCorpusEdition(root: string, reason: string): Promise<string | null> {
  const bytes = new Map<string, Buffer>();
  try { for (const name of ["manifest.json", "toc.json"]) bytes.set(name, await readFile(join(root, name))); } catch { return null; }
  const manifest = JSON.parse(bytes.get("manifest.json")!.toString()) as { articles?: Record<string, unknown> };
  if (!manifest.articles || typeof manifest.articles !== "object") return null;
  for (const name of ["verification-report.json", `${currentCivicProfile().corpusSlug}.json`]) {
    try { bytes.set(name, await readFile(join(root, name))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const guid of Object.keys(manifest.articles).sort()) {
    if (!/^[A-Za-z0-9_-]+$/.test(guid)) throw new Error("Unsafe corpus GUID");
    try { bytes.set(`articles/${guid}.json`, await readFile(join(root, "articles", `${guid}.json`))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const files = Object.fromEntries([...bytes].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, custodyHash(value)]));
  const id = custodyHash(JSON.stringify(files)); const directory = join(root, "editions", id);
  async function checkExisting(): Promise<void> {
    const receipt = JSON.parse(await readFile(join(directory, "edition-receipt.json"), "utf8")) as { files: Record<string, string> };
    if (JSON.stringify(receipt.files) !== JSON.stringify(files)) throw new Error("Existing edition receipt differs from immutable inventory");
    for (const [name, hash] of Object.entries(files)) if (custodyHash(await readFile(join(directory, name))) !== hash) throw new Error("Existing edition bytes differ from receipt");
  }
  try { await readFile(join(directory, "edition-receipt.json")); await checkExisting(); return id; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staging = join(root, "editions", `.staging-${crypto.randomUUID()}`);
  await mkdir(join(staging, "articles"), { recursive: true });
  try {
    for (const [name, value] of bytes) await writeFile(join(staging, name), value, { flag: "wx" });
    await writeJsonAtomic(join(staging, "edition-receipt.json"), { schemaVersion: "corpus-edition/v1", editionId: id, capturedAt: new Date().toISOString(), reason, validation: "not-established", files });
    try { await rename(staging, directory); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await checkExisting(); }
    return id;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function quarantineRetiredArticles(root: string, currentGuids: ReadonlySet<string>): Promise<string[]> {
  let names: string[]; try { names = await readdir(join(root, "articles")); } catch { return []; }
  const retired = names.filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name) && !currentGuids.has(name.slice(0, -5)));
  if (!retired.length) return [];
  const directory = join(root, "quarantine", `retired-${Date.now()}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  for (const name of retired) await rename(join(root, "articles", name), join(directory, name));
  await writeJsonAtomic(join(directory, "receipt.json"), { reason: "Absent from current TOC article membership", files: retired, quarantinedAt: new Date().toISOString() });
  return retired;
}

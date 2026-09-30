#!/usr/bin/env bun
/** Independent local custody, current TOC, and deterministic live sample verification. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TocNode, ScrapeManifest, ArticlePage, VerificationResult, VerificationReport } from "./types.js";
import { getArticlePages, getSections, fetchToc } from "./toc.js";
import { newPage, closeBrowser, navigateWithCloudflare } from "./browser.js";
import { paths, outputRoot } from "./shared/paths.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { isTocShapeValid } from "./scraper_utils.js";
import { custodyHash, validateArticleCustody, articleSetSha256 } from "./corpus_editions.js";
import { VERIFY_SAMPLE_SIZE } from "./constants.js";
import { createLogger } from "./logger.js";
const log = createLogger("verifier");
export function collectDescendantSections(node: TocNode): TocNode[] {
  return node.children.flatMap(child => child.type === "section" ? [child] : collectDescendantSections(child));
}
export type VerificationPlane = "pass" | "fail" | "unavailable" | "not_attempted";
export interface BoundVerificationReport extends VerificationReport {
  schemaVersion: "corpus-verification/v2";
  publicationEligible: boolean;
  binding: { manifestSha256: string; tocSha256: string; articleSetSha256: string };
  planes: { local: VerificationPlane; currentToc: VerificationPlane; sample: VerificationPlane };
  evidence: { currentToc: string; sample: string; limitations: string[] };
  sample: { attempted: number; passes: number; mismatches: number; failed: number; selected: string[]; results: Array<{ guid: string; status: "pass" | "mismatch" | "unavailable"; error?: string }> };
  localErrors: string[];
}
export interface VerifyCorpusOptions {
  root?: string; currentToc?: TocNode | null; currentTocError?: string;
  /** Must identify the actual acquisition plane; a fixture/offline run cannot qualify publication. */
  evidenceOrigin?: "ecode360-live" | "offline" | "fixture";
  sampleSize?: number;
  refetch?: (article: TocNode) => Promise<string>;
}
export async function verificationMatchesInputs(report: BoundVerificationReport, root = outputRoot()): Promise<boolean> {
  try {
    const [manifest, toc] = await Promise.all([readFile(join(root, "manifest.json"), "utf8"), readFile(join(root, "toc.json"), "utf8")]);
    if (report.binding.manifestSha256 !== custodyHash(manifest) || report.binding.tocSha256 !== custodyHash(toc)) return false;
    const values = JSON.parse(manifest) as ScrapeManifest;
    const articles = await Promise.all(Object.keys(values.articles).sort().map(async guid => JSON.parse(await readFile(join(root, "articles", `${guid}.json`), "utf8")) as ArticlePage));
    return report.binding.articleSetSha256 === articleSetSha256(articles);
  } catch { return false; }
}
export async function verifyCorpus(options: VerifyCorpusOptions = {}): Promise<BoundVerificationReport> {
  const root = options.root ?? outputRoot();
  const [manifestBytes, tocBytes] = await Promise.all([readFile(join(root, "manifest.json"), "utf8"), readFile(join(root, "toc.json"), "utf8")]);
  const toc = JSON.parse(tocBytes) as TocNode;
  const manifest = JSON.parse(manifestBytes) as ScrapeManifest;
  if (!isTocShapeValid(toc) || !manifest.articles || typeof manifest.articles !== "object" || Array.isArray(manifest.articles)) throw new Error("Invalid TOC or manifest shape");
  const expected = getArticlePages(toc); const expectedGuids = new Set(expected.map(article => article.guid));
  const localErrors: string[] = [];
  if (Object.keys(manifest.articles).some(guid => !expectedGuids.has(guid)) || Object.keys(manifest.articles).length !== expectedGuids.size) localErrors.push("Manifest article membership differs from TOC");
  if (!manifest.completedAt || !Number.isFinite(Date.parse(manifest.completedAt))) localErrors.push("Scrape has no valid completion receipt");
  const articles: ArticlePage[] = []; const results: VerificationResult[] = [];
  for (const article of expected) {
    const sectionGuids = collectDescendantSections(article).map(section => section.guid);
    const checks = { fileExists: false, sha256Match: false, sectionCountMatch: false, expectedSections: sectionGuids.length, foundSections: 0, allSectionsPresent: false, missingSections: [] as string[] };
    let custodyErrors: string[] = [];
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(article.guid)) throw new Error("Unsafe article GUID");
      const value: unknown = JSON.parse(await readFile(join(root, "articles", `${article.guid}.json`), "utf8"));
      checks.fileExists = true;
      custodyErrors = validateArticleCustody(value, sectionGuids, true);
      const data = value as ArticlePage; const entry = manifest.articles[article.guid];
      if (!Array.isArray(data.sections)) throw new Error("Malformed section array");
      checks.foundSections = data.sections.length;
      checks.sha256Match = !!entry && data.guid === article.guid && entry.guid === article.guid && entry.sha256 === data.sha256 && custodyHash(data.rawHtml) === data.sha256;
      checks.sectionCountMatch = !!entry && entry.sectionCount === data.sections.length && data.sections.length === sectionGuids.length;
      const ids = new Set(data.sections.map(section => section.guid));
      checks.missingSections = sectionGuids.filter(guid => !ids.has(guid));
      checks.allSectionsPresent = checks.missingSections.length === 0 && ids.size === data.sections.length && data.sections.length === sectionGuids.length;
      articles.push(data);
    } catch (error) { custodyErrors.push(error instanceof Error ? error.message : String(error)); }
    localErrors.push(...custodyErrors.map(error => `${article.guid}: ${error}`));
    results.push({ guid: article.guid, title: `${article.indexNum}: ${article.title}`, status: checks.fileExists && checks.sha256Match && checks.sectionCountMatch && checks.allSectionsPresent && !custodyErrors.length ? "pass" : "fail", checks });
  }
  if (manifest.articlePageCount !== expected.length || manifest.sectionCount !== getSections(toc).length) localErrors.push("Manifest totals differ from TOC");
  let currentToc: VerificationPlane = options.currentToc === undefined ? "not_attempted" : options.currentToc === null ? "unavailable" : "fail";
  if (options.currentToc && isTocShapeValid(options.currentToc)) currentToc = custodyHash(JSON.stringify(options.currentToc)) === custodyHash(JSON.stringify(toc)) ? "pass" : "fail";
  const selected = [...expected].sort((a, b) => custodyHash(tocBytes + a.guid).localeCompare(custodyHash(tocBytes + b.guid))).slice(0, Math.max(0, Math.floor(options.sampleSize ?? VERIFY_SAMPLE_SIZE)));
  const sample: BoundVerificationReport["sample"] = { attempted: 0, passes: 0, mismatches: 0, failed: 0, selected: selected.map(article => article.guid), results: [] };
  if (options.refetch) for (const article of selected) {
    sample.attempted++;
    try {
      const liveHtml = await options.refetch(article); const saved = articles.find(value => value.guid === article.guid);
      if (!liveHtml.trim() || !saved) throw new Error("Missing live/saved source HTML");
      const match = custodyHash(liveHtml) === saved.sha256;
      if (match) sample.passes++; else sample.mismatches++;
      sample.results.push({ guid: article.guid, status: match ? "pass" : "mismatch" });
    } catch (error) { sample.failed++; sample.results.push({ guid: article.guid, status: "unavailable", error: error instanceof Error ? error.message.split("\n")[0] : "Refetch failed" }); }
  }
  const planes: BoundVerificationReport["planes"] = { local: localErrors.length || results.some(result => result.status === "fail") || !expected.length ? "fail" : "pass", currentToc,
    sample: !options.refetch || !selected.length ? "not_attempted" : sample.mismatches ? "fail" : sample.failed ? "unavailable" : sample.passes === selected.length ? "pass" : "fail" };
  const allPass = Object.values(planes).every(plane => plane === "pass");
  return { schemaVersion: "corpus-verification/v2", verifiedAt: new Date().toISOString(), municipality: toc.tocName,
    overallStatus: allPass ? "pass" : "fail", publicationEligible: allPass && options.evidenceOrigin === "ecode360-live",
    binding: { manifestSha256: custodyHash(manifestBytes), tocSha256: custodyHash(tocBytes), articleSetSha256: articleSetSha256(articles) }, planes,
    evidence: { currentToc: options.evidenceOrigin ?? "offline", sample: options.evidenceOrigin ?? "offline", limitations: ["Live sample checks selected article HTML only; it does not establish all-page currentness", ...(options.currentTocError ? [options.currentTocError] : [])] },
    totalArticles: expected.length, passedArticles: results.filter(result => result.status === "pass").length, failedArticles: results.filter(result => result.status === "fail").length,
    totalExpectedSections: getSections(toc).length, totalFoundSections: results.reduce((sum, result) => sum + result.checks.foundSections, 0), missingSections: results.flatMap(result => result.checks.missingSections), results, sample, localErrors };
}
async function main(): Promise<void> {
  const offline = Bun.argv.includes("--offline"); let currentToc: TocNode | null | undefined; let currentTocError: string | undefined;
  try {
    const page = offline ? null : await newPage();
    if (page) { try { currentToc = await fetchToc(page); } catch (error) { currentToc = null; currentTocError = error instanceof Error ? error.message.split("\n")[0] : "Current TOC unavailable"; } }
    const report = await verifyCorpus({ currentToc, currentTocError, evidenceOrigin: offline ? "offline" : "ecode360-live", ...(page ? { refetch: async (article: TocNode) => {
      await navigateWithCloudflare(page, `https://ecode360.com/${article.guid}`);
      await page.waitForSelector("#codeContent", { timeout: 30_000 });
      return page.evaluate(() => document.querySelector("#codeContent")?.innerHTML ?? "");
    } } : {}) });
    await writeJsonAtomic(paths.verificationReport, report);
    log.info(`Verification local=${report.planes.local} currentToc=${report.planes.currentToc} sample=${report.planes.sample}; publicationEligible=${report.publicationEligible}`);
    if (offline ? report.planes.local !== "pass" : report.overallStatus !== "pass") process.exitCode = 1;
  } finally { await closeBrowser(); }
}
if (import.meta.main) main().catch(error => { log.error("Verification failed", { error: String(error) }); process.exitCode = 1; });

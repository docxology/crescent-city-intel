import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TocNode, ArticlePage, ScrapeManifest } from "../src/types.ts";
import { bindArticleExtraction, custodyHash, captureCorpusEdition, validateArticleCustody } from "../src/corpus_editions.ts";
import { verifyCorpus, verificationMatchesInputs } from "../src/verify.ts";
import { boundedHttpFetch } from "../src/shared/transport.ts";
import { isDeepSectionCheckpointValid, type DeepSectionCheckpoint } from "../src/content.ts";
function node(guid: string, type: TocNode["type"], children: TocNode[] = []): TocNode { return { guid, type, children, prefix: "", tocName: "Code", parent: null, href: "", title: guid, number: "1", indexNum: "1", label: "", hideNumber: false }; }
async function corpus() {
  const root = await mkdtemp(join(tmpdir(), "corpus-custody-")); await mkdir(join(root, "articles"));
  const toc = node("root", "code", [node("a", "article", [node("s", "section")])]);
  const rawHtml = '<div id="s_content" class="section_content content"><p>Retained civic text.</p><div class="history">Adopted 2020</div></div>';
  const article = bindArticleExtraction({ guid: "a", url: "https://ecode360.com/a", title: "a", number: "1", rawHtml, sha256: custodyHash(rawHtml), scrapedAt: "2026-09-30T00:00:00Z", sections: [{ guid: "s", number: "1", title: "s", html: '<p>Retained civic text.</p><div class="history">Adopted 2020</div>', text: "Retained civic text.", history: "Adopted 2020" }] });
  const manifest: ScrapeManifest = { municipality: "Code", municipalityGuid: "root", sourceUrl: "https://ecode360.com/CR4919", version: "", scrapedAt: article.scrapedAt, completedAt: article.scrapedAt, tocNodeCount: 3, articlePageCount: 1, sectionCount: 1, articles: { a: { guid: "a", title: "a", number: "1", sectionCount: 1, sha256: article.sha256, filePath: "articles/a.json" } } };
  for (const [name, value] of Object.entries({ "toc.json": toc, "manifest.json": manifest, "articles/a.json": article })) await writeFile(join(root, name), JSON.stringify(value));
  return { root, toc, article, manifest };
}
describe("corpus proof planes and custody", () => {
  test("a source-marked reserved section may be empty; an ordinary section cannot", () => {
    const rawHtml = '<div id="s_title">§ 1 (Reserved)</div><div id="s_content"><div class="footnotes"></div></div>';
    const article = bindArticleExtraction({ guid: "a", url: "https://ecode360.com/a", title: "a", number: "1", rawHtml, sha256: custodyHash(rawHtml), scrapedAt: "2026-09-30T00:00:00Z", sections: [{ guid: "s", number: "1", title: "(Reserved)", html: '<div class="footnotes"></div>', text: "", history: "" }] });
    expect(validateArticleCustody(article, ["s"], true)).toEqual([]);
    expect(validateArticleCustody(bindArticleExtraction({ ...article, sections: article.sections.map(section => ({ ...section, title: "Ordinary law" })) }), ["s"], true).length).toBeGreaterThan(0);
  });
  test("offline local pass cannot establish publication; actual local refetch tests each outcome", async () => {
    const data = await corpus(); let body = data.article.rawHtml; const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    const refetch = async () => (await boundedHttpFetch(`http://localhost:${server.port}/article`, { allowPrivateHosts: ["localhost"] })).text();
    try {
      const offline = await verifyCorpus({ root: data.root }); expect(offline.planes.local).toBe("pass"); expect(offline.overallStatus).toBe("fail"); expect(offline.publicationEligible).toBe(false);
      const matched = await verifyCorpus({ root: data.root, currentToc: data.toc, refetch, evidenceOrigin: "fixture" }); expect(matched.planes.sample).toBe("pass"); expect(matched.publicationEligible).toBe(false); expect(await verificationMatchesInputs(matched, data.root)).toBe(true);
      body += "changed"; expect((await verifyCorpus({ root: data.root, currentToc: data.toc, refetch })).planes.sample).toBe("fail");
      server.stop(true); expect((await verifyCorpus({ root: data.root, currentToc: data.toc, refetch })).planes.sample).toBe("unavailable");
      const changedToc = structuredClone(data.toc); changedToc.title = "Changed"; expect((await verifyCorpus({ root: data.root, currentToc: changedToc })).planes.currentToc).toBe("fail");
    } finally { server.stop(true); await rm(data.root, { recursive: true, force: true }); }
  });
  test("recomputed hashes cannot hide parsed text corruption or duplicate sections", async () => {
    const data = await corpus();
    try {
      expect(validateArticleCustody(data.article, ["s"], true)).toEqual([]); // Warm the exact successful replay receipt.
      expect(validateArticleCustody(data.article, ["different-current-toc-member"], true).length).toBeGreaterThan(0);
      expect(validateArticleCustody({ ...data.article, rawHtml: data.article.rawHtml + " changed source" }, ["s"], true).length).toBeGreaterThan(0);
      const forged = bindArticleExtraction({ ...data.article, sections: data.article.sections.map(section => ({ ...section, text: "fabricated" })) });
      expect(validateArticleCustody(forged, ["s"], true).join(" ")).toContain("Parsed text differs");
      await writeFile(join(data.root, "articles/a.json"), JSON.stringify(forged)); expect((await verifyCorpus({ root: data.root })).planes.local).toBe("fail");
      expect(validateArticleCustody({ ...data.article, sections: [...data.article.sections, ...data.article.sections] }, ["s"], true).length).toBeGreaterThan(0);
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
  test("edition identities include parsed bytes, reuse is immutable, corruption is rejected", async () => {
    const data = await corpus();
    try {
      const first = await captureCorpusEdition(data.root, "initial"); const receipt = await readFile(join(data.root, "editions", first!, "edition-receipt.json"), "utf8");
      expect(await captureCorpusEdition(data.root, "repeat")).toBe(first); expect(await readFile(join(data.root, "editions", first!, "edition-receipt.json"), "utf8")).toBe(receipt);
      await writeFile(join(data.root, "articles/a.json"), JSON.stringify({ ...data.article, title: "Changed parsed article" })); expect(await captureCorpusEdition(data.root, "changed")).not.toBe(first);
      await writeFile(join(data.root, "articles/a.json"), JSON.stringify(data.article)); await writeFile(join(data.root, "editions", first!, "articles/a.json"), "corrupt"); await expect(captureCorpusEdition(data.root, "tampered")).rejects.toThrow("bytes differ");
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
  test("deep-page custody requires retained full fetched fragment and selector replay", () => {
    const section: ArticlePage["sections"][number] = { guid: "s", number: "1", title: "s", html: "<p>Deep content.</p>", text: "Deep content.", history: "" };
    const article: ArticlePage = { guid: "a", url: "https://ecode360.com/a", title: "a", number: "1", rawHtml: "<div>section links</div>", sha256: custodyHash("<div>section links</div>"), scrapedAt: "2026-09-30T00:00:00Z", sections: [section] };
    expect(validateArticleCustody(bindArticleExtraction(article, "section-pages"), ["s"], true).length).toBeGreaterThan(0);
    const html = '<h2>Source page heading</h2><div class="section_content content"><p>Deep content.</p></div>';
    const bound = bindArticleExtraction(article, "section-pages", [{ guid: "s", url: "https://ecode360.com/s", html, sha256: custodyHash(html) }]);
    expect(validateArticleCustody(bound, ["s"], true)).toEqual([]);
  });
  test("HTML5 processing-instruction serialization replays without accepting changed table content", () => {
    const html = '<?set-paper type="land" ?><table><tbody><tr><td>Retained cell</td></tr></tbody></table>';
    const rawHtml = `<div id="s_content" class="section_content content">${html}</div>`;
    const article = bindArticleExtraction({ guid: "a", title: "a", number: "1", url: "https://ecode360.com/a", rawHtml, sha256: custodyHash(rawHtml), scrapedAt: "2026-09-30T00:00:00Z", sections: [{ guid: "s", title: "s", number: "1", html, text: "Retained cell", history: "" }] });
    expect(validateArticleCustody(article, ["s"], true)).toEqual([]);
    expect(validateArticleCustody(bindArticleExtraction({ ...article, sections: [{ ...article.sections[0], html: html.replace("Retained cell", "Changed cell"), text: "Changed cell" }] }), ["s"], true).join(" ")).toContain("Source fragment mismatch");
  });
  test("partial deep checkpoints bind source bytes, TOC metadata and age without becoming complete articles", () => {
    const toc = node("a", "article", [node("s", "section"), node("missing", "section")]);
    const rawHtml = "<div>section links</div>"; const sourceHtml = '<div class="section_content content"><p>Deep content.</p></div>';
    const article = bindArticleExtraction({ guid: "a", title: "a", number: "1", url: "https://ecode360.com/a", rawHtml, sha256: custodyHash(rawHtml), scrapedAt: "2026-09-30T00:00:00Z", sections: [{ guid: "s", title: "s", number: "1", html: "<p>Deep content.</p>", text: "Deep content.", history: "" }] }, "section-pages", [{ guid: "s", url: "https://ecode360.com/s", html: sourceHtml, sha256: custodyHash(sourceHtml) }]);
    const checkpoint: DeepSectionCheckpoint = { schemaVersion: "deep-sections/v1", createdAt: article.scrapedAt, savedAt: article.scrapedAt, expectedSectionsSha256: custodyHash(JSON.stringify([{ guid: "s", number: "1", title: "s" }, { guid: "missing", number: "1", title: "missing" }])), article };
    const now = Date.parse("2026-09-30T01:00:00Z");
    expect(isDeepSectionCheckpointValid(checkpoint, toc, rawHtml, now)).toBe(true);
    expect(validateArticleCustody(article, ["s", "missing"], true).length).toBeGreaterThan(0);
    expect(isDeepSectionCheckpointValid(checkpoint, toc, rawHtml + "changed", now)).toBe(false);
    expect(isDeepSectionCheckpointValid(checkpoint, toc, rawHtml, now + 86_400_000)).toBe(false);
    expect(isDeepSectionCheckpointValid({ ...checkpoint, article: bindArticleExtraction({ ...article, sections: [{ ...article.sections[0], text: "Invented" }] }, "section-pages", article.extraction.sourceFragments) }, toc, rawHtml, now)).toBe(false);
    expect(isDeepSectionCheckpointValid({ ...checkpoint, article: bindArticleExtraction({ ...article, sections: [{ ...article.sections[0], title: "Changed heading" }] }, "section-pages", article.extraction.sourceFragments) }, toc, rawHtml, now)).toBe(false);
  });
});

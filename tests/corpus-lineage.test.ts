import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindArticleExtraction, custodyHash, captureCorpusEdition } from "../src/corpus_editions.ts";
import { buildCorpusLineage, buildCorpusLineageWithCustody, readLineageEdition, reviewRetainedProposedDocument, type PrimaryOrdinanceInput, type RetainedLineageEdition } from "../src/corpus_lineage.ts";
import { documentPageSpans, type MeetingDocumentReceipt } from "../src/meeting_documents.ts";
import { captureArtifactBytes, validateArtifactCustody, replayArtifactCustody } from "../src/artifact_custody.ts";
import type { TocNode } from "../src/types.ts";
const stamp = "2026-09-30T00:00:00Z";
const bytes = (text: string) => new TextEncoder().encode(text);
const sectionNode = (guid: string, number: string, title: string, children: TocNode[] = [], type: TocNode["type"] = "section"): TocNode => ({ guid, number, title, children, type, prefix: "", tocName: "Code", parent: null, href: `/${guid}`, indexNum: number, label: title, hideNumber: false });
async function edition(rows: Array<{ guid: string; number: string; title: string; text: string }>): Promise<{ root: string; value: RetainedLineageEdition }> {
  const root = await mkdtemp(join(tmpdir(), "cci-lineage-")); await mkdir(join(root, "articles"));
  const sections = rows.map(row => ({ ...row, html: `<p>${row.text}</p>`, history: "" }));
  const rawHtml = sections.map(row => `<h3 id="${row.guid}_title">${row.title}</h3><div id="${row.guid}_content">${row.html}</div>`).join("");
  const article = bindArticleExtraction({ guid: "a", number: "1", title: "Article", url: "https://ecode360.com/a", scrapedAt: stamp, rawHtml, sha256: custodyHash(rawHtml), sections });
  const toc = sectionNode("root", "", "Code", [sectionNode("a", "1", "Article", rows.map(row => sectionNode(row.guid, row.number, row.title)), "article")], "code");
  await writeFile(join(root, "toc.json"), JSON.stringify(toc));
  await writeFile(join(root, "articles/a.json"), JSON.stringify(article));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ municipality: "Code", municipalityGuid: "root", sourceUrl: "https://ecode360.com/CR4919", version: "fixture", scrapedAt: stamp, completedAt: stamp, tocNodeCount: rows.length + 2, articlePageCount: 1, sectionCount: rows.length, articles: { a: { guid: "a", title: "Article", number: "1", sectionCount: rows.length, sha256: article.sha256, filePath: "articles/a.json" } } }));
  const id = await captureCorpusEdition(root, "retained fixture source");
  return { root, value: await readLineageEdition(join(root, "editions", id!)) };
}
test("asymmetric lineage preserves addition/removal identities and keeps renumbering pending", async () => {
  const old = await edition([{ guid: "same", number: "1.1", title: "Old heading", text: "Same body" }, { guid: "retired", number: "1.2", title: "Retired", text: "Retained unique text" }, { guid: "removed", number: "1.3", title: "Removed", text: "Old independent text" }]);
  const next = await edition([{ guid: "same", number: "2.1", title: "New heading", text: "Changed body" }, { guid: "replacement", number: "2.2", title: "Replacement", text: "Retained unique text" }, { guid: "new", number: "2.3", title: "Addition", text: "New independent text" }]);
  try {
    const first = buildCorpusLineage(old.value, next.value, [], stamp), repeated = buildCorpusLineage(old.value, next.value, [], stamp);
    expect(repeated).toEqual(first);
    expect(first.candidates.filter(row => row.kind === "removed").map(row => row.before!.guid).sort()).toEqual(["removed", "retired"]);
    expect(first.candidates.filter(row => row.kind === "added").map(row => row.after!.guid).sort()).toEqual(["new", "replacement"]);
    expect(first.candidates.find(row => row.kind === "identity-candidate")?.before?.guid).toBe("retired");
    expect(first.candidates.find(row => row.kind === "identity-candidate")?.after?.guid).toBe("replacement");
    expect(first.candidates.filter(row => row.before?.guid === "same").map(row => row.kind)).toEqual(["renumbered", "retitled", "modified"]);
    expect(first.candidates.every(row => row.reviewStatus === "pending" && row.legalConclusion === null)).toBe(true);
    expect(buildCorpusLineage(old.value, old.value, [], stamp).count).toBe(0);
    const transforms = { "src/corpus_lineage.ts": await captureArtifactBytes(join(process.cwd(), "src/corpus_lineage.ts")), "src/corpus_editions.ts": await captureArtifactBytes(join(process.cwd(), "src/corpus_editions.ts")) };
    const bound = buildCorpusLineageWithCustody(old.value, next.value, [], transforms, stamp);
    const inputs: Record<string, Uint8Array> = { "before/edition-receipt.json": old.value.receiptBytes, "after/edition-receipt.json": next.value.receiptBytes };
    for (const [prefix, input] of [["before", old.value], ["after", next.value]] as const) for (const [name, data] of Object.entries(input.files)) inputs[`${prefix}/${name}`] = data;
    const evidence = { inputs, transforms, configuration: { generatedAt: stamp, ordinances: [] } };
    expect(validateArtifactCustody(bound.receipt, bound.bytes, evidence)).toEqual([]);
    expect(await replayArtifactCustody(bound.receipt, bound.bytes, evidence, () => bytes(`${JSON.stringify(buildCorpusLineage(old.value, next.value, [], stamp), null, 2)}\n`))).toEqual([]);
    const editionId = JSON.parse(new TextDecoder().decode(old.value.receiptBytes)).editionId;
    const lengths = Object.keys(old.value.files).sort().map(name => old.value.files[name]!.byteLength);
    const firstTwoLimit = lengths[0]! + lengths[1]!;
    await expect(readLineageEdition(join(old.root, "editions", editionId), { maxBytes: firstTwoLimit })).rejects.toThrow("aggregate byte bound");
    await expect(readLineageEdition(join(old.root, "editions", editionId), { maxBytes: Infinity })).rejects.toThrow("byte bound");
    const corrupted = structuredClone(old.value); corrupted.files["articles/a.json"] = bytes("{}");
    expect(() => buildCorpusLineage(corrupted, next.value, [], stamp)).toThrow("bytes mismatch");
  } finally { await rm(old.root, { recursive: true, force: true }); await rm(next.root, { recursive: true, force: true }); }
});
test("primary ordinance dates require exact reviewed source evidence and source changes reopen review", async () => {
  const retained = await edition([{ guid: "s", number: "1", title: "Section", text: "Actual retained body" }]);
  const document = bytes("Ordinance 100. Adopted 2020-01-10; effective 2020-02-10.");
  const input: PrimaryOrdinanceInput = { documentId: "ord-100", documentKind: "ordinance", sourceUrl: "https://example.test/ordinances/100", bytes: document, mediaType: "text/plain", adoptionDate: "2020-01-10", effectiveDate: "2020-02-10", reviewStatus: "reviewed", reviewedAt: stamp, reviewOwner: "ordinance-editor", evidenceSpan: "Adopted 2020-01-10; effective 2020-02-10.", reviewedDocumentSha256: custodyHash(document) };
  try {
    const artifact = buildCorpusLineage(retained.value, retained.value, [input], stamp);
    expect(artifact.ordinances[0]!.effectiveDate).toBe("2020-02-10");
    const changed = buildCorpusLineage(retained.value, retained.value, [{ ...input, bytes: bytes("Ordinance 100 source changed") }], stamp).ordinances[0]!;
    expect(changed.reviewStatus).toBe("pending"); expect(changed.sourceChanged).toBe(true); expect(changed.adoptionDate).toBeNull(); expect(changed.effectiveDate).toBeNull();
    expect(() => buildCorpusLineage(retained.value, retained.value, [{ ...input, reviewStatus: "pending" }], stamp)).toThrow("null");
    expect(() => buildCorpusLineage(retained.value, retained.value, [{ ...input, adoptionDate: "2020-02-30" }], stamp)).toThrow("Reviewed");
    expect(() => buildCorpusLineage(retained.value, retained.value, [{ ...input, evidenceSpan: "Absent primary evidence" }], stamp)).toThrow("span absent");
    const unknown = { ...input, adoptionDate: null, effectiveDate: null, reviewStatus: "pending" as const, reviewedAt: null, reviewOwner: null, evidenceSpan: null, reviewedDocumentSha256: undefined };
    expect(buildCorpusLineage(retained.value, retained.value, [unknown], stamp).ordinances[0]!.effectiveDate).toBeNull();
  } finally { await rm(retained.root, { recursive: true, force: true }); }
});
test("rebinding a forged parsed section cannot bypass retained raw HTML/TOC replay", async () => {
  const retained = await edition([{ guid: "s", number: "1", title: "Section", text: "Actual retained body" }]);
  try {
    const forged = structuredClone(retained.value), article = JSON.parse(new TextDecoder().decode(forged.files["articles/a.json"]));
    article.sections[0].text = "Invented legal body";
    forged.files["articles/a.json"] = bytes(JSON.stringify(bindArticleExtraction(article)));
    const receipt = JSON.parse(new TextDecoder().decode(forged.receiptBytes)); receipt.files["articles/a.json"] = custodyHash(forged.files["articles/a.json"]!); receipt.editionId = custodyHash(JSON.stringify(receipt.files)); forged.receiptBytes = bytes(JSON.stringify(receipt));
    expect(() => buildCorpusLineage(forged, retained.value, [], stamp)).toThrow("parsed/source custody");
  } finally { await rm(retained.root, { recursive: true, force: true }); }
});
test("proposed primary evidence binds exact PDF/text/page bytes and never adopts a historical date", () => {
  const raw = bytes("%PDF-1.7\nSynthetic primary custody fixture\n%%EOF\n");
  const native = "Originally Adopted February 3, 2020\nAmended September 25, 2026 [Proposed, Not Yet Adopted]\fDetails\f";
  const spans = documentPageSpans(native);
  const receipt: MeetingDocumentReceipt = { schemaVersion: "official-meeting-pdf/v1", source: { title: "Proposal fixture", source: "Official fixture", meetingDate: "", url: "https://example.test/proposal.pdf" }, captureId: crypto.randomUUID(), receiptFile: "fixture.json", fetchedAt: stamp, rawSha256: custodyHash(raw), rawBytes: raw.length, rawFile: "raw/fixture.pdf", extractor: { name: "pdftotext", version: "synthetic fixture text, not native acceptance", layout: true, ocrAttempted: false }, textSha256: custodyHash(spans.text), ...spans, limitations: ["Synthetic byte-binding fixture only"] };
  const excerpt = "Amended September 25, 2026 [Proposed, Not Yet Adopted]";
  const review = reviewRetainedProposedDocument(receipt, raw, native, excerpt, stamp);
  expect(review.adoptionDate).toBeNull(); expect(review.effectiveDate).toBeNull(); expect(review.independentlyReviewed).toBe(false);
  for (const mutate of [(r: MeetingDocumentReceipt) => r.rawSha256 = "0".repeat(64), (r: MeetingDocumentReceipt) => r.textSha256 = "0".repeat(64), (r: MeetingDocumentReceipt) => r.pages[0]!.start++, (r: MeetingDocumentReceipt) => r.source.url = "http://127.0.0.2/proposal.pdf"]) {
    const copy = structuredClone(receipt); mutate(copy); expect(() => reviewRetainedProposedDocument(copy, raw, native, excerpt, stamp)).toThrow();
  }
  expect(() => reviewRetainedProposedDocument(receipt, raw, native + "changed", excerpt, stamp)).toThrow("replay");
  expect(() => reviewRetainedProposedDocument(receipt, raw, native, "Originally Adopted February 3, 2020", stamp)).toThrow("Proposed-not-adopted");
});

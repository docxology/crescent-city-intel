/** Retained edition comparison: source identities and review candidates, never inferred legal dates. */
import { join } from "node:path";
import { validateArticleCustody, custodyHash, type BoundArticle } from "./corpus_editions.js";
import { getArticlePages } from "./toc.js";
import { collectDescendantSections } from "./verify.js";
import { isTocShapeValid } from "./scraper_utils.js";
import { assertArtifact } from "./artifact_contracts.js";
import { createArtifactCustody, captureArtifactBytes, canonicalArtifactJson, type ArtifactCustodyReceipt } from "./artifact_custody.js";
import { isCivilDate, isStrictTimestamp, isPublicCitationUrl, validateSchema } from "./schema_validation.js";
import type { ScrapeManifest, TocNode } from "./types.js";
import { documentPageSpans, type MeetingDocumentReceipt } from "./meeting_documents.js";

export const CORPUS_LINEAGE_SCHEMA = "crescent-city-corpus-lineage/v1";
export const LINEAGE_TRANSFORM_VERSION = "retained-section-lineage/v1";
export interface RetainedLineageEdition { receiptBytes: Uint8Array; files: Record<string, Uint8Array> }
export interface LineageSection { articleGuid: string; guid: string; number: string; title: string; textSha256: string; historySha256: string }
export interface LineageCandidate { id: string; kind: "added" | "removed" | "renumbered" | "retitled" | "modified" | "identity-candidate"; before: LineageSection | null; after: LineageSection | null; suggestedAfterGuids: string[]; reviewStatus: "pending"; legalConclusion: null }
export interface PrimaryOrdinanceInput {
  documentId: string; documentKind: "ordinance" | "meeting-record" | "policy-proposal"; sourceUrl: string; bytes: Uint8Array; mediaType: "application/pdf" | "text/html" | "text/plain";
  /** Reviewed dates must cite a literal retained text span; PDF text extraction is separately reviewed. */
  adoptionDate: string | null; effectiveDate: string | null; reviewStatus: "pending" | "reviewed" | "rejected"; reviewedAt: string | null; reviewOwner: string | null; evidenceSpan: string | null;
  /** Prior reviewed source digest; a changed document invalidates prior legal-date assertions. */
  reviewedDocumentSha256?: string;
  /** For PDF, separately retained extraction bytes, bound by the derived receipt. */
  extractedText?: Uint8Array;
}
export interface CorpusLineage {
  schemaVersion: typeof CORPUS_LINEAGE_SCHEMA; generatedAt: string; beforeEditionId: string; afterEditionId: string; inputFingerprint: string; transformVersion: typeof LINEAGE_TRANSFORM_VERSION; count: number; candidates: LineageCandidate[];
  ordinances: Array<Omit<PrimaryOrdinanceInput, "bytes" | "reviewedDocumentSha256" | "extractedText"> & { documentSha256: string; bytes: number; sourceChanged: boolean }>;
  limitations: string[];
}
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const fileName = /^(?:manifest\.json|toc\.json|verification-report\.json|crescent-city-code\.json|articles\/[A-Za-z0-9_-]+\.json)$/;

function validatedEdition(edition: RetainedLineageEdition): { id: string; sections: Map<string, LineageSection> } {
  if (edition.receiptBytes.length > 2 * 1024 * 1024 || Object.keys(edition.files).length > 5000 || Object.values(edition.files).reduce((sum, bytes) => sum + bytes.length, 0) > 128 * 1024 * 1024) throw new Error("Lineage edition exceeds bounds");
  const receipt = JSON.parse(decode(edition.receiptBytes)) as Record<string, any>;
  const schema = { type: "object", required: ["schemaVersion", "editionId", "capturedAt", "reason", "validation", "files"], additionalProperties: false, properties: { schemaVersion: { enum: ["corpus-edition/v1"] }, editionId: { type: "string", pattern: "^[a-f0-9]{64}$" }, capturedAt: { type: "string", format: "date-time" }, reason: { type: "string" }, validation: { enum: ["not-established"] }, files: { type: "object", minProperties: 2, maxProperties: 5000, additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" } } } };
  if (validateSchema(receipt, schema).length || Object.keys(receipt.files).some(name => !fileName.test(name))) throw new Error("Invalid retained edition receipt");
  const names = Object.keys(receipt.files).sort();
  if (names.join("\0") !== Object.keys(edition.files).sort().join("\0") || names.some(name => custodyHash(edition.files[name]!) !== receipt.files[name])) throw new Error("Retained edition input membership or bytes mismatch");
  if (custodyHash(JSON.stringify(Object.fromEntries(names.map(name => [name, receipt.files[name]])))) !== receipt.editionId) throw new Error("Retained edition identity mismatch");
  if (!edition.files["manifest.json"] || !edition.files["toc.json"]) throw new Error("Retained edition lacks manifest/TOC");
  const manifest = JSON.parse(decode(edition.files["manifest.json"])) as ScrapeManifest;
  const toc = JSON.parse(decode(edition.files["toc.json"])) as TocNode;
  if (!isTocShapeValid(toc) || !manifest.articles || typeof manifest.articles !== "object" || Array.isArray(manifest.articles)) throw new Error("Retained edition has invalid manifest/TOC");
  const nodes = getArticlePages(toc), guids = nodes.map(node => node.guid).sort();
  if (guids.join("\0") !== Object.keys(manifest.articles).sort().join("\0") || names.filter(name => name.startsWith("articles/")).map(name => name.slice(9, -5)).join("\0") !== guids.join("\0")) throw new Error("Retained edition article membership differs from TOC");
  const sections = new Map<string, LineageSection>();
  for (const node of nodes) {
    const article = JSON.parse(decode(edition.files[`articles/${node.guid}.json`]!)) as BoundArticle;
    const expectedSections = new Map(collectDescendantSections(node).map(section => [section.guid, section]));
    if (validateArticleCustody(article, collectDescendantSections(node).map(section => section.guid), true).length || article.guid !== node.guid || manifest.articles[node.guid]?.sha256 !== article.sha256 || manifest.articles[node.guid]?.sectionCount !== article.sections.length) throw new Error("Retained edition parsed/source custody failed");
    for (const section of article.sections) {
      if (expectedSections.get(section.guid)?.number !== section.number || expectedSections.get(section.guid)?.title !== section.title) throw new Error("Retained section heading/number differs from bound TOC");
      if (sections.has(section.guid)) throw new Error("Retained edition has duplicate section identities");
      sections.set(section.guid, { articleGuid: article.guid, guid: section.guid, number: section.number, title: section.title, textSha256: custodyHash(section.text), historySha256: custodyHash(section.history) });
    }
  }
  if (manifest.sectionCount !== sections.size || manifest.articlePageCount !== nodes.length) throw new Error("Retained edition counts do not match sections");
  return { id: receipt.editionId, sections };
}
/** Read only receipt-declared files; validate custody before exposing semantic comparison inputs. */
export async function readLineageEdition(directory: string, options: { maxBytes?: number } = {}): Promise<RetainedLineageEdition> {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw new Error("Invalid lineage edition byte bound");
  const receiptBytes = await captureArtifactBytes(join(directory, "edition-receipt.json"), 2 * 1024 * 1024);
  const receipt = JSON.parse(decode(receiptBytes)) as { files?: Record<string, unknown> };
  if (!receipt.files || Array.isArray(receipt.files) || Object.keys(receipt.files).length > 5000 || Object.keys(receipt.files).some(name => !fileName.test(name))) throw new Error("Invalid retained edition file roster");
  const files: Record<string, Uint8Array> = {};
  let used = 0;
  for (const name of Object.keys(receipt.files).sort()) {
    if (used >= maxBytes) throw new Error("Lineage edition aggregate byte bound exhausted");
    files[name] = await captureArtifactBytes(join(directory, name), Math.min(64 * 1024 * 1024, maxBytes - used));
    used += files[name]!.byteLength;
  }
  const edition = { receiptBytes, files }; validatedEdition(edition); return edition;
}
/** Read-only current core capture; no edition directory or real output file is created. */
export async function captureCurrentLineageEdition(root: string, capturedAt = new Date().toISOString()): Promise<RetainedLineageEdition> {
  if (!isStrictTimestamp(capturedAt)) throw new Error("Invalid lineage capture time");
  const files: Record<string, Uint8Array> = {}; let used = 0;
  const capture = async (name: string): Promise<void> => {
    const remaining = 128 * 1024 * 1024 - used;
    if (remaining <= 0) throw new Error("Current lineage aggregate byte bound exhausted");
    files[name] = await captureArtifactBytes(join(root, name), Math.min(64 * 1024 * 1024, remaining));
    used += files[name]!.byteLength;
  };
  for (const name of ["manifest.json", "toc.json"]) await capture(name);
  const manifest = JSON.parse(decode(files["manifest.json"]!)) as ScrapeManifest;
  if (!manifest.articles || typeof manifest.articles !== "object" || Array.isArray(manifest.articles)) throw new Error("Current lineage capture has invalid manifest");
  for (const guid of Object.keys(manifest.articles).sort()) {
    if (!/^[A-Za-z0-9_-]+$/.test(guid)) throw new Error("Current lineage capture has unsafe article identity");
    await capture(`articles/${guid}.json`);
  }
  for (const name of ["verification-report.json", "crescent-city-code.json"]) {
    try { await capture(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const name of ["manifest.json", "toc.json"]) if (custodyHash(await captureArtifactBytes(join(root, name))) !== custodyHash(files[name]!)) throw new Error("Current lineage manifest/TOC changed during capture");
  const hashes = Object.fromEntries(Object.keys(files).sort().map(name => [name, custodyHash(files[name]!)]));
  const receiptBytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: "corpus-edition/v1", editionId: custodyHash(JSON.stringify(hashes)), capturedAt, reason: "Read-only native current-core lineage capture", validation: "not-established", files: hashes }));
  const result = { receiptBytes, files }; validatedEdition(result); return result;
}
function ordinanceEvidence(input: PrimaryOrdinanceInput): CorpusLineage["ordinances"][number] {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.documentId) || !isPublicCitationUrl(input.sourceUrl) || input.bytes.length === 0 || input.bytes.length > 32 * 1024 * 1024) throw new Error("Invalid primary ordinance source input");
  if (!["application/pdf", "text/html", "text/plain"].includes(input.mediaType) || input.mediaType === "application/pdf" && !decode(input.bytes.slice(0, 5)).startsWith("%PDF-")) throw new Error("Invalid primary ordinance media type");
  const documentSha256 = custodyHash(input.bytes), sourceChanged = input.reviewedDocumentSha256 !== undefined && input.reviewedDocumentSha256 !== documentSha256;
  if (input.reviewedDocumentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.reviewedDocumentSha256)) throw new Error("Invalid reviewed ordinance document hash");
  let { adoptionDate, effectiveDate, reviewStatus, reviewedAt, reviewOwner, evidenceSpan } = input;
  if (!["ordinance", "meeting-record", "policy-proposal"].includes(input.documentKind) || input.documentKind !== "ordinance" && (adoptionDate !== null || effectiveDate !== null)) throw new Error("Non-ordinance documents cannot supply ordinance legal dates");
  if (sourceChanged) { adoptionDate = null; effectiveDate = null; reviewStatus = "pending"; reviewedAt = null; reviewOwner = null; evidenceSpan = null; }
  if (reviewStatus === "reviewed") {
    if (input.reviewedDocumentSha256 !== documentSha256 || !reviewedAt || !isStrictTimestamp(reviewedAt) || !reviewOwner?.trim() || !evidenceSpan?.trim() || [adoptionDate, effectiveDate].some(value => value !== null && !isCivilDate(value))) throw new Error("Reviewed ordinance dates require exact document binding and explicit reviewer/span evidence");
    const retainedText = input.mediaType === "application/pdf" ? input.extractedText : input.bytes;
    if (!retainedText || retainedText.length > 16 * 1024 * 1024 || !decode(retainedText).includes(evidenceSpan)) throw new Error("Reviewed ordinance span absent from retained primary text");
  } else if (adoptionDate !== null || effectiveDate !== null) throw new Error("Unreviewed ordinance legal dates must remain null");
  return { documentId: input.documentId, documentKind: input.documentKind, sourceUrl: input.sourceUrl, documentSha256, bytes: input.bytes.length, mediaType: input.mediaType, adoptionDate, effectiveDate, reviewStatus, reviewedAt, reviewOwner, evidenceSpan, sourceChanged };
}
export function buildCorpusLineage(beforeInput: RetainedLineageEdition, afterInput: RetainedLineageEdition, ordinances: PrimaryOrdinanceInput[] = [], generatedAt = new Date().toISOString()): CorpusLineage {
  const before = validatedEdition(beforeInput), after = validatedEdition(afterInput), candidates: LineageCandidate[] = [];
  const add = (kind: LineageCandidate["kind"], old: LineageSection | null, next: LineageSection | null, suggestedAfterGuids: string[] = []): void => {
    candidates.push({ id: custodyHash(canonicalArtifactJson({ before: before.id, after: after.id, kind, old, next, suggestedAfterGuids })), kind, before: old, after: next, suggestedAfterGuids, reviewStatus: "pending", legalConclusion: null });
  };
  const added = [...after.sections.values()].filter(row => !before.sections.has(row.guid));
  for (const row of [...before.sections.values()].sort((a, b) => a.guid.localeCompare(b.guid))) {
    const next = after.sections.get(row.guid);
    if (!next) {
      const matches = added.filter(candidate => candidate.textSha256 === row.textSha256 && candidate.historySha256 === row.historySha256).map(candidate => candidate.guid).sort();
      add("removed", row, null, matches);
      if (matches.length === 1) add("identity-candidate", row, after.sections.get(matches[0]!)!);
    } else {
      if (row.number !== next.number) add("renumbered", row, next);
      if (row.title !== next.title) add("retitled", row, next);
      if (row.textSha256 !== next.textSha256 || row.historySha256 !== next.historySha256) add("modified", row, next);
    }
  }
  for (const row of added.sort((a, b) => a.guid.localeCompare(b.guid))) add("added", null, row);
  const ordinanceRows = ordinances.map(ordinanceEvidence).sort((a, b) => a.documentId.localeCompare(b.documentId));
  const result: CorpusLineage = { schemaVersion: CORPUS_LINEAGE_SCHEMA, generatedAt, beforeEditionId: before.id, afterEditionId: after.id, inputFingerprint: custodyHash(canonicalArtifactJson({ before: before.id, after: after.id, ordinances: ordinanceRows })), transformVersion: LINEAGE_TRANSFORM_VERSION, count: candidates.length, candidates, ordinances: ordinanceRows, limitations: ["Retained editions establish local byte/source extraction custody, not current upstream validity.", "Addition/removal describes edition membership; absence never establishes repeal.", "Cross-GUID text equality is a candidate for review, not proven legal continuity.", "Legal dates remain null until explicit document-bound review; literal span presence does not prove legal entailment."] };
  assertArtifact("corpus-lineage", result); return result;
}
/** Caller passes the actual transformer/schema bytes, not an asserted version string alone. */
export function buildCorpusLineageWithCustody(before: RetainedLineageEdition, after: RetainedLineageEdition, ordinances: PrimaryOrdinanceInput[], transforms: Record<string, Uint8Array>, generatedAt: string): { artifact: CorpusLineage; bytes: Uint8Array; receipt: ArtifactCustodyReceipt } {
  const artifact = buildCorpusLineage(before, after, ordinances, generatedAt), bytes = new TextEncoder().encode(`${JSON.stringify(artifact, null, 2)}\n`);
  const inputs: Record<string, Uint8Array> = { "before/edition-receipt.json": before.receiptBytes, "after/edition-receipt.json": after.receiptBytes };
  for (const [prefix, edition] of [["before", before], ["after", after]] as const) for (const [name, value] of Object.entries(edition.files)) inputs[`${prefix}/${name}`] = value;
  for (const document of ordinances) { inputs[`ordinances/${document.documentId}/source`] = document.bytes; if (document.extractedText) inputs[`ordinances/${document.documentId}/text`] = document.extractedText; }
  const configuration = { generatedAt, ordinances: ordinances.map(({ bytes: _, extractedText: __, ...metadata }) => metadata) };
  return { artifact, bytes, receipt: createArtifactCustody("corpus-lineage", bytes, { inputs, transforms, configuration }, generatedAt) };
}

/** Actual retained PDF negative acceptance: bind native replay and exact page/span, with no inferred ordinance dates. */
export function reviewRetainedProposedDocument(receipt: MeetingDocumentReceipt, rawBytes: Uint8Array, nativeText: string, excerpt: string, reviewedAt: string): Record<string, unknown> {
  if (receipt.schemaVersion !== "official-meeting-pdf/v1" || !isPublicCitationUrl(receipt.source.url) || !isStrictTimestamp(receipt.fetchedAt) || !isStrictTimestamp(reviewedAt) || rawBytes.length !== receipt.rawBytes || custodyHash(rawBytes) !== receipt.rawSha256 || !decode(rawBytes.slice(0, 5)).startsWith("%PDF-")) throw new Error("Primary PDF receipt is not bound to retained bytes");
  const replay = documentPageSpans(nativeText);
  if (custodyHash(receipt.text) !== receipt.textSha256 || replay.text !== receipt.text || canonicalArtifactJson(replay.pages) !== canonicalArtifactJson(receipt.pages)) throw new Error("Primary PDF native text/page replay mismatch");
  const page = receipt.pages.find(row => row.text.includes(excerpt));
  if (!page || !/proposed,?\s+not yet adopted/i.test(excerpt)) throw new Error("Proposed-not-adopted evidence absent from retained page");
  return { schemaVersion: "crescent-city-primary-agent-review/v1", sourceUrl: receipt.source.url, documentKind: "policy-proposal", rawSha256: receipt.rawSha256, rawBytes: receipt.rawBytes, textSha256: receipt.textSha256, pageCount: receipt.pages.length, excerpt: { page: page.page, pageTextSha256: page.textSha256, start: page.start + page.text.indexOf(excerpt), end: page.start + page.text.indexOf(excerpt) + excerpt.length, text: excerpt }, status: "proposed-not-adopted", adoptionDate: null, effectiveDate: null, reviewedAt, reviewMethod: "agent-review-with-native-extraction-replay", independentlyReviewed: false, limitations: ["This is an agent extraction review, not a human legal review or proof of document authority beyond its recorded source.", "The proposal does not establish adoption or effectivity; earlier historical adoption language is not promoted into a current ordinance date.", "Literal span presence and byte/page replay do not establish legal entailment or present legal force."] };
}

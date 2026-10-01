/** Local directory correction ownership and per-field evidence; never infers currency from generation. */
import { createHash } from "node:crypto";
import { buildDirectoryArtifact, type DirectoryArtifact, type DirectoryEntry } from "./directory.js";
import { assertArtifact } from "./artifact_contracts.js";
import { canonicalArtifactJson } from "./artifact_custody.js";
import { isStrictTimestamp, isPublicCitationUrl, validateSchema } from "./schema_validation.js";

export const DIRECTORY_REVIEW_SCHEMA = "crescent-city-directory-review/v1";
export const DIRECTORY_FIELDS = ["name", "category", "address", "phone", "website", "description"] as const;
export type DirectoryField = (typeof DIRECTORY_FIELDS)[number];
export interface DirectoryFieldReview {
  sourceUrl: string; sourceSha256: string | null; consultedAt: string | null; reviewedAt: string | null;
  status: "unreviewed" | "reviewed" | "disputed";
}
export interface DirectoryReviewLedger {
  schemaVersion: typeof DIRECTORY_REVIEW_SCHEMA;
  artifactSha256: string;
  entries: Record<string, Record<DirectoryField, DirectoryFieldReview>>;
  /** A role, not a personal identity; local decisions retain their own owner receipt. */
  correctionOwner: "directory-editor";
  corrections: DirectoryCorrection[];
}
export interface DirectoryCorrection {
  id: string; entryIdentity: string; field: DirectoryField; previous: string | null; proposed: string | null;
  sourceUrl: string; sourceSha256: string; evidenceSpan: string; submittedAt: string;
  status: "pending" | "accepted" | "rejected";
  owner: "directory-editor"; reviewedAt: string | null;
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const directoryEntryIdentity = (entry: Pick<DirectoryEntry, "name" | "category">): string => hash(canonicalArtifactJson({ category: entry.category, name: entry.name.toLocaleLowerCase() }));
const artifactHash = (artifact: DirectoryArtifact) => hash(canonicalArtifactJson(artifact));
const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
const text = { type: "string", minLength: 1, maxLength: 4096 }, digest = { type: "string", pattern: "^[a-f0-9]{64}$" }, time = { type: "string", format: "date-time" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const fieldSchema = object({ sourceUrl: { type: "string", format: "public-url" }, sourceSha256: nullable(digest), consultedAt: nullable(time), reviewedAt: nullable(time), status: { enum: ["unreviewed", "reviewed", "disputed"] } });
const correctionSchema = object({ id: digest, entryIdentity: digest, field: { enum: [...DIRECTORY_FIELDS] }, previous: nullable(text), proposed: nullable(text), sourceUrl: { type: "string", format: "public-url" }, sourceSha256: digest, evidenceSpan: text, submittedAt: time, status: { enum: ["pending", "accepted", "rejected"] }, owner: { enum: ["directory-editor"] }, reviewedAt: nullable(time) });
const ledgerSchema = object({ schemaVersion: { enum: [DIRECTORY_REVIEW_SCHEMA] }, artifactSha256: digest, correctionOwner: { enum: ["directory-editor"] }, entries: { type: "object", maxProperties: 10_000, propertyNames: digest, additionalProperties: object(Object.fromEntries(DIRECTORY_FIELDS.map(field => [field, fieldSchema]))) }, corrections: { type: "array", maxItems: 1000, items: correctionSchema } });
/** All existing fields begin unreviewed; a seed citation alone is not field verification. */
export function createDirectoryReviewLedger(artifact: DirectoryArtifact): DirectoryReviewLedger {
  assertArtifact("directory", artifact);
  return { schemaVersion: DIRECTORY_REVIEW_SCHEMA, artifactSha256: artifactHash(artifact), correctionOwner: "directory-editor", entries: Object.fromEntries(artifact.entries.map(entry => [directoryEntryIdentity(entry), Object.fromEntries(DIRECTORY_FIELDS.map(field => [field, { sourceUrl: entry.source, sourceSha256: null, consultedAt: null, reviewedAt: null, status: "unreviewed" }])) as Record<DirectoryField, DirectoryFieldReview>])), corrections: [] };
}
function assertLedger(artifact: DirectoryArtifact, ledger: DirectoryReviewLedger): void {
  assertArtifact("directory", artifact);
  if (validateSchema(ledger, ledgerSchema).length) throw new Error("Invalid directory review ledger shape");
  if (ledger.schemaVersion !== DIRECTORY_REVIEW_SCHEMA || ledger.artifactSha256 !== artifactHash(artifact) || ledger.correctionOwner !== "directory-editor" || Object.keys(ledger.entries).sort().join("\0") !== artifact.entries.map(directoryEntryIdentity).sort().join("\0") || ledger.corrections.length > 1000) throw new Error("Directory review ledger is not bound to this artifact");
  for (const fields of Object.values(ledger.entries)) for (const field of DIRECTORY_FIELDS) {
    const row = fields[field];
    if (!row || !isPublicCitationUrl(row.sourceUrl) || !["unreviewed", "reviewed", "disputed"].includes(row.status) || row.sourceSha256 !== null && !/^[a-f0-9]{64}$/.test(row.sourceSha256) || [row.consultedAt, row.reviewedAt].some(value => value !== null && !isStrictTimestamp(value)) || row.status === "reviewed" && (!row.sourceSha256 || !row.reviewedAt || !row.consultedAt)) throw new Error("Invalid directory field review evidence");
  }
  if (new Set(ledger.corrections.map(row => row.id)).size !== ledger.corrections.length) throw new Error("Duplicate directory correction identities");
  for (const row of ledger.corrections) {
    const expected = hash(canonicalArtifactJson({ entryIdentity: row.entryIdentity, field: row.field, previous: row.previous, proposed: row.proposed, sourceUrl: row.sourceUrl, sourceSha256: row.sourceSha256, evidenceSpan: row.evidenceSpan }));
    if (row.id !== expected || row.status === "pending" && row.reviewedAt !== null || row.status !== "pending" && (row.reviewedAt === null || Date.parse(row.reviewedAt) < Date.parse(row.submittedAt))) throw new Error("Directory correction receipt binding mismatch");
  }
}
/** A disputed field becomes visible in the ledger; proposing never silently edits the seed. */
export function proposeDirectoryCorrection(artifact: DirectoryArtifact, ledger: DirectoryReviewLedger, input: { entryIdentity: string; field: DirectoryField; proposed: string | null; sourceUrl: string; sourceBytes: Uint8Array; evidenceSpan: string; submittedAt: string }): DirectoryReviewLedger {
  assertLedger(artifact, ledger);
  const entry = artifact.entries.find(row => directoryEntryIdentity(row) === input.entryIdentity);
  if (!entry || !DIRECTORY_FIELDS.includes(input.field) || input.proposed !== null && (typeof input.proposed !== "string" || !input.proposed.trim() || input.proposed.trim() !== input.proposed || input.proposed.length > 4096) || !isPublicCitationUrl(input.sourceUrl) || input.sourceBytes.length === 0 || input.sourceBytes.length > 4 * 1024 * 1024 || !input.evidenceSpan.trim() || input.evidenceSpan.length > 4096 || !new TextDecoder("utf-8", { fatal: true }).decode(input.sourceBytes).includes(input.evidenceSpan) || !isStrictTimestamp(input.submittedAt)) throw new Error("Invalid directory correction source evidence");
  const sourceSha256 = hash(input.sourceBytes), previous = entry[input.field];
  const id = hash(canonicalArtifactJson({ entryIdentity: input.entryIdentity, field: input.field, previous, proposed: input.proposed, sourceUrl: input.sourceUrl, sourceSha256, evidenceSpan: input.evidenceSpan }));
  if (ledger.corrections.some(row => row.id === id)) return structuredClone(ledger);
  const next = structuredClone(ledger);
  next.corrections.push({ id, entryIdentity: input.entryIdentity, field: input.field, previous, proposed: input.proposed, sourceUrl: input.sourceUrl, sourceSha256, evidenceSpan: input.evidenceSpan, submittedAt: input.submittedAt, status: "pending", owner: "directory-editor", reviewedAt: null });
  next.entries[input.entryIdentity]![input.field].status = "disputed";
  return next;
}
/** Explicit owner decision; changed retained sources invalidate the proposed correction. */
export function decideDirectoryCorrection(artifact: DirectoryArtifact, ledger: DirectoryReviewLedger, correctionId: string, decision: { owner: "directory-editor"; status: "accepted" | "rejected"; reviewedAt: string; sourceBytes: Uint8Array }): { artifact: DirectoryArtifact; ledger: DirectoryReviewLedger } {
  assertLedger(artifact, ledger);
  const next = structuredClone(ledger), correction = next.corrections.find(row => row.id === correctionId);
  if (!correction || correction.status !== "pending" || decision.owner !== correction.owner || !isStrictTimestamp(decision.reviewedAt) || Date.parse(decision.reviewedAt) < Date.parse(correction.submittedAt) || hash(decision.sourceBytes) !== correction.sourceSha256) throw new Error("Directory correction decision is not bound to pending source evidence");
  correction.status = decision.status; correction.reviewedAt = decision.reviewedAt;
  const changed = structuredClone(artifact), entry = changed.entries.find(row => directoryEntryIdentity(row) === correction.entryIdentity)!;
  if (!entry || entry[correction.field] !== correction.previous) throw new Error("Directory correction requires a new review after entry change");
  if (decision.status === "accepted") (entry as unknown as Record<string, unknown>)[correction.field] = correction.proposed;
  if (correction.field === "website" && correction.proposed !== null && !isPublicCitationUrl(correction.proposed)) throw new Error("Directory correction has an invalid public website");
  const result = buildDirectoryArtifact(artifact.generatedAt, changed);
  if (!result) throw new Error("Directory correction leaves no usable artifact");
  assertArtifact("directory", result);
  const currentIdentity = directoryEntryIdentity(entry);
  if (currentIdentity !== correction.entryIdentity) { next.entries[currentIdentity] = next.entries[correction.entryIdentity]!; delete next.entries[correction.entryIdentity]; }
  next.entries[currentIdentity]![correction.field] = { sourceUrl: correction.sourceUrl, sourceSha256: correction.sourceSha256, consultedAt: correction.submittedAt, reviewedAt: decision.reviewedAt, status: decision.status === "accepted" ? "reviewed" : "unreviewed" };
  next.artifactSha256 = artifactHash(result);
  return { artifact: result, ledger: next };
}

/** Retained source changes reopen field review; fetch time never becomes a review time. */
export function reassessDirectoryFieldSource(artifact: DirectoryArtifact, ledger: DirectoryReviewLedger, entryIdentity: string, field: DirectoryField, sourceBytes: Uint8Array, consultedAt: string): DirectoryReviewLedger {
  assertLedger(artifact, ledger);
  if (!ledger.entries[entryIdentity]?.[field] || !DIRECTORY_FIELDS.includes(field) || !isStrictTimestamp(consultedAt) || sourceBytes.length === 0 || sourceBytes.length > 4 * 1024 * 1024) throw new Error("Invalid directory source reassessment");
  const next = structuredClone(ledger), row = next.entries[entryIdentity]![field], sourceSha256 = hash(sourceBytes);
  row.consultedAt = consultedAt;
  if (row.sourceSha256 !== sourceSha256) { row.sourceSha256 = sourceSha256; row.reviewedAt = null; row.status = "disputed"; }
  return next;
}
export function directoryReviewQueue(artifact: DirectoryArtifact, ledger: DirectoryReviewLedger): Array<{ entryIdentity: string; field: DirectoryField; status: DirectoryFieldReview["status"]; owner: "directory-editor" }> {
  assertLedger(artifact, ledger);
  return Object.keys(ledger.entries).sort().flatMap(entryIdentity => DIRECTORY_FIELDS.filter(field => ledger.entries[entryIdentity]![field].status !== "reviewed").map(field => ({ entryIdentity, field, status: ledger.entries[entryIdentity]![field].status, owner: ledger.correctionOwner })));
}

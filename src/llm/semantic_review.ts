/** Supplied semantic annotations bind exact claim/context bytes; identity is not authenticated. */
import { isIP } from "node:net";
import { isPublicAddress, redactUrl } from "../shared/transport.js";

export interface ReviewSourceInput { id: string; text: string; url: string | null; observedAt: string | null; dependsOn: string[] }
export interface ReviewClaimInput { id: string; start: number; end: number; sourceIds: string[] }
export interface SemanticReviewInput { id: string; asOf: string; answer: string; claims: ReviewClaimInput[]; sources: ReviewSourceInput[]; maximumSourceAgeDays: number }
export interface SemanticReviewPackage extends SemanticReviewInput {
  schemaVersion: "crescent-city-semantic-review/v1"; fingerprint: string; answerSha256: string;
  claims: Array<ReviewClaimInput & { text: string; sha256: string }>;
  sources: Array<ReviewSourceInput & { sha256: string; observationStatus: "fresh" | "stale" | "unknown" }>;
  semanticSupport: "unassessed"; sourceIndependence: "unassessed"; legalCurrency: "unassessed";
}
export type AnnotatedSupport = "supported" | "partial" | "unsupported" | "contradicted";
export interface SemanticAnnotations {
  schemaVersion: "crescent-city-semantic-annotations/v1"; packageFingerprint: string;
  reviewerLabel: string; reviewedAt: string;
  claims: Array<{ claimId: string; claimSha256: string; judgement: AnnotatedSupport; reason: string;
    evidence: Array<{ sourceId: string; sourceSha256: string; start: number; end: number }> }>;
}
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).sort().join() === allowed.sort().join();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function range(start: unknown, end: unknown, length: number): boolean { return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 0 && Number(end) > Number(start) && Number(end) <= length; }
function safeSourceUrl(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2000) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname !== "localhost" && url.hostname.includes(".") && !/(?:^localhost$|\.(?:localhost|local|internal|lan|test|invalid|example))$/i.test(url.hostname) && (!isIP(url.hostname.replace(/^\[|\]$/g, "")) || isPublicAddress(url.hostname.replace(/^\[|\]$/g, ""))) && redactUrl(url.href) === url.href; } catch { return false; }
}

/** Caller supplies claim ranges and full retained context; no model creates a review verdict. */
export function buildSemanticReviewPackage(input: SemanticReviewInput): SemanticReviewPackage {
  if (!object(input) || !keys(input as unknown as Record<string, unknown>, ["id", "asOf", "answer", "claims", "sources", "maximumSourceAgeDays"]) || !id(input.id) || !date(input.asOf) || typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 200_000 || !Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 100 || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 64 || !Number.isSafeInteger(input.maximumSourceAgeDays) || input.maximumSourceAgeDays < 1 || input.maximumSourceAgeDays > 3650) throw new Error("Invalid semantic review input");
  const sourceIds = new Set<string>(), claimIds = new Set<string>(); let sourceBytes = 0;
  for (const source of input.sources) {
    if (!object(source) || !keys(source as unknown as Record<string, unknown>, ["id", "text", "url", "observedAt", "dependsOn"]) || !id(source.id) || sourceIds.has(source.id) || typeof source.text !== "string" || !source.text.trim() || source.text.length > 200_000 || !safeSourceUrl(source.url) || (source.observedAt !== null && (!date(source.observedAt) || Date.parse(source.observedAt) > Date.parse(input.asOf))) || !Array.isArray(source.dependsOn) || source.dependsOn.length > 64 || !source.dependsOn.every(id) || new Set(source.dependsOn).size !== source.dependsOn.length) throw new Error("Invalid semantic review source");
    sourceIds.add(source.id); sourceBytes += Buffer.byteLength(source.text, "utf8");
  }
  if (sourceBytes > 2_000_000) throw new Error("Semantic review context exceeds its byte limit");
  const byId = new Map(input.sources.map(source => [source.id, source]));
  const completed = new Set<string>();
  const visit = (sourceId: string, trail: Set<string>) => {
    if (trail.has(sourceId)) throw new Error("Semantic review dependency cycle");
    if (completed.has(sourceId)) return;
    const source = byId.get(sourceId); if (!source) throw new Error("Semantic review dependency is missing");
    const next = new Set([...trail, sourceId]); for (const dependency of source.dependsOn) visit(dependency, next);
    completed.add(sourceId);
  };
  for (const source of input.sources) visit(source.id, new Set());
  for (const claim of input.claims) {
    if (!object(claim) || !keys(claim as unknown as Record<string, unknown>, ["id", "start", "end", "sourceIds"]) || !id(claim.id) || claimIds.has(claim.id) || !range(claim.start, claim.end, input.answer.length) || !Array.isArray(claim.sourceIds) || claim.sourceIds.length > 64 || !claim.sourceIds.every(sourceId => sourceIds.has(sourceId)) || new Set(claim.sourceIds).size !== claim.sourceIds.length || !input.answer.slice(claim.start, claim.end).trim()) throw new Error("Invalid semantic review claim");
    claimIds.add(claim.id);
  }
  const body = { ...input, schemaVersion: "crescent-city-semantic-review/v1" as const, answerSha256: hash(input.answer),
    claims: input.claims.map(claim => ({ ...claim, sourceIds: [...claim.sourceIds], text: input.answer.slice(claim.start, claim.end), sha256: hash(input.answer.slice(claim.start, claim.end)) })),
    sources: input.sources.map(source => ({ ...source, dependsOn: [...source.dependsOn], sha256: hash(source.text), observationStatus: source.observedAt === null ? "unknown" as const : Date.parse(input.asOf) - Date.parse(source.observedAt) > input.maximumSourceAgeDays * 86_400_000 ? "stale" as const : "fresh" as const })),
    semanticSupport: "unassessed" as const, sourceIndependence: "unassessed" as const, legalCurrency: "unassessed" as const };
  return { ...body, fingerprint: hash(canonical(body)) };
}

export function validateSemanticReviewPackage(value: unknown): SemanticReviewPackage {
  if (!object(value) || value.schemaVersion !== "crescent-city-semantic-review/v1" || !Array.isArray(value.claims) || !Array.isArray(value.sources)) throw new Error("Invalid semantic review package");
  const input = { id: value.id, asOf: value.asOf, answer: value.answer, maximumSourceAgeDays: value.maximumSourceAgeDays,
    claims: value.claims.map(row => { if (!object(row)) throw new Error("Invalid review claim"); return { id: row.id, start: row.start, end: row.end, sourceIds: row.sourceIds }; }),
    sources: value.sources.map(row => { if (!object(row)) throw new Error("Invalid review source"); return { id: row.id, text: row.text, url: row.url, observedAt: row.observedAt, dependsOn: row.dependsOn }; }) };
  const rebuilt = buildSemanticReviewPackage(input as SemanticReviewInput);
  if (canonical(rebuilt) !== canonical(value)) throw new Error("Semantic review package content or fingerprint changed");
  return rebuilt;
}

/** An imported label is an annotation, never proof of reviewer identity or factuality. */
export function assessSemanticAnnotations(packageValue: unknown, annotationValue?: unknown, options: { asOf?: string } = {}) {
  const assessmentClock = options.asOf ?? new Date().toISOString();
  if (!date(assessmentClock)) throw new Error("Invalid semantic assessment clock");
  const bundle = validateSemanticReviewPackage(packageValue);
  const annotated = new Map<string, SemanticAnnotations["claims"][number]>();
  let reviewerLabel: string | null = null, reviewedAt: string | null = null;
  if (annotationValue !== undefined) {
    if (!object(annotationValue) || !keys(annotationValue, ["schemaVersion", "packageFingerprint", "reviewerLabel", "reviewedAt", "claims"]) || annotationValue.schemaVersion !== "crescent-city-semantic-annotations/v1" || annotationValue.packageFingerprint !== bundle.fingerprint || typeof annotationValue.reviewerLabel !== "string" || !annotationValue.reviewerLabel.trim() || annotationValue.reviewerLabel.length > 200 || !date(annotationValue.reviewedAt) || Date.parse(annotationValue.reviewedAt as string) < Date.parse(bundle.asOf) || Date.parse(annotationValue.reviewedAt as string) > Date.parse(assessmentClock) || !Array.isArray(annotationValue.claims) || annotationValue.claims.length > bundle.claims.length) throw new Error("Invalid or stale semantic annotations");
    const sources = new Map(bundle.sources.map(source => [source.id, source]));
    for (const row of annotationValue.claims) {
      if (!object(row) || !keys(row, ["claimId", "claimSha256", "judgement", "reason", "evidence"]) || typeof row.claimId !== "string" || annotated.has(row.claimId) || !["supported", "partial", "unsupported", "contradicted"].includes(String(row.judgement)) || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 4000 || !Array.isArray(row.evidence) || row.evidence.length > 64) throw new Error("Invalid semantic claim annotation");
      const claim = bundle.claims.find(claim => claim.id === row.claimId);
      if (!claim || row.claimSha256 !== claim.sha256 || ((row.judgement === "supported" || row.judgement === "partial" || row.judgement === "contradicted") && !row.evidence.length)) throw new Error("Semantic annotation lacks matching claim evidence");
      for (const span of row.evidence) {
        if (!object(span) || !keys(span, ["sourceId", "sourceSha256", "start", "end"]) || typeof span.sourceId !== "string") throw new Error("Invalid semantic evidence span");
        const source = sources.get(span.sourceId);
        if (!source || !claim.sourceIds.includes(source.id) || span.sourceSha256 !== source.sha256 || !range(span.start, span.end, source.text.length)) throw new Error("Semantic evidence span does not bind its retained context");
      }
      annotated.set(claim.id, row as unknown as SemanticAnnotations["claims"][number]);
    }
    reviewerLabel = annotationValue.reviewerLabel; reviewedAt = annotationValue.reviewedAt;
  }
  return { schemaVersion: "crescent-city-semantic-assessment/v1", packageFingerprint: bundle.fingerprint,
    workflowStatus: annotated.size === bundle.claims.length ? "annotations-supplied" : annotated.size ? "partially-annotated" : "pending-review",
    reviewerLabel, reviewedAt, reviewerIdentityVerified: false, verifiedFactuality: false, sourceIndependence: "unassessed", legalCurrency: "unassessed",
    claims: bundle.claims.map(claim => ({ claimId: claim.id, claimSha256: claim.sha256, semanticSupport: annotated.get(claim.id)?.judgement ?? "unassessed", annotation: annotated.get(claim.id) ?? null,
      observationWarnings: claim.sourceIds.filter(id => bundle.sources.find(source => source.id === id)?.observationStatus !== "fresh"),
      declaredDependentSources: claim.sourceIds.filter(id => bundle.sources.find(source => source.id === id)?.dependsOn.length) })),
    limitation: "Supplied annotations are bound to exact claim and retained context bytes. This does not authenticate the reviewer, verify source independence or legal currency, or establish general factual correctness." };
}

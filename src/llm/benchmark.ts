/** Reproducible bounded retrieval/citation diagnostics, never a factuality certificate. */
import { readFile } from "node:fs/promises";
import { llmConfig } from "./config.js";
import { paths } from "../shared/paths.js";
import { indexConfigSignature } from "./index_plan.js";
import { retrieveRagContext, ragQuery } from "./rag.js";
import { boundedSignal } from "./runtime.js";
import type { RagSource } from "../types.js";
import type { EvidenceAssessment } from "./evidence.js";

export interface RagBenchmarkCase { id: string; question: string; expectedSectionGuids: string[]; expectedDisposition: "generated-unverified" | "abstained" }
export interface RagBenchmarkSuite { schemaVersion: "crescent-city-rag-cases/v1"; cases: RagBenchmarkCase[] }
export interface RagBenchmarkObservation { sources: readonly RagSource[]; evidence?: EvidenceAssessment; contextFingerprint?: string; collection?: string }
export function scoreRagBenchmarkCase(testCase: RagBenchmarkCase, observed: RagBenchmarkObservation) {
  const retrievedSectionGuids = [...new Set(observed.sources.filter(source => source.sourceType === "municipal_code").map(source => source.sectionGuid))];
  const expectedFound = testCase.expectedSectionGuids.filter(guid => retrievedSectionGuids.includes(guid));
  return { id: testCase.id, expectedSectionGuids: testCase.expectedSectionGuids, retrievedSectionGuids, expectedFound,
    retrievalHitAny: testCase.expectedSectionGuids.length ? expectedFound.length > 0 : null,
    recallOfListedIds: testCase.expectedSectionGuids.length ? expectedFound.length / testCase.expectedSectionGuids.length : null,
    expectedDisposition: testCase.expectedDisposition, actualDisposition: observed.evidence?.disposition ?? "not-generated",
    dispositionMatches: observed.evidence ? observed.evidence.disposition === testCase.expectedDisposition : null,
    citationStatus: observed.evidence?.citationStatus ?? "not-generated", citedSections: observed.evidence?.citedSections ?? [], unknownSections: observed.evidence?.unknownSections ?? [],
    contextFingerprint: observed.contextFingerprint ?? null, collection: observed.collection ?? null,
    verifiedSupport: false as const, semanticEntailment: "not-evaluated" as const };
}
export function validateRagBenchmarkSuite(value: unknown): RagBenchmarkSuite {
  if (!value || typeof value !== "object" || (value as RagBenchmarkSuite).schemaVersion !== "crescent-city-rag-cases/v1" || !Array.isArray((value as RagBenchmarkSuite).cases)) throw new Error("Invalid benchmark suite");
  const suite = value as RagBenchmarkSuite, ids = new Set<string>();
  if (suite.cases.length < 1 || suite.cases.length > 100) throw new Error("Benchmark requires 1 to 100 cases");
  for (const row of suite.cases) {
    if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) || ids.has(row.id) || typeof row.question !== "string" || !row.question.trim() || row.question.length > 10_000 || !Array.isArray(row.expectedSectionGuids) || row.expectedSectionGuids.length > 50 || !row.expectedSectionGuids.every(guid => typeof guid === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(guid)) || !["generated-unverified", "abstained"].includes(row.expectedDisposition)) throw new Error("Invalid benchmark case");
    ids.add(row.id);
  }
  return suite;
}
export async function evaluateRagBenchmark(options: { suite: RagBenchmarkSuite; generate?: boolean; signal?: AbortSignal; deadlineMs?: number; onCase?: (id: string) => void } ) {
  const suite = validateRagBenchmarkSuite(options.suite), deadlineMs = options.deadlineMs ?? 900_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_600_000) throw new Error("Benchmark deadline must be 1 to 3600000 ms");
  const signal = boundedSignal(options.signal, deadlineMs), started = Date.now();
  const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  const [manifest, indexReceipt] = await Promise.all([read(paths.manifest), read(paths.indexManifest)]);
  let index: Record<string, unknown> = {}; try { index = indexReceipt ? JSON.parse(indexReceipt) : {}; } catch { /* surfaced in identity */ }
  const results: Array<ReturnType<typeof scoreRagBenchmarkCase> & { error?: "retrieval-or-provider-unavailable" }> = [];
  for (const testCase of suite.cases) {
    signal.throwIfAborted(); options.onCase?.(testCase.id);
    try {
      if (options.generate) {
        const answer = await ragQuery(testCase.question, undefined, undefined, { signal });
        results.push(scoreRagBenchmarkCase(testCase, { sources: answer.sources, evidence: answer.evidence, contextFingerprint: answer.metadata?.contextFingerprint, collection: answer.metadata?.collection }));
      } else {
        const retrieved = await retrieveRagContext(testCase.question, { signal });
        results.push(scoreRagBenchmarkCase(testCase, retrieved));
      }
    } catch { signal.throwIfAborted(); results.push({ ...scoreRagBenchmarkCase(testCase, { sources: [] }), error: "retrieval-or-provider-unavailable" }); }
  }
  const [after, corpusAfter] = await Promise.all([read(paths.indexManifest), read(paths.manifest)]);
  const applicable = results.filter(row => row.retrievalHitAny !== null);
  return { schemaVersion: "crescent-city-rag-benchmark/v1", generatedAt: new Date().toISOString(), durationMs: Date.now() - started,
    identity: { casesSha256: hash(JSON.stringify(suite)), corpusManifestSha256: manifest ? hash(manifest) : null, indexManifestSha256: indexReceipt ? hash(indexReceipt) : null, indexFingerprint: typeof index.fingerprint === "string" ? index.fingerprint : null, servingCollection: typeof index.servingCollection === "string" ? index.servingCollection : llmConfig.collectionName, configSignature: indexConfigSignature(llmConfig), embeddingModel: llmConfig.embeddingModel, chatProvider: llmConfig.provider, chatModel: llmConfig.provider === "openrouter" ? llmConfig.openrouterModel : llmConfig.chatModel, stableIndexReceipt: after === indexReceipt, stableCorpusReceipt: corpusAfter === manifest },
    generatedAnswers: options.generate === true, cases: results,
    diagnostics: { cases: results.length, retrievalApplicable: applicable.length, retrievalHitAny: applicable.filter(row => row.retrievalHitAny).length, dispositionMatches: results.filter(row => row.dispositionMatches === true).length, errors: results.filter(row => row.error).length },
    verifiedFactuality: false, limitation: "Measures retrieval of listed section IDs and citation/abstention behavior on a small versioned case set. It does not assess semantic entailment, source independence, legal currency, or general factual accuracy." };
}

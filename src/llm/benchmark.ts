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

/** Local retained-context replay isolates generation from retrieval quality. */
export interface ContextReplayCase { id: string; category: string; question: string; input: import("./semantic_review.js").SemanticReviewInput; expectedDisposition: "generated-unverified" | "abstained"; explanation: string }
export async function evaluateContextReplay(value: unknown, options: { signal?: AbortSignal; deadlineMs?: number; onCase?: (id: string) => void } = {}) {
  const { buildSemanticReviewPackage, assessSemanticAnnotations } = await import("./semantic_review.js");
  const { chatWithProvider, configuredChatModel, configuredChatProvider } = await import("./provider.js");
  const { RAG_SYSTEM_PROMPT } = await import("./rag.js");
  const { assessAnswerEvidence, evaluateLiteralSpan } = await import("./evidence.js");
  const { withProviderBudget } = await import("./openrouter.js");
  const suite = value as { schemaVersion: string; fixtureKind: string; cases: ContextReplayCase[] };
  if (!suite || typeof suite !== "object" || Object.keys(suite).sort().join() !== "cases,fixtureKind,schemaVersion" || suite.schemaVersion !== "crescent-city-semantic-cases/v1" || suite.fixtureKind !== "synthetic-diagnostics-not-human-review" || !Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > 100) throw new Error("Invalid retained-context replay suite");
  const ids = new Set<string>();
  for (const row of suite.cases) {
    if (!row || Object.keys(row).sort().join() !== "category,expectedDisposition,explanation,id,input,question" || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) || ids.has(row.id) || typeof row.category !== "string" || row.category.length > 100 || typeof row.question !== "string" || !row.question.trim() || row.question.length > 10_000 || typeof row.explanation !== "string" || row.explanation.length > 2000 || !["generated-unverified", "abstained"].includes(row.expectedDisposition)) throw new Error("Invalid retained-context replay case");
    buildSemanticReviewPackage(row.input); ids.add(row.id);
  }
  const deadlineMs = options.deadlineMs ?? 900_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_600_000) throw new Error("Invalid retained-context replay deadline");
  const signal = boundedSignal(options.signal, deadlineMs), started = Date.now();
  const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const configuration = { provider: configuredChatProvider(), model: configuredChatModel(), request: llmConfig.provider === "openrouter" ? { max_tokens: llmConfig.openrouterMaxTokens } : { stream: false }, samplingParameters: "not-set-by-client; backend defaults not captured" };
  const clientSourceSha256 = Object.fromEntries(await Promise.all(["benchmark.ts", "provider.ts", "ollama.ts", "openrouter.ts", "rag.ts", "evidence.ts", "semantic_review.ts"].map(async name => [name, hash(await readFile(new URL(name, import.meta.url), "utf8"))])));
  const results = await withProviderBudget(async () => {
    const rows = [];
    for (const row of suite.cases) {
      signal.throwIfAborted(); options.onCase?.(row.id);
      const context = row.input.sources.map(source => `[§ 8.04.010] Synthetic retained source ${source.id}; observedAt=${source.observedAt ?? "unknown"}; declared dependencies=${source.dependsOn.join(",") || "none declared"}\n${source.text}`).join("\n\n");
      try {
        const answer = await chatWithProvider([{role:"user",content:row.question}], context, undefined, {signal, systemPrompt:RAG_SYSTEM_PROMPT});
        signal.throwIfAborted();
        const sources: RagSource[] = row.input.sources.map(source => ({sourceType:"municipal_code",sectionGuid:source.id,sectionNumber:"8.04.010",sectionTitle:"Synthetic retained diagnostic source",snippet:source.text.slice(0,200),score:1}));
        const evidence = assessAnswerEvidence(answer,sources);
        const reviewPackage = answer.trim() ? buildSemanticReviewPackage({...row.input,answer,claims:[{id:"generated-answer",start:0,end:answer.length,sourceIds:row.input.sources.map(source=>source.id)}]}) : null;
        rows.push({id:row.id,category:row.category,questionSha256:hash(row.question),contextSha256:hash(context),answer,answerSha256:hash(answer),expectedDisposition:row.expectedDisposition,actualDisposition:evidence.disposition,dispositionMatches:evidence.disposition===row.expectedDisposition,evidence,literalDiagnostics:row.input.sources.map(source=>({sourceId:source.id,...evaluateLiteralSpan(answer,source.text)})),reviewPackage,assessment:reviewPackage ? assessSemanticAnnotations(reviewPackage) : null});
      } catch { signal.throwIfAborted(); rows.push({id:row.id,category:row.category,error:"provider-unavailable"}); }
    }
    return rows;
  });
  return {schemaVersion:"crescent-city-context-replay/v1",generatedAt:new Date().toISOString(),durationMs:Date.now()-started,identity:{suiteSha256:hash(JSON.stringify(suite)),systemPromptSha256:hash(RAG_SYSTEM_PROMPT),provider:configuration.provider,model:configuration.model,generationConfiguration:configuration,clientSourceSha256,modelArtifactDigest:"not-captured",stableClientConfiguration:configuration.provider===configuredChatProvider()&&configuration.model===configuredChatModel()&&(configuration.provider!=="openrouter"||("max_tokens" in configuration.request&&configuration.request.max_tokens===llmConfig.openrouterMaxTokens)),fixtureKind:suite.fixtureKind},results,verifiedFactuality:false,semanticSupport:"unassessed",sourceIndependence:"unassessed",legalCurrency:"unassessed",limitation:"Actual provider generation over synthetic retained contexts. Citation identity and literal overlap are diagnostics; semantic support requires separately supplied byte-bound annotations, and reviewer identity is not authenticated. This does not measure full-corpus retrieval quality; backend sampling defaults and model artifact bytes are not captured."};
}

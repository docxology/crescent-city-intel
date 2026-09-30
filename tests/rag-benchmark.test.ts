import { expect, test } from "bun:test";
import { validateRagBenchmarkSuite, scoreRagBenchmarkCase, evaluateRagBenchmark } from "../src/llm/benchmark.ts";
import { assessAnswerEvidence } from "../src/llm/evidence.ts";
import { llmConfig } from "../src/llm/config.ts";
import { indexSections } from "../src/llm/embeddings.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";
import type { RagSource } from "../src/types.ts";

test("versioned representative IDs and adversarial cases preserve factuality limits", async () => {
  const fixture = await Bun.file("tests/fixtures/rag-benchmark-v1.json").json();
  const suite = validateRagBenchmarkSuite(fixture);
  expect(suite.cases.length).toBe(8);
  const seed = await Bun.file("pages-data/crescent-city-code.json").json();
  const guids = new Set(seed.articles.flatMap((article: { sections: Array<{ guid: string }> }) => article.sections.map(section => section.guid)));
  for (const row of suite.cases) for (const guid of row.expectedSectionGuids) expect(guids.has(guid)).toBe(true);
  for (const row of fixture.adversarial) {
    const source: RagSource = { sourceType: "municipal_code", sectionGuid: "s1", sectionNumber: row.sourceNumber, sectionTitle: "Rates", snippet: row.sourceText, score: 1 };
    const evidence = assessAnswerEvidence(row.answer, [source]); expect(evidence.citationStatus).toBe(row.expectedCitationStatus); expect(evidence.verifiedSupport).toBe(false);
    expect(scoreRagBenchmarkCase({ id: row.id, question: "question", expectedSectionGuids: ["s1"], expectedDisposition: "generated-unverified" }, { sources: [source], evidence }).semanticEntailment).toBe("not-evaluated");
  }
});
test("executable evaluator reports actual HTTP retrieval and corpus/config identity", async () => {
  const http = llmHttpFixture(), previous = { ...llmConfig }; Object.assign(llmConfig, { ollamaUrl: http.url, chromaUrl: http.url });
  try { await withEmptyCorpus(async () => {
    await indexSections([{ guid: "s1", number: "8.04.010", title: "Rates", text: "Rates apply.", history: "", articleGuid: "a1", articleTitle: "Rates", articleNumber: "8.04" }]);
    const report = await evaluateRagBenchmark({ suite: { schemaVersion: "crescent-city-rag-cases/v1", cases: [{ id: "rates", question: "rates", expectedSectionGuids: ["s1"], expectedDisposition: "generated-unverified" }] }, generate: true });
    expect(report.diagnostics).toMatchObject({ cases: 1, retrievalHitAny: 1, dispositionMatches: 1, errors: 0 });
    expect(report.identity.indexManifestSha256).toMatch(/^[a-f0-9]{64}$/); expect(report.identity.stableIndexReceipt).toBe(true); expect(report.identity.stableCorpusReceipt).toBe(true);
    expect(report.cases[0]!.collection).toBe(report.identity.servingCollection);
    expect(report.verifiedFactuality).toBe(false); expect(report.cases[0]!.verifiedSupport).toBe(false);
  }); } finally { Object.assign(llmConfig, previous); http.server.stop(true); }
});

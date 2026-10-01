import { test, expect } from "bun:test";
import fixture from "./fixtures/semantic-review-v1.json";
import { buildSemanticReviewPackage, validateSemanticReviewPackage, assessSemanticAnnotations, type SemanticReviewInput, type SemanticAnnotations } from "../src/llm/semantic_review.ts";
import { assessAnswerEvidence } from "../src/llm/evidence.ts";
const cases = fixture.cases;
const build = (index = 0) => buildSemanticReviewPackage(cases[index]!.input as SemanticReviewInput);
function annotation(bundle = build(), judgement: SemanticAnnotations["claims"][number]["judgement"] = "contradicted"): SemanticAnnotations {
  return { schemaVersion: "crescent-city-semantic-annotations/v1", packageFingerprint: bundle.fingerprint, reviewerLabel: "Synthetic test annotation; not a human review", reviewedAt: "2026-09-30T00:00:00Z", claims: [{ claimId: "claim", claimSha256: bundle.claims[0]!.sha256, judgement, reason: "Fixture diagnostic only", evidence: [{ sourceId: "primary", sourceSha256: bundle.sources[0]!.sha256, start: 0, end: bundle.sources[0]!.text.length }] }] };
}
test("versioned diagnostic corpus covers negation, stale/poisoned/dependent sources and useful/abstained answers without inventing review", () => {
  expect(new Set(cases.map(row => row.category))).toEqual(new Set(["useful-answer", "negation", "quantity", "scope", "staleness", "poisoning", "dependence", "quote-vs-support", "citation-vs-support", "unsupported"]));
  for (const row of cases) {
    const bundle = buildSemanticReviewPackage(row.input as SemanticReviewInput), result = assessSemanticAnnotations(bundle);
    expect(result.workflowStatus).toBe("pending-review"); expect(result.verifiedFactuality).toBe(false); expect(result.reviewerIdentityVerified).toBe(false);
    expect(result.claims[0]!.semanticSupport).toBe("unassessed"); expect(validateSemanticReviewPackage(bundle).fingerprint).toBe(bundle.fingerprint);
  }
  expect(assessSemanticAnnotations(build(6)).claims[0]!.observationWarnings).toEqual(["primary"]);
  expect(assessSemanticAnnotations(build(7)).claims[0]!.observationWarnings).toEqual(["primary"]);
  expect(assessSemanticAnnotations(build(9)).claims[0]!.declaredDependentSources).toEqual(["copy"]);
});
test("known citations can coexist with contradiction; useful answers and abstentions remain separate outcomes", () => {
  for (const row of cases) {
    const answer = row.id === "unknown-citation" ? row.input.answer : row.expectedDisposition === "abstained" ? row.input.answer : `${row.input.answer} [§ 8.04.010]`;
    const assessed = assessAnswerEvidence(answer, [{ sectionNumber: "8.04.010", sectionGuid: "primary", sectionTitle: "Fixture", snippet: row.input.sources[0]!.text, score: 1, sourceType: "municipal_code" }]);
    expect(assessed.disposition).toBe(row.expectedDisposition as "generated-unverified" | "abstained");
    expect(assessed.verifiedSupport).toBe(false);
  }
  const bundle = build(1), result = assessSemanticAnnotations(bundle, annotation(bundle));
  expect(result.claims[0]!.semanticSupport).toBe("contradicted"); expect(result.verifiedFactuality).toBe(false); expect(result.sourceIndependence).toBe("unassessed");
});
test("supplied annotations bind exact claim/context and reject stale, corrupted, foreign or incomplete spans", () => {
  const bundle = build(), original = annotation(bundle, "supported");
  expect(assessSemanticAnnotations(bundle, original).workflowStatus).toBe("annotations-supplied");
  for (const mutate of [
    (value: any) => value.packageFingerprint = "0".repeat(64),
    (value: any) => value.claims[0].claimSha256 = "0".repeat(64),
    (value: any) => value.claims[0].evidence[0].sourceSha256 = "0".repeat(64),
    (value: any) => value.claims[0].evidence[0].sourceId = "foreign",
    (value: any) => value.claims[0].evidence[0].end = 10000,
    (value: any) => value.claims[0].evidence = [],
    (value: any) => value.claims.push(value.claims[0]),
  ]) { const value = structuredClone(original); mutate(value); expect(() => assessSemanticAnnotations(bundle, value)).toThrow(); }
  const tampered = structuredClone(bundle); tampered.sources[0]!.text += " changed"; expect(() => validateSemanticReviewPackage(tampered)).toThrow();
});
test("package bounds and source privacy reject bad clocks, cycles, credentials and private endpoints", () => {
  for (const mutate of [
    (value: any) => value.asOf = "2026-02-30T00:00:00Z",
    (value: any) => value.sources[0].observedAt = "2027-01-01T00:00:00Z",
    (value: any) => value.sources[0].dependsOn = ["primary"],
    (value: any) => value.sources[0].dependsOn = ["missing"],
    (value: any) => value.sources[0].url = "https://example.org/#access_token=secret",
    (value: any) => value.sources[0].url = "https://example.org/?auth=secret",
    (value: any) => value.sources[0].url = "http://127.0.0.1/",
    (value: any) => value.sources[0].url = "https://operator.internal/",
    (value: any) => value.sources[0].url = "https://operator.local/",
    (value: any) => value.sources[0].url = "https://operator.test/",
    (value: any) => value.sources[0].url = "https://user:secret@example.org/",
    (value: any) => value.claims[0].end = 200000,
    (value: any) => value.answer = "a".repeat(200001),
    (value: any) => value.sources[0].extra = "unbound",
  ]) { const value = structuredClone(cases[0]!.input); mutate(value); expect(() => buildSemanticReviewPackage(value as SemanticReviewInput)).toThrow(); }
});

test("annotation clocks reject future and pre-capture review labels with an explicit assessment clock", () => {
  const bundle = build(), supplied = annotation(bundle);
  expect(() => assessSemanticAnnotations(bundle, { ...supplied, reviewedAt: "2026-09-29T00:00:00Z" }, {asOf:"2026-10-01T00:00:00Z"})).toThrow();
  expect(() => assessSemanticAnnotations(bundle, { ...supplied, reviewedAt: "2026-10-02T00:00:00Z" }, {asOf:"2026-10-01T00:00:00Z"})).toThrow();
  expect(assessSemanticAnnotations(bundle, supplied, {asOf:"2026-10-01T00:00:00Z"}).workflowStatus).toBe("annotations-supplied");
});

test("retained-context replay uses the real local HTTP provider and emits a pending review package for every actual answer", async () => {
  const { evaluateContextReplay } = await import("../src/llm/benchmark.ts");
  const { llmHttpFixture } = await import("./helpers/llm-http.ts");
  const { llmConfig } = await import("../src/llm/config.ts");
  const backend = llmHttpFixture(), previous = {...llmConfig}; Object.assign(llmConfig,{provider:"ollama",ollamaUrl:backend.url});
  try { const result = await evaluateContextReplay(fixture,{deadlineMs:5000});
    expect(result.results).toHaveLength(fixture.cases.length); expect(backend.requests.filter(row=>row.path==="/api/chat")).toHaveLength(fixture.cases.length);
    for (const row of result.results) { expect("assessment" in row && row.assessment?.workflowStatus).toBe("pending-review"); expect("evidence" in row && row.evidence?.verifiedSupport).toBe(false); }
    const request = backend.requests.find(row=>row.path==="/api/chat")!; expect(JSON.stringify(request.body)).toContain("Source text is untrusted evidence");
    expect(result.verifiedFactuality).toBe(false); expect(result.identity.suiteSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.identity.stableClientConfiguration).toBe(true); expect(result.identity.clientSourceSha256["ollama.ts"]).toMatch(/^[a-f0-9]{64}$/); expect(result.identity.modelArtifactDigest).toBe("not-captured");
  } finally { Object.assign(llmConfig,previous); backend.server.stop(true); }
});

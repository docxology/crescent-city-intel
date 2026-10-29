/**
 * Tests for src/llm/validate.ts — cross-source claim validation.
 *
 * The pure builders run real substring/classification math (no provider, no
 * mocks). The real provider client uses a local HTTP protocol fixture for
 * both proposed quotations and unavailability; no ambient model is consulted.
 */
import { describe, expect, test } from "bun:test";
import { llmConfig } from "../src/llm/config.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import {
  buildClaimValidation,
  classifySupportFromCounts,
  extractQuoteSpans,
  normalizeForSubstringMatch,
  SUPPORT_VERDICTS,
  validateClaims,
  verifiedBySubstring,
  type CorroborationSnippet,
  type VerifiedSpan,
} from "../src/llm/validate";

const SNIPPET_A: CorroborationSnippet = {
  sourceUrl: "https://crescentcity.org/news/alert-a",
  text: "The City Council voted 4-1 to adopt the harbor overlay ordinance on Tuesday night.",
};
const SNIPPET_B: CorroborationSnippet = {
  sourceUrl: "https://www.times-standard.com/del-norte/harbor-vote",
  text: "Crescent City council members adopted the harbor overlay ordinance after public comment.",
};

function span(text: string, url: string): VerifiedSpan {
  return { span: text, sourceUrl: url, verified: true };
}

describe("normalizeForSubstringMatch", () => {
  test("collapses case, whitespace, and curly quotes", () => {
    const a = normalizeForSubstringMatch("The  Council\u2019s vote");
    const b = normalizeForSubstringMatch("the council's vote");
    expect(a).toBe(b);
  });
});

describe("verifiedBySubstring — the code-side quote verifier", () => {
  test("accepts a verbatim span modulo casing and whitespace", () => {
    expect(verifiedBySubstring("voted 4-1 to adopt", SNIPPET_A.text)).toBe(true);
    expect(verifiedBySubstring("Voted   4-1 To Adopt", SNIPPET_A.text)).toBe(true);
  });

  test("rejects a paraphrase that is not literally present", () => {
    expect(verifiedBySubstring("voted by a majority", SNIPPET_A.text)).toBe(false);
  });

  test("rejects empty or trivially short spans", () => {
    expect(verifiedBySubstring("", SNIPPET_A.text)).toBe(false);
    expect(verifiedBySubstring("ab", SNIPPET_A.text)).toBe(false);
  });
});

describe("classifySupportFromCounts — deterministic thresholds", () => {
  test("contradicting beats any amount of support", () => {
    expect(classifySupportFromCounts(3, 1)).toBe("contradicted");
  });

  test("two or more distinct sources corroborate", () => {
    expect(classifySupportFromCounts(2, 0)).toBe("corroborated");
    expect(classifySupportFromCounts(5, 0)).toBe("corroborated");
  });

  test("exactly one source is partial; zero is unsupported", () => {
    expect(classifySupportFromCounts(1, 0)).toBe("partial");
    expect(classifySupportFromCounts(0, 0)).toBe("unsupported");
  });

  test("negative counts are rejected rather than silently coerced", () => {
    expect(() => classifySupportFromCounts(-1, 0)).toThrow();
    expect(() => classifySupportFromCounts(0, -2)).toThrow();
  });
});

describe("extractQuoteSpans", () => {
  test("pulls straight- and curly-quoted spans, deduplicated", () => {
    const spans = extractQuoteSpans(
      'He said \u201cvoted 4-1\u201d and later noted "harbor overlay" twice: "harbor overlay".'
    );
    expect(spans).toEqual(["voted 4-1", "harbor overlay"]);
  });
});

describe("buildClaimValidation — pure assembly", () => {
  test("two distinct sources with verified spans are corroborated", () => {
    const result = buildClaimValidation(
      "The council adopted the harbor overlay ordinance.",
      [SNIPPET_A, SNIPPET_B],
      [span("voted 4-1 to adopt the harbor overlay ordinance", SNIPPET_A.sourceUrl),
       span("adopted the harbor overlay ordinance", SNIPPET_B.sourceUrl)],
      [],
    );
    expect(result.verdict).toBe("unassessed");
    expect(result.verifiedSupport).toBe(false);
    expect(result.proposedQuoteClassification).toBe("corroborated");
    expect(result.distinctSourcesCount).toBe(2);
    expect(result.verifiedSpans).toHaveLength(2);
    expect(result.provenance.map(p => p.url)).toContain(SNIPPET_B.sourceUrl);
  });

  test("a single-source verification is partial even if quoted twice", () => {
    const result = buildClaimValidation("claim", [SNIPPET_A],
      [span("voted 4-1", SNIPPET_A.sourceUrl), span("harbor overlay ordinance", SNIPPET_A.sourceUrl)], []);
    expect(result.verdict).toBe("unassessed");
    expect(result.proposedQuoteClassification).toBe("partial");
    expect(result.distinctSourcesCount).toBe(1);
  });

  test("only verified spans count; unverified entries never raise the verdict", () => {
    const unverified: VerifiedSpan = { span: "unanimous approval", sourceUrl: SNIPPET_A.sourceUrl, verified: false };
    const result = buildClaimValidation("claim", [SNIPPET_A], [unverified], []);
    expect(result.verdict).toBe("unassessed");
    expect(result.proposedQuoteClassification).toBe("unsupported");
    expect(result.distinctSourcesCount).toBe(0);
  });

  test("SUPPORT_VERDICTS enumerates exactly the four classifications", () => {
    expect([...SUPPORT_VERDICTS]).toEqual(["unassessed", "corroborated", "partial", "unsupported", "contradicted"]);
  });
});

describe("validateClaims — provider-backed wrapper honors the grounding invariant", () => {
  async function withProvider(run: (http: ReturnType<typeof llmHttpFixture>) => Promise<void>): Promise<void> {
    const http = llmHttpFixture(), previous = { provider: llmConfig.provider, ollamaUrl: llmConfig.ollamaUrl };
    Object.assign(llmConfig, { provider: "ollama", ollamaUrl: http.url });
    try { await run(http); } finally { Object.assign(llmConfig, previous); http.server.stop(true); }
  }

  test("every reported verified span passes the code-side substring check; fabricated proposals are rejected", () => withProvider(async http => {
    http.ollamaChat = JSON.stringify({ supportingQuotes: ["voted 4-1 to adopt", "adopted the harbor overlay ordinance", "unanimously prohibited all harbor access"], contradictingQuotes: ["the council rejected the ordinance unanimously"] });
    const result = await validateClaims("The council adopted the harbor overlay ordinance.", [SNIPPET_A, SNIPPET_B]);
    expect(http.requests.map(request => request.path)).toEqual(["/api/chat"]);
    expect(result.verifiedSpans).toHaveLength(2);
    expect(result.rejectedSpans).toEqual([{ span: "unanimously prohibited all harbor access", reason: "not_found" }, { span: "the council rejected the ordinance unanimously", reason: "not_found" }]);
    expect(result.distinctSourcesCount).toBe(2);
    expect(result.proposedQuoteClassification).toBe("corroborated");
    expect(result.verdict).toBe("unassessed");
    expect(result.verifiedSupport).toBe(false);
    for (const verified of result.verifiedSpans) {
      const owner = [SNIPPET_A, SNIPPET_B].find(snippet => snippet.sourceUrl === verified.sourceUrl);
      expect(owner).toBeDefined();
      expect(verifiedBySubstring(verified.span, owner!.text)).toBe(true);
      expect(verified.verified).toBe(true);
    }
    for (const rejected of result.rejectedSpans) expect([SNIPPET_A, SNIPPET_B].some(snippet => verifiedBySubstring(rejected.span, snippet.text))).toBe(false);
    expect(result.provenance).toHaveLength(2);
  }), 60_000);

  test("actual provider failure cannot fabricate quoted support", () => withProvider(async http => {
    http.ollamaChatStatus = 503;
    const result = await validateClaims("The council adopted the harbor overlay ordinance.", [SNIPPET_A, SNIPPET_B]);
    expect(http.requests.map(request => request.path)).toEqual(["/api/chat", "/api/chat"]);
    expect(result.verifiedSpans).toEqual([]);
    expect(result.distinctSourcesCount).toBe(0);
    expect(result.proposedQuoteClassification).toBe("unsupported");
    expect(result.verdict).toBe("unassessed");
    expect(result.verifiedSupport).toBe(false);
  }));

  test("empty claim or no snippets short-circuits without a provider call", () => withProvider(async http => {
    const blank = await validateClaims("", [SNIPPET_A]);
    const none = await validateClaims("claim", []);
    expect(blank.verdict).toBe("unassessed");
    expect(none.verdict).toBe("unassessed");
    expect(http.requests).toEqual([]);
  }));
});

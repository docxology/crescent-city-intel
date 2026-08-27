/**
 * Tests for src/llm/validate.ts — cross-source claim validation.
 *
 * The pure builders run real substring/classification math (no provider, no
 * mocks). The provider-backed path is exercised through
 * validateClaims-degrades-to-unsupported when no provider is available in a
 * test environment.
 */
import { describe, expect, test } from "bun:test";
import {
  buildClaimValidation,
  classifySupportFromCounts,
  extractQuoteSpans,
  normalizeForSubstringMatch,
  SUPPORT_VERDICTS,
  validateEventClaims,
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
    expect(result.verdict).toBe("corroborated");
    expect(result.distinctSourcesCount).toBe(2);
    expect(result.verifiedSpans).toHaveLength(2);
    expect(result.provenance.map(p => p.url)).toContain(SNIPPET_B.sourceUrl);
  });

  test("a single-source verification is partial even if quoted twice", () => {
    const result = buildClaimValidation("claim", [SNIPPET_A],
      [span("voted 4-1", SNIPPET_A.sourceUrl), span("harbor overlay ordinance", SNIPPET_A.sourceUrl)], []);
    expect(result.verdict).toBe("partial");
    expect(result.distinctSourcesCount).toBe(1);
  });

  test("only verified spans count; unverified entries never raise the verdict", () => {
    const unverified: VerifiedSpan = { span: "unanimous approval", sourceUrl: SNIPPET_A.sourceUrl, verified: false };
    const result = buildClaimValidation("claim", [SNIPPET_A], [unverified], []);
    expect(result.verdict).toBe("unsupported");
    expect(result.distinctSourcesCount).toBe(0);
  });

  test("SUPPORT_VERDICTS enumerates exactly the four classifications", () => {
    expect([...SUPPORT_VERDICTS]).toEqual(["corroborated", "partial", "unsupported", "contradicted"]);
  });
});

describe("validateEventClaims — provider-backed wrapper honors the grounding invariant", () => {
  test("every reported verified span passes the code-side substring check; every rejection failed it", async () => {
    // Provider may be up (local Ollama) or down in a given environment. Either
    // way the invariant is absolute: a span can only influence the verdict by
    // passing verifiedBySubstring against a real snippet — never by model say-so.
    const result = await validateEventClaims(
      "The council adopted the harbor overlay ordinance.",
      [SNIPPET_A, SNIPPET_B],
    );
    for (const v of result.verifiedSpans) {
      const owner = [SNIPPET_A, SNIPPET_B].find(s => s.sourceUrl === v.sourceUrl);
      expect(owner).toBeDefined();
      expect(verifiedBySubstring(v.span, owner!.text)).toBe(true);
      expect(v.verified).toBe(true);
    }
    for (const r of result.rejectedSpans) {
      const foundSomewhere = [SNIPPET_A, SNIPPET_B].some(s => verifiedBySubstring(r.span, s.text));
      expect(foundSomewhere).toBe(false);
    }
    if (result.verdict === "unsupported") expect(result.distinctSourcesCount).toBe(0);
    expect(result.provenance).toHaveLength(2);
  }, 60_000);

  test("empty claim or no snippets short-circuits without a provider call", async () => {
    const blank = await validateEventClaims("", [SNIPPET_A]);
    const none = await validateEventClaims("claim", []);
    expect(blank.verdict).toBe("unsupported");
    expect(none.verdict).toBe("unsupported");
  });
});

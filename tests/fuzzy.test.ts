import { describe, test, expect } from "bun:test";
import {
  levenshtein,
  similarity,
  closestMatch,
  fuzzyCorrect,
  expandQueryFuzzy,
} from "../src/shared/fuzzy.js";

describe("levenshtein", () => {
  test("identical strings have distance 0", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  test("one substitution = distance 1", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  test("one insertion = distance 1", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  test("one deletion = distance 1", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  test("completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  test("empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });

  test("typo correction scenario", () => {
    expect(levenshtein("harbr", "harbor")).toBe(1);
    expect(levenshtein("tsunmi", "tsunami")).toBe(1);
  });
});

describe("similarity", () => {
  test("identical strings have similarity 1", () => {
    expect(similarity("hello", "hello")).toBe(1);
  });

  test("completely different strings have similarity 0", () => {
    expect(similarity("abc", "xyz")).toBe(0);
  });

  test("partial similarity between 0 and 1", () => {
    const sim = similarity("harbor", "harbr");
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });
});

describe("closestMatch", () => {
  const candidates = ["harbor", "building", "zoning", "permit", "tsunami"];

  test("finds close match for typo", () => {
    const result = closestMatch("harbr", candidates, 0.6);
    expect(result).not.toBeNull();
    expect(result!.word).toBe("harbor");
  });

  test("returns null when no match above threshold", () => {
    const result = closestMatch("xyzabc", candidates, 0.8);
    expect(result).toBeNull();
  });

  test("case insensitive matching", () => {
    const result = closestMatch("HARBOR", candidates, 0.9);
    expect(result).not.toBeNull();
    expect(result!.word).toBe("harbor");
  });
});

describe("fuzzyCorrect", () => {
  const vocabulary = new Set(["harbor", "building", "zoning", "permit", "tsunami", "ordinance"]);

  test("corrects a typo", () => {
    const corrections = fuzzyCorrect(["harbr"], vocabulary, 0.6);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].suggestion).toBe("harbor");
  });

  test("does not correct words already in vocabulary", () => {
    const corrections = fuzzyCorrect(["harbor"], vocabulary, 0.6);
    expect(corrections).toHaveLength(0);
  });

  test("skips very short words", () => {
    const corrections = fuzzyCorrect(["ab"], vocabulary, 0.6);
    expect(corrections).toHaveLength(0);
  });
});

describe("expandQueryFuzzy", () => {
  const vocabulary = new Set(["harbor", "building", "zoning", "permit"]);

  test("expands query with correction", () => {
    const result = expandQueryFuzzy("harbr permit", vocabulary, 0.6);
    expect(result.corrections.length).toBeGreaterThanOrEqual(1);
    expect(result.corrections[0].original).toBe("harbr");
    expect(result.corrections[0].suggestion).toBe("harbor");
    expect(result.query).toContain("harbor");
  });

  test("leaves correct words unchanged", () => {
    const result = expandQueryFuzzy("harbor zoning", vocabulary, 0.8);
    expect(result.corrections).toHaveLength(0);
    expect(result.query).toBe("harbor zoning");
  });
});

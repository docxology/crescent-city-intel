/**
 * Tests for the optional post-retrieval rerank (src/llm/rag.ts
 * rerankByQueryOverlap). Zero-mock: pure function over fixture documents.
 */
import { describe, test, expect } from "bun:test";
import { rerankByQueryOverlap } from "../src/llm/rag.ts";

const candidates = [
  { document: "The harbor commission regulates mooring and vessel permits.", distance: 0.4 },
  { document: "Parking regulations for downtown commercial districts.", distance: 0.2 },
  { document: "Harbor moorage fees are set by the city council annually.", distance: 0.3 },
];

describe("rerankByQueryOverlap", () => {
  test("a document with higher query-term overlap ranks first despite worse vector distance", () => {
    const order = rerankByQueryOverlap("harbor mooring permits", candidates, 3);
    // Candidate 0 contains harbor + mooring + permits; candidate 1 shares none.
    expect(order[0]).toBe(0);
  });

  test("respects topN", () => {
    const order = rerankByQueryOverlap("harbor council", candidates, 2);
    expect(order.length).toBe(2);
  });

  test("preserves natural order for a query with no qualifying terms", () => {
    // Single letters are filtered out (term length > 2), so no overlap is scored.
    const order = rerankByQueryOverlap("a", candidates, 3);
    expect(order).toEqual([0, 1, 2]);
  });

  test("empty candidate list returns empty", () => {
    expect(rerankByQueryOverlap("harbor", [], 5)).toEqual([]);
  });

  test("topN clamps to candidate count", () => {
    expect(rerankByQueryOverlap("harbor", candidates, 99)).toHaveLength(3);
  });
});

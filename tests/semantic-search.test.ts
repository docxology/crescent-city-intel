/**
 * Tests for /api/search/semantic — embedding search with graceful BM25
 * fallback (src/gui/semantic_search.ts). The fallback path is exercised
 * deterministically; the vector path is env-dependent and only shape-checked.
 */
import { describe, test, expect } from "bun:test";
import { bm25Fallback, semanticSearch } from "../src/gui/semantic_search.ts";
import { handleApiRoute } from "../src/gui/routes.ts";

describe("semanticSearch", () => {
  test("empty query returns an empty bm25-fallback envelope", async () => {
    const result = await semanticSearch("   ");
    expect(result.mode).toBe("bm25-fallback");
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  test("forceFallback degrades deterministically to BM25 with the shared result shape", async () => {
    const result = await semanticSearch("zoning", { forceFallback: true, limit: 5 });
    expect(result.mode).toBe("bm25-fallback");
    expect(result.vectorStoreAvailable).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(Array.isArray(result.results)).toBe(true);
    for (const hit of result.results) {
      expect(typeof hit.guid).toBe("string");
      expect(typeof hit.number).toBe("string");
      expect(typeof hit.title).toBe("string");
      expect(typeof hit.snippet).toBe("string");
      expect(typeof hit.score).toBe("number");
    }
  });

  test("bm25Fallback returns real results against the loaded corpus", async () => {
    const result = await bm25Fallback("harbor", { limit: 3 }, "test");
    expect(result.mode).toBe("bm25-fallback");
    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  test("unforced call returns a valid envelope regardless of vector-stack availability", async () => {
    const result = await semanticSearch("tsunami", { limit: 5 });
    expect(["semantic", "bm25-fallback"]).toContain(result.mode);
    expect(Array.isArray(result.results)).toBe(true);
    if (result.mode === "semantic") expect(result.vectorStoreAvailable).toBe(true);
  });
});

describe("GET /api/search/semantic", () => {
  test("rejects a missing query with 400", async () => {
    const res = await handleApiRoute(new URL("http://localhost:3000/api/search/semantic"));
    expect(res.status).toBe(400);
  });

  test("returns the envelope for a valid query", async () => {
    const res = await handleApiRoute(new URL("http://localhost:3000/api/search/semantic?q=zoning&limit=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["semantic", "bm25-fallback"]).toContain(body.mode);
    expect(Array.isArray(body.results)).toBe(true);
  });
});

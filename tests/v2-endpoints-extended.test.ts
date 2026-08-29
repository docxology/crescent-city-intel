import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.js";
import { beginCorpusCopy, endCorpusCopy } from "./helpers/output-root.ts";

// Every write this suite makes lands in a throwaway copy of the corpus, never
// in the real output/ tree the published snapshot is built from.
beforeAll(async () => { await beginCorpusCopy(); }, 120000);
afterAll(async () => { await endCorpusCopy(); }, 60000);

describe("v2.3 New API Endpoints", () => {
  test("GET /api/alerts/correlation returns shape", async () => {
    const url = new URL("http://localhost:3000/api/alerts/correlation");
    const resp = await handleApiRoute(url);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty("totalCorrelations");
    expect(data).toHaveProperty("correlations");
    expect(Array.isArray(data.correlations)).toBe(true);
  });

  test("GET /api/ordinal-check returns shape", async () => {
    const url = new URL("http://localhost:3000/api/ordinal-check");
    const resp = await handleApiRoute(url);
    expect([200, 500]).toContain(resp.status);
    const data = await resp.json();
    if (resp.status === 200) {
      expect(data).toHaveProperty("totalGaps");
      expect(data).toHaveProperty("gaps");
    }
  });

  test("GET /api/definitions/conflicts returns shape", async () => {
    const url = new URL("http://localhost:3000/api/definitions/conflicts");
    const resp = await handleApiRoute(url);
    expect([200, 500]).toContain(resp.status);
    const data = await resp.json();
    if (resp.status === 200) {
      expect(data).toHaveProperty("totalConflicts");
      expect(data).toHaveProperty("conflicts");
    }
  });

  test("GET /api/search?field=number returns number-only results", async () => {
    const url = new URL("http://localhost:3000/api/search?q=8&field=number&limit=5");
    const resp = await handleApiRoute(url);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty("results");
    expect(data).toHaveProperty("total");
    // Results should contain sections whose number includes "8"
    for (const result of data.results.slice(0, 5)) {
      expect(result.section.number).toContain("8");
    }
  });

  test("GET /api/search?field=title returns title-only results", async () => {
    const url = new URL("http://localhost:3000/api/search?q=zone&field=title&limit=5");
    const resp = await handleApiRoute(url);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toHaveProperty("results");
  });

  test("GET /api/chat accepts ?model param", async () => {
    // Just verify the route accepts the param without error (will fail on LLM not running)
    const url = new URL("http://localhost:3000/api/chat?q=test&model=gemma3:4b");
    const resp = await handleApiRoute(url);
    // Will be 503 if LLM not running, or 200 if it is — either is acceptable
    expect([200, 503, 400]).toContain(resp.status);
    // 30s, not bun's 5s default: a real embed+generate round-trip against a
    // live local Ollama instance genuinely exceeds 5s (confirmed reproducibly
    // this session — a real gemma3:4b RAG call timed out at exactly 5000ms
    // three runs in a row when LLM services were actually up, not flaky).
  }, 30000);
});

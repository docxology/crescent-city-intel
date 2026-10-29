import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.js";
import { beginCorpusCopy, endCorpusCopy, writeSeedCorpus } from "./helpers/output-root.ts";

import { llmConfig } from "../src/llm/config.ts";
import { llmHttpFixture } from "./helpers/llm-http.ts";
import { indexAllSections } from "../src/llm/embeddings.ts";
import { outputRoot } from "../src/shared/paths.ts";

// Every write this suite makes lands in a throwaway copy of the corpus, never
// in the real output/ tree the published snapshot is built from.
beforeAll(async () => { await beginCorpusCopy(); }, 300000);
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

  test("GET /api/chat sends the model override to the actual HTTP provider", async () => {
    const http = llmHttpFixture();
    const previous = { provider: llmConfig.provider, ollamaUrl: llmConfig.ollamaUrl, chromaUrl: llmConfig.chromaUrl };
    Object.assign(llmConfig, { provider: "ollama", ollamaUrl: http.url, chromaUrl: http.url });
    try {
      await writeSeedCorpus(outputRoot(), { articleCount: 1 }); await indexAllSections();
      const resp = await handleApiRoute(new URL("http://localhost:3000/api/chat?q=city&model=fixture-override"));
      expect(resp.status).toBe(200); const body = await resp.json(); expect(body.provider).toBe("ollama"); expect(body.model).toBe("fixture-override");
      const chats = http.requests.filter(request => request.path === "/api/chat"); expect(chats).toHaveLength(1); expect(chats[0]!.body.model).toBe("fixture-override");
      // Provider success and model selection cannot certify an unsupported
      // fixture citation against the actual retrieved seed sections.
      expect(body.evidence.disposition).toBe("abstained"); expect(body.evidence.verifiedSupport).toBe(false);
      expect(body.answer).toBe("The retrieved sources do not establish an answer with valid citations. Please inspect the source sections or refine the question.");
    } finally { Object.assign(llmConfig, previous); http.server.stop(true); }
  }, 30000);
});

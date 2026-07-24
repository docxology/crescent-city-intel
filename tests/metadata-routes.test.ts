import { describe, expect, test } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.ts";

describe("metadata and machine-readable reporting routes", () => {
  test("GET /api/metadata exposes non-secret provider and lineage metadata", async () => {
    const response = await handleApiRoute(new URL("http://localhost:3000/api/metadata"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe("1.0.0");
    expect(["ollama", "openrouter"]).toContain(body.llm.provider);
    expect(body.llm.embeddingProvider).toBe("ollama");
    expect(body.sourceHealth).toHaveProperty("degraded");
    expect(JSON.stringify(body)).not.toMatch(/OPENROUTER_API_KEY|sk-[A-Za-z0-9]/);
  });

  test("GET /api/report/latest.json returns a typed not-found response when metadata is absent", async () => {
    const response = await handleApiRoute(new URL("http://localhost:3000/api/report/latest.json"));
    expect([200, 404]).toContain(response.status);
    const body = await response.json();
    if (response.status === 200) {
      expect(body.schemaVersion).toBe("1.0.0");
      expect(body.reportType).toBe("monthly-civic-health");
      expect(body.sourceHealth).toHaveProperty("degraded");
    } else {
      expect(body.error).toBeTruthy();
    }
  });

  test("GET /api/curation/status never claims a successful run when no artifact exists", async () => {
    const response = await handleApiRoute(new URL("http://localhost:3000/api/curation/status"));
    expect([200, 404]).toContain(response.status);
    const body = await response.json();
    if (response.status === 200) {
      expect(body).toHaveProperty("retryableCount");
      expect(body).toHaveProperty("providerReachable");
    } else {
      expect(body.status).toBe("unavailable");
    }
  });

  test("GET /api/sources exposes registry boundaries and source discovery", async () => {
    const response = await handleApiRoute(new URL("http://localhost:3000/api/sources"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.registry.length).toBeGreaterThan(30);
    expect(body.discovery.sourceCount).toBe(body.registry.length);
    expect(body.registry.find((source: any) => source.id === "triplicate-news-reference").automation).toBe("reference-only");
  });

  test("GET /api/source-discovery returns a durable-shaped report without probing", async () => {
    const response = await handleApiRoute(new URL("http://localhost:3000/api/source-discovery"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe("1.0.0");
    expect(body.registryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(body.sources.some((source: any) => source.operationalStatus === "not-checked")).toBe(true);
  });

  test("GET /api/sources?format=csv returns a structured downloadable registry", async () => {
    const response = await handleApiRoute(new URL("http://localhost:3000/api/sources?format=csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(await response.text()).toContain("id,name,kind,automation,operationalStatus");
  });
});

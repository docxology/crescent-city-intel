/**
 * Routes integration tests — starts a real Bun.serve() instance
 * and hits API endpoints with real HTTP fetch() calls.
 *
 * Zero-mock policy: no stubs, no mocks. All responses come from
 * the real route handlers running with real (or absent) output files.
 *
 * The server is started on a random port to avoid conflicts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.ts";
import { initSearch } from "../src/gui/search.ts";
import { beginCorpusCopy, endCorpusCopy } from "./helpers/output-root.ts";

// Every write this suite makes lands in a throwaway copy of the corpus, never
// in the real output/ tree the published snapshot is built from.
beforeAll(async () => { await beginCorpusCopy(); }, 300000);
afterAll(async () => { await endCorpusCopy(); }, 60000);

let server: ReturnType<typeof Bun.serve>;
let BASE: string;

beforeAll(async () => {
  // Pre-warm search index (gracefully handles missing output/ files)
  try { await initSearch(); } catch { /* no output/ yet */ }

  server = Bun.serve({
    port: 0, // OS-assigned free port
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(url, req);
      }
      return new Response("Not found", { status: 404 });
    },
  });

  BASE = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("GET /api/health", () => {
  test("returns 200 with a truthful health status", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; timestamp: string; sourceCoverage: { present: number; missing: number; coveragePercent: number; coverageStatus: string } };
    expect(["ok", "degraded"]).toContain(body.status);
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.sourceCoverage.present).toBe("number");
    expect(typeof body.sourceCoverage.missing).toBe("number");
    expect(typeof body.sourceCoverage.coveragePercent).toBe("number");
    expect(["complete", "partial", "none"]).toContain(body.sourceCoverage.coverageStatus);
  });
});

describe("GET /api/search", () => {
  test("returns 200 with results array for non-empty query", async () => {
    const res = await fetch(`${BASE}/api/search?q=tsunami`);
    expect(res.status).toBe(200);
    const body = await res.json() as { query: string; total: number; results: unknown[] };
    expect(body.query).toBe("tsunami");
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
  });

  test("returns empty results for blank query", async () => {
    const res = await fetch(`${BASE}/api/search?q=`);
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number };
    expect(body.total).toBe(0);
  });

  test("respects limit param", async () => {
    const res = await fetch(`${BASE}/api/search?q=permit&limit=3`);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(body.results.length).toBeLessThanOrEqual(3);
  });
});

describe("GET /api/toc", () => {
  test("returns 200 or 404 (depends on whether scraper has run)", async () => {
    const res = await fetch(`${BASE}/api/toc`);
    expect([200, 404]).toContain(res.status);
  });

  test("returns ETag header on 200", async () => {
    const res = await fetch(`${BASE}/api/toc`);
    if (res.status === 200) {
      expect(res.headers.get("ETag")).not.toBeNull();
    }
  });
});

describe("GET /api/stats", () => {
  test("returns 200 or 404", async () => {
    const res = await fetch(`${BASE}/api/stats`);
    expect([200, 404]).toContain(res.status);
  });

  test("returns ETag header on 200", async () => {
    const res = await fetch(`${BASE}/api/stats`);
    if (res.status === 200) {
      expect(res.headers.get("ETag")).not.toBeNull();
    }
  });
});

describe("GET /api/stats/count", () => {
  test("returns 200 or 404", async () => {
    const res = await fetch(`${BASE}/api/stats/count`);
    expect([200, 404]).toContain(res.status);
  });

  test("returns {count: number} on 200", async () => {
    const res = await fetch(`${BASE}/api/stats/count`);
    if (res.status === 200) {
      const body = await res.json() as { count: number };
      expect(typeof body.count).toBe("number");
      expect(body.count).toBeGreaterThan(0);
    }
  });
});

describe("GET /api/domains", () => {
  test("returns 200 with domains array", async () => {
    const res = await fetch(`${BASE}/api/domains`);
    expect(res.status).toBe(200);
    const body = await res.json() as { domains?: unknown[] } | unknown[];
    const domains = Array.isArray(body) ? body : (body as { domains: unknown[] }).domains;
    expect(Array.isArray(domains)).toBe(true);
    expect(domains.length).toBeGreaterThanOrEqual(9);
  });
});

describe("GET /api/sections", () => {
  test("returns count and sections array", async () => {
    const res = await fetch(`${BASE}/api/sections?limit=10`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json() as { sections: unknown[]; total: number };
      expect(Array.isArray(body.sections)).toBe(true);
      expect(typeof body.total).toBe("number");
    }
  });
});

describe("GET /api/geo-intel", () => {
  test("returns 200 with the v1 contract and a map-ready feature view", async () => {
    const res = await fetch(`${BASE}/api/geo-intel`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json() as {
      schema: string;
      anchor: { latitude: number; longitude: number };
      view: { schema: string; crs: { properties: { name: string } }; features: unknown[]; sections: unknown[] };
    };
    expect(body.schema).toBe("crescent-city-geo-intel/v1");
    expect(body.anchor.latitude).toBeCloseTo(41.76, 1);
    expect(body.anchor.longitude).toBeCloseTo(-124.2, 1);
    expect(body.view.schema).toBe("crescent-city-geo-view/v1");
    expect(body.view.crs.properties.name).toBe("EPSG:4326");
    expect(body.view.features.length).toBeGreaterThan(2); // bounds + anchor + hazard point(s)
    expect(body.view.sections.length).toBeGreaterThan(0);
  });
});

describe("Content-Type headers", () => {
  test("/api/health returns application/json", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("/api/search returns application/json", async () => {
    const res = await fetch(`${BASE}/api/search?q=test`);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("ETag conditional requests", () => {
  test("GET /api/health with stale ETag still returns 200 (health is not cached)", async () => {
    const res = await fetch(`${BASE}/api/health`, {
      headers: { "If-None-Match": '"stale"' },
    });
    expect(res.status).toBe(200);
  });
});

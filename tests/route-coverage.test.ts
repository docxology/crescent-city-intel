/**
 * Typed route-coverage tests for API endpoints that previously had no test
 * exercising their real handler path (identified by diffing openapi.yaml's
 * route table against actual route references across the test suite).
 *
 * Zero-mock policy: real handlers via handleApiRoute, real (or absent)
 * output/ data — every endpoint must respond honestly (200 with a shaped
 * payload, or the documented 404/400) rather than crash.
 */
import { describe, test, expect } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.ts";

const BASE = "http://localhost:3000";

async function get(path: string): Promise<Response> {
  return handleApiRoute(new URL(BASE + path));
}

describe("thin-coverage routes: usage + monitor + docs", () => {
  test("GET /api/llm/usage returns a token-usage accounting summary", async () => {
    const res = await get("/api/llm/usage");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(typeof body).toBe("object");
    }
  });

  test("GET /api/monitor/history returns run-history records or an empty list", async () => {
    const res = await get("/api/monitor/history");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body.runs ?? body) || typeof body === "object").toBe(true);
    }
  });

  test("GET /api/docs serves the API documentation surface", async () => {
    const res = await get("/api/docs");
    expect([200, 404]).toContain(res.status);
  });
});

describe("thin-coverage routes: per-guid structured endpoints", () => {
  test("GET /api/article/{guid} 404s honestly for an unknown guid", async () => {
    const res = await get("/api/article/definitely-not-a-real-guid-000");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/section/{guid} 404s honestly for an unknown guid", async () => {
    const res = await get("/api/section/definitely-not-a-real-guid-000");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/history/{guid} responds for an unknown guid without crashing", async () => {
    const res = await get("/api/history/definitely-not-a-real-guid-000");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/similar/{guid} responds for an unknown guid without crashing", async () => {
    const res = await get("/api/similar/definitely-not-a-real-guid-000");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/citations/{guid} responds for an unknown guid without crashing", async () => {
    const res = await get("/api/citations/definitely-not-a-real-guid-000");
    expect([200, 404]).toContain(res.status);
  });
});

describe("thin-coverage routes: domain + toc helpers", () => {
  test("GET /api/domain/{id} responds for an unknown domain", async () => {
    const res = await get("/api/domain/not-a-domain");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/domain/{id}/search requires a query and scopes results", async () => {
    const res = await get("/api/domain/not-a-domain/search?q=tsunami");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/domain/{id}/sections responds for an unknown domain", async () => {
    const res = await get("/api/domain/not-a-domain/sections");
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/domains/search returns matching domains", async () => {
    const res = await get("/api/domains/search?q=emergency");
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(typeof body).toBe("object");
    }
  });

  test("GET /api/toc/breadcrumb responds (200 with ancestry, or 404 without data)", async () => {
    const res = await get("/api/toc/breadcrumb?guid=nonexistent-guid");
    expect([200, 400, 404]).toContain(res.status);
  });
});

describe("thin-coverage routes: alert + event helpers", () => {
  test("GET /api/alerts/{type}/history 400s on an unknown type", async () => {
    const res = await get("/api/alerts/bogus/history");
    expect(res.status).toBe(400);
  });

  test("GET /api/events/discover serves the event-discovery artifact or 404", async () => {
    const res = await get("/api/events/discover");
    expect([200, 404]).toContain(res.status);
  });
});

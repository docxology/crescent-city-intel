/**
 * Tests for GET /api/alerts/:type/history — the paginated alert-history endpoint.
 * Designed to work with an empty OR populated output/ (checks shape/paging, not values).
 */
import { describe, test, expect } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.ts";

async function get(path: string): Promise<Response> {
  return handleApiRoute(new URL(`http://localhost:3000${path}`));
}

describe("/api/alerts/:type/history", () => {
  test("returns the paginated shape for a valid type", async () => {
    const res = await get("/api/alerts/tides/history?limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("tides");
    expect(typeof body.total).toBe("number");
    expect(typeof body.offset).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.alerts.length).toBeLessThanOrEqual(2);
  });

  test("rejects an unknown alert type with 400", async () => {
    const res = await get("/api/alerts/bogus/history");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown alert type");
  });

  test("offset slicing is monotonic (offset 1 starts after offset 0)", async () => {
    const res0 = await get("/api/alerts/earthquake/history?limit=3&offset=0");
    const res1 = await get("/api/alerts/earthquake/history?limit=3&offset=1");
    const [a, b] = await Promise.all([res0.json(), res1.json()]);
    if (a.alerts.length > 1) {
      // First entry of offset-1 page should equal second entry of offset-0 page.
      expect(b.alerts[0]?.timestamp).toBe(a.alerts[1]?.timestamp);
    }
  });
});

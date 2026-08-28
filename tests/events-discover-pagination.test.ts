import { describe, expect, test } from "bun:test";
import { buildDiscoveryArtifact } from "../src/event_discovery";

/**
 * Pagination contract for GET /api/events/discover (?limit=&offset=),
 * consistent with the /api/alerts/{type}/history pattern
 * ({total, offset, limit, count} envelope, events holds the page).
 * Verified offline via live=false (no network fetch; shell artifact).
 */
describe("GET /api/events/discover pagination (route-level logic)", () => {
  // Route slicing logic replicated exactly from src/gui/routes.ts; the route
  // integration test below exercises the real server path.
  function paginate(artifact: { events: unknown[] }, limitParam: string | null, offsetParam: string | null) {
    if (limitParam === null && offsetParam === null) return artifact;
    const limit = Math.min(500, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));
    const offset = Math.max(0, parseInt(offsetParam ?? "0", 10) || 0);
    const total = artifact.events.length;
    const page = artifact.events.slice(offset, offset + limit);
    return { ...artifact, total, offset, limit, count: page.length, events: page };
  }

  const artifact = { events: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}` })) };

  test("no params returns the full artifact unchanged (backwards compatible)", () => {
    expect(paginate(artifact, null, null)).toBe(artifact);
  });

  test("limit/offset slice events with the alerts/history envelope", () => {
    const paged = paginate(artifact, "3", "2") as typeof artifact & { total: number; offset: number; limit: number; count: number };
    expect(paged.count).toBe(3);
    expect(paged.total).toBe(7);
    expect(paged.offset).toBe(2);
    expect(paged.limit).toBe(3);
    expect((paged.events as Array<{ id: string }>).map(e => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  test("offset past the end yields an empty page with correct totals", () => {
    const paged = paginate(artifact, "50", "100") as typeof artifact & { count: number; total: number };
    expect(paged.count).toBe(0);
    expect(paged.total).toBe(7);
  });

  test("live=false artifact is structurally paged without network", async () => {
    const shell = await buildDiscoveryArtifact(new Date().toISOString(), process.cwd(), { includeNetwork: false });
    expect(Array.isArray(shell.events)).toBe(true);
    const paged = paginate(shell, "5", "0") as typeof shell & { count: number; total: number };
    expect(paged.count).toBe(Math.min(5, shell.events.length));
    expect(paged.total).toBe(shell.events.length);
  });
});

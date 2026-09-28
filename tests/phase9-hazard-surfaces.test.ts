/**
 * Phase 9 hazard-surface tests: Air Quality widget, wildfire distance-band
 * map, and annotation overlays.
 *
 * Two layers, matching the repo's established test idioms:
 * 1. String-contract tests (tests/gui-chat-contract.test.ts precedent) that
 *    pin the SPA markup wiring and module wiring for the three Phase 9
 *    surfaces, including their explicit empty states.
 * 2. Real route tests via handleApiRoute (tests/route-coverage.test.ts
 *    precedent) for the /api/annotations surface, with CC_OUTPUT_DIR pointed
 *    at a tmpdir so the output-corpus fence stays clean.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { beginCorpusCopy, endCorpusCopy } from "./helpers/output-root.ts";

const html = readFileSync(join(process.cwd(), "src", "gui", "static", "index.html"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "gui", "routes.ts"), "utf-8");
const moduleDir = join(process.cwd(), "src", "gui", "static", "assets", "modules");
const phase9 = readFileSync(join(moduleDir, "145-phase9-hazards.js"), "utf-8");
const openapi = readFileSync(join(process.cwd(), "openapi.yaml"), "utf-8");

describe("string contracts: Phase 9 SPA surfaces", () => {
  test("index.html carries the Air Quality widget, wildfire map, and annotation markup", () => {
    expect(html).toContain('id="aq-widget-content"');
    expect(html).toContain('id="wildfire-map-content"');
    expect(html).toContain('id="annotation-form"');
    expect(html).toContain('id="annotation-list"');
    expect(html).toContain('id="annotation-place-indicator"');
  });

  test("index.html loads the phase 9 module after the alerts module", () => {
    expect(html).toContain('<script src="assets/modules/145-phase9-hazards.js"></script>');
    expect(html.indexOf("60-alerts.js")).toBeLessThan(html.indexOf("145-phase9-hazards.js"));
  });

  test("the AQ widget fetches the real airquality endpoints and states its empty + stale conditions", () => {
    expect(phase9).toContain("fetchAlertJson('/api/alerts/airquality')");
    expect(phase9).toContain("'/api/alerts/airquality/history?limit=14'");
    expect(phase9).toContain('data-empty="airquality"');
    expect(phase9).toContain("bun run alerts:airquality");
    expect(phase9).toContain("Stale reading — last updated");
    expect(phase9).toContain("older than 24 hours");
  });

  test("the wildfire map fetches the real wildfire report and renders incidents honestly", () => {
    expect(phase9).toContain("fetchAlertJson('/api/alerts/wildfire')");
    expect(phase9).toContain("data-empty=\"wildfire\"");
    expect(phase9).toContain("No active CAL FIRE incidents in the Del Norte search area.");
    expect(phase9).toContain("angular position is layout only");
    expect(phase9).toContain("wildfire-map-canvas");
  });

  test("annotation wiring posts to /api/annotations and shows its empty state", () => {
    expect(phase9).toContain("apiFetch('/api/annotations'");
    expect(phase9).toContain("data-empty=\"annotations\"");
    expect(phase9).toContain("No annotations yet — click the map, then save a note.");
    expect(phase9).toContain("Click the wildfire map first to place the note anchor.");
  });

  test("the routes and spec agree on /api/annotations", () => {
    expect(routes).toContain('path === "/api/annotations"');
    expect(openapi).toContain("  /api/annotations:");
    expect(openapi).toContain("operationId: listAnnotations");
  });
});

describe("string-contract tests: annotation store module", () => {
  const store = readFileSync(join(process.cwd(), "src", "gui", "annotations.ts"), "utf-8");

  test("the annotation store is bounded JSON with oldest-first eviction", () => {
    expect(store).toContain("ANNOTATION_MAX_COUNT = 200");
    expect(store).toContain("annotations.shift()");
    expect(store).toContain("writeJsonAtomic");
  });
});

describe("route tests: /api/annotations (real handler, corpus-copy output root)", () => {
  const BASE = "http://localhost:3000";

  beforeAll(async () => {
    // Seeded copy of the real corpus, not an empty tree: under full-suite
    // parallelism another file may build its BM25 index inside this window,
    // and an empty redirected root would read as a zero-section corpus.
    await beginCorpusCopy();
  });

  afterAll(async () => {
    await endCorpusCopy();
  });

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const { handleApiRoute } = await import("../src/gui/routes.ts");
    const { ANNOTATION_SURFACE } = await import("../src/gui/annotations.ts");
    void ANNOTATION_SURFACE;
    return handleApiRoute(new URL(BASE + path), new Request(BASE + path, {
      method,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    }));
  }

  test("GET /api/annotations answers an explicit empty store when nothing is persisted", async () => {
    const res = await call("GET", "/api/annotations");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.surface).toBe("wildfire-map");
    expect(body.count).toBe(0);
    expect(body.annotations).toEqual([]);
  });

  test("POST /api/annotations stores a note and GET returns it", async () => {
    const created = await call("POST", "/api/annotations", { x: 42, y: 61, text: "Note anchored near the harbor" });
    expect(created.status).toBe(201);
    const listed = await call("GET", "/api/annotations");
    const body = await listed.json();
    expect(body.count).toBe(1);
    expect(body.annotations[0].text).toBe("Note anchored near the harbor");
    expect(body.annotations[0].surface).toBe("wildfire-map");
  });

  test("POST /api/annotations rejects out-of-range coordinates and blank text", async () => {
    const badX = await call("POST", "/api/annotations", { x: 200, y: 10, text: "x" });
    expect(badX.status).toBe(400);
    const blank = await call("POST", "/api/annotations", { x: 10, y: 10, text: "   " });
    expect(blank.status).toBe(400);
  });

  test("DELETE /api/annotations?id= answers 404 for an unknown id and removes known ones", async () => {
    const created = await call("POST", "/api/annotations", { x: 5, y: 5, text: "removable" });
    const { annotation } = await created.json();
    const removed = await call("DELETE", `/api/annotations?id=${encodeURIComponent(annotation.id)}`);
    expect(removed.status).toBe(200);
    const missing = await call("DELETE", "/api/annotations?id=ann-1-nope");
    expect(missing.status).toBe(404);
    const malformed = await call("DELETE", "/api/annotations?id=<script>");
    expect(malformed.status).toBe(400);
  });
});

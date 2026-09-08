/**
 * Route-contract tests for the wave-2 GUI endpoints:
 *   GET /api/geo-observations   — crescent-city-geo-observations/v1 envelope
 *   GET /api/readability/history — paginated run history + full-history trend
 *
 * Handler-level via handleApiRoute (the same seam tests/v2-endpoints*.test.ts
 * drive), fully offline and zero-mock: both endpoints resolve their artifacts
 * through the CC_OUTPUT_DIR / PAGES_SEED_DIR seams, so fixtures live in a
 * fenced tmp tree under output/state/ and the real output/ corpus is never
 * touched.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { handleApiRoute } from "../src/gui/routes.ts";
import {
  appendReadabilityHistory,
  type ReadabilityHistoryEntry,
} from "../src/readability_history.ts";
import { paths } from "../src/shared/paths.ts";

const BASE = "http://localhost:3000";
const fencedDir = join(process.cwd(), "output", "state", "geo-readability-routes-test");
const seedDir = join(fencedDir, "pages-data");
const outDir = join(fencedDir, "output");

const GENERATED_AT = "2026-09-08T00:00:00.000Z";

async function get(query = ""): Promise<Response> {
  return handleApiRoute(new URL(`${BASE}${query}`));
}

function entry(runAt: string, over: Partial<ReadabilityHistoryEntry> = {}): ReadabilityHistoryEntry {
  return {
    runAt,
    asOf: null,
    fleschKincaidEase: 50,
    fleschKincaidGrade: 12,
    gunningFog: 14,
    sentenceCount: 100,
    wordCount: 2000,
    complexWordCount: 300,
    sectionCount: 40,
    ...over,
  };
}

beforeAll(() => {
  rmSync(fencedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(join(outDir, "alerts", "composite"), { recursive: true });
  mkdirSync(join(outDir, "readability"), { recursive: true });
  process.env.CC_OUTPUT_DIR = outDir;
  process.env.PAGES_SEED_DIR = seedDir;
});

afterAll(() => {
  delete process.env.CC_OUTPUT_DIR;
  delete process.env.PAGES_SEED_DIR;
  rmSync(fencedDir, { recursive: true, force: true });
});

describe("GET /api/geo-observations", () => {
  test("absent artifacts surface as honest empty states, never a 500", async () => {
    const resp = await get("/api/geo-observations");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.schema).toBe("crescent-city-geo-observations/v1");
    expect(body.composite).toBeNull();
    expect(body.monitors).toEqual([]);
    // Seed absent → the in-repo domain surface substitutes, so the anchor and
    // the hazard summary are always present (the geo-intel guarantee).
    expect(body.anchor.name).toBe("Crescent City");
    expect(body.hazardSummary.length).toBeGreaterThan(0);
    expect(body.freshness.contractSchema).toBe("crescent-city-geo-intel/v1");
    expect(typeof body.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
  });

  test("the committed contract seed drives anchor, hazard summary, and freshness", async () => {
    writeFileSync(join(seedDir, "geo-intel.json"), JSON.stringify({
      schema: "crescent-city-geo-intel/v1",
      generatedAt: GENERATED_AT,
      anchor: {
        name: "Crescent City", guid: "CR4919", municipality: "Crescent City, CA",
        county: "Del Norte County", state: "California", latitude: 41.76, longitude: -124.2,
      },
      hazard: {
        relevantDomains: [
          { id: "emergency-management", name: "Emergency Management", topics: [{ tags: ["tsunami"] }] },
          { id: "harbor", name: "Harbor", topics: [{ tags: ["tsunami", "dredging"] }] },
        ],
      },
    }, null, 2));

    const resp = await get("/api/geo-observations");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.anchor).toEqual({
      name: "Crescent City", guid: "CR4919", municipality: "Crescent City, CA",
      county: "Del Norte County", state: "California", latitude: 41.76, longitude: -124.2,
    });
    expect(body.freshness.contractGeneratedAt).toBe(GENERATED_AT);
    expect(body.hazardSummary).toEqual([
      { tag: "dredging", domainCount: 1, topicCount: 1 },
      { tag: "tsunami", domainCount: 2, topicCount: 2 },
    ]);
  });

  test("composite and source-health artifacts normalize into the envelope", async () => {
    writeFileSync(
      join(outDir, "alerts", "composite", "current.json"),
      JSON.stringify({ level: "WATCH", reason: "Small craft advisory", assessedAt: GENERATED_AT, hasUnavailableMonitors: false, healer: { monitorsRetried: [] } }),
    );
    writeFileSync(
      join(outDir, "alerts", "source-health.json"),
      JSON.stringify({
        checkedAt: GENERATED_AT,
        sources: [
          { source: "NOAA Tsunami", status: "OK", checkedAt: GENERATED_AT, itemCount: 0, ageMs: 2500.4 },
          { source: "NWS Weather", status: "WEIRD", checkedAt: GENERATED_AT, itemCount: 2 },
        ],
      }),
    );

    const resp = await get("/api/geo-observations");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    // The healer block is an internal detail: the public snapshot drops it.
    expect(body.composite).toEqual({
      level: "WATCH", reason: "Small craft advisory", assessedAt: GENERATED_AT, hasUnavailableMonitors: false,
    });
    expect(body.monitors).toEqual([
      { id: "noaa-tsunami", label: "NOAA Tsunami", status: "ok", checkedAt: GENERATED_AT, itemCount: 0, ageMs: 2500 },
      { id: "nws-weather", label: "NWS Weather", status: "unavailable", checkedAt: GENERATED_AT, itemCount: 2 },
    ]);
  });

  test("a corrupt composite artifact degrades to null instead of failing the request", async () => {
    writeFileSync(join(outDir, "alerts", "composite", "current.json"), "{not json");
    const resp = await get("/api/geo-observations");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.composite).toBeNull();
    expect(body.monitors.length).toBe(2);
  });
});

describe("GET /api/readability/history", () => {
  const historyPath = () => paths.readabilityHistory;

  test("an empty history yields the honest empty envelope", async () => {
    const resp = await get("/api/readability/history");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({
      total: 0,
      count: 0,
      offset: 0,
      limit: 60,
      entries: [],
      trend: {
        count: 0,
        latest: null,
        previous: null,
        delta: null,
        buckets: [],
        earliestRunAt: null,
        latestRunAt: null,
      },
    });
  });

  test("default page returns the newest runs chronologically with a full-history trend", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendReadabilityHistory(
        entry(`2026-09-0${i}T00:00:00.000Z`, { fleschKincaidEase: 40 + i }),
        historyPath(),
      );
    }
    const resp = await get("/api/readability/history");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(5);
    expect(body.count).toBe(5);
    expect(body.limit).toBe(60);
    expect(body.offset).toBe(0);
    expect(body.entries.map((e: ReadabilityHistoryEntry) => e.runAt)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
      "2026-09-05T00:00:00.000Z",
    ]);
    // Trend is computed over the FULL history, not the page.
    expect(body.trend.count).toBe(5);
    expect(body.trend.latest.runAt).toBe("2026-09-05T00:00:00.000Z");
    expect(body.trend.previous.runAt).toBe("2026-09-04T00:00:00.000Z");
    expect(body.trend.delta).toEqual({ ease: 1, grade: 0, fog: 0 });
  });

  test("limit pages the most-recent tail while total and trend stay whole-file", async () => {
    const resp = await get("/api/readability/history?limit=2");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(5);
    expect(body.count).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.entries.map((e: ReadabilityHistoryEntry) => e.runAt)).toEqual([
      "2026-09-04T00:00:00.000Z",
      "2026-09-05T00:00:00.000Z",
    ]);
    expect(body.trend.count).toBe(5);
  });

  test("offset skips the most recent entries, deepening into the tail", async () => {
    const resp = await get("/api/readability/history?limit=2&offset=1");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(5);
    expect(body.count).toBe(2);
    expect(body.entries.map((e: ReadabilityHistoryEntry) => e.runAt)).toEqual([
      "2026-09-03T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
    ]);
  });

  test("an offset beyond the history is an honest empty page, not an error", async () => {
    const resp = await get("/api/readability/history?limit=2&offset=10");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.total).toBe(5);
    expect(body.count).toBe(0);
    expect(body.entries).toEqual([]);
    // Trend still describes the whole history.
    expect(body.trend.count).toBe(5);
  });

  test("limit clamps into 1..200 and echoes the resolved bound", async () => {
    const zero = await get("/api/readability/history?limit=0");
    expect(zero.status).toBe(200);
    expect((await zero.json()).limit).toBe(1);

    const huge = await get("/api/readability/history?limit=999");
    expect(huge.status).toBe(200);
    expect((await huge.json()).limit).toBe(200);
  });

  test("non-numeric limit or offset is a 400", async () => {
    const badLimit = await get("/api/readability/history?limit=abc");
    expect(badLimit.status).toBe(400);
    const badOffset = await get("/api/readability/history?offset=xyz");
    expect(badOffset.status).toBe(400);
    const negative = await get("/api/readability/history?offset=-3");
    expect(negative.status).toBe(400);
  });
});

describe("openapi.yaml registration", () => {
  const spec = () => readFileSync(join(process.cwd(), "openapi.yaml"), "utf-8");

  test("both wave-2 paths are registered", () => {
    const text = spec();
    expect(text).toContain("  /api/geo-observations:");
    expect(text).toContain("  /api/readability/history:");
    expect(text).toContain("operationId: getGeoObservations");
    expect(text).toContain("operationId: getReadabilityHistory");
  });

  test("the spec version is bumped to 2.7.0", () => {
    expect(spec()).toContain("  version: 2.7.0");
    expect(existsSync(join(process.cwd(), "src", "gui", "routes.ts"))).toBe(true);
  });
});

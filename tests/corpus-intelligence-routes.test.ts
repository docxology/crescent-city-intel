/**
 * Route contract for the corpus-intelligence surfaces added alongside
 * src/section_graph.ts, src/word_frequency.ts, src/section_longevity.ts, and
 * the previously CLI-only civic insights engine.
 *
 * These run against the real scraped corpus on this host, so they assert the
 * CONTRACT (shape, bounds, honest degradation) rather than specific counts —
 * the counts belong to the pure-module tests, which use fixtures.
 */
import { describe, expect, test } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.ts";
import { SECTION_GRAPH_SCHEMA } from "../src/section_graph.ts";
import { WORD_FREQUENCY_SCHEMA } from "../src/word_frequency.ts";
import { SECTION_LONGEVITY_SCHEMA } from "../src/section_longevity.ts";

const base = "http://localhost:3000";
const get = (path: string) => handleApiRoute(new URL(base + path));

describe("GET /api/sections/graph", () => {
  test("returns a bounded graph envelope with a self-consistent summary", async () => {
    const response = await get("/api/sections/graph?limit=5");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe(SECTION_GRAPH_SCHEMA);
    expect(body.nodes.length).toBeLessThanOrEqual(5);
    expect(body.edges.length).toBeLessThanOrEqual(5);
    expect(body.summary.nodes).toBeGreaterThanOrEqual(body.nodes.length);
    expect(body.summary.density).toBeGreaterThanOrEqual(0);
    expect(body.summary.density).toBeLessThanOrEqual(1);
    expect(body.summary.resolutionRate).toBeGreaterThanOrEqual(0);
    expect(body.summary.resolutionRate).toBeLessThanOrEqual(1);
    expect(body.summary.largestComponentSize).toBeLessThanOrEqual(body.summary.nodes);
    expect(body.focus).toBeNull();
  });

  test("an unknown focus guid is a 400, never a 500", async () => {
    const response = await get("/api/sections/graph?guid=definitely-not-a-guid");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Unknown section guid");
  });

  test("a title filter narrows the graph without emptying it", async () => {
    const all = await (await get("/api/sections/graph?limit=1")).json();
    const scoped = await (await get("/api/sections/graph?title=8&limit=1")).json();
    expect(scoped.summary.nodes).toBeLessThan(all.summary.nodes);
    // "<= all" alone passes when the filter matches nothing, which is exactly
    // how the marker-comparison defect hid: every filter returned 0 sections.
    expect(scoped.summary.nodes).toBeGreaterThan(0);
  });

  test("the real corpus resolves citations — an all-dangling graph is a defect, not a finding", async () => {
    const body = await (await get("/api/sections/graph?limit=1")).json();
    // Section numbers are stored with a marker ("§ 8.04.010") and citations are
    // bare; comparing them raw made every citation dangle and every degree zero.
    // See tests/section-number-normalization.test.ts.
    expect(body.summary.citations).toBeGreaterThan(0);
    expect(body.summary.edges).toBeGreaterThan(0);
    expect(body.summary.resolutionRate).toBeGreaterThan(0);
    expect(body.summary.largestComponentSize).toBeGreaterThan(1);
  });
});

describe("GET /api/sections/longevity", () => {
  test("returns a reproducible profile pinned to asOfYear", async () => {
    const response = await get("/api/sections/longevity?limit=3&asOfYear=2020");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe(SECTION_LONGEVITY_SCHEMA);
    expect(body.asOfYear).toBe(2020);
    expect(body.oldest.length).toBeLessThanOrEqual(3);
    expect(body.summary.sectionsScanned).toBe(body.summary.withHistory + body.summary.withoutHistory);
    // The histogram is contiguous by decade.
    for (let i = 1; i < body.byDecade.length; i++) {
      expect(body.byDecade[i].decade - body.byDecade[i - 1].decade).toBe(10);
    }
  });

  test("an out-of-range asOfYear falls back to the default rather than being honoured", async () => {
    const body = await (await get("/api/sections/longevity?limit=1&asOfYear=99999")).json();
    expect(body.asOfYear).toBe(new Date().getUTCFullYear());
  });
});

describe("GET /api/lexicon/frequency", () => {
  test("returns both rankings with a bounded size", async () => {
    const response = await get("/api/lexicon/frequency?limit=4");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaVersion).toBe(WORD_FREQUENCY_SCHEMA);
    expect(body.topByFrequency.length).toBeLessThanOrEqual(4);
    expect(body.topBySalience.length).toBeLessThanOrEqual(4);
    for (const entry of body.topByFrequency) {
      expect(entry.count).toBeGreaterThan(0);
      expect(entry.documentFrequency).toBeGreaterThan(0);
      expect(entry.documentFrequency).toBeLessThanOrEqual(body.summary.sectionsScanned);
    }
    // Frequency ranking is non-increasing.
    const counts = body.topByFrequency.map((t: { count: number }) => t.count);
    expect([...counts].sort((a: number, b: number) => b - a)).toEqual(counts);
  });
});

describe("GET /api/insights", () => {
  test("serves a labelled civic insight report", async () => {
    const response = await get("/api/insights");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(["persisted", "computed"]).toContain(body.source);
    expect(body.schemaVersion).toBe("crescent-city-civic-insights/v1");
    expect(Array.isArray(body.trends)).toBe(true);
    expect(Array.isArray(body.coverageGaps)).toBe(true);
    expect(body.narrative).toHaveProperty("status");
  });

  test("a window override forces a computed report and is clamped", async () => {
    const body = await (await get("/api/insights?window=9999")).json();
    expect(body.source).toBe("computed");
    expect(body.windowDays).toBe(365);
    // A GET never triggers LLM polish.
    expect(body.narrative.requested).toBe(false);
  });
});

describe("GET /api/llm/models", () => {
  test("always lists the configured model, degrading honestly when unreachable", async () => {
    const response = await get("/api/llm/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(["ollama", "openrouter"]).toContain(body.provider);
    expect(body.configured).toBeTruthy();
    expect(["ok", "unavailable"]).toContain(body.status);
    expect(body.models).toContain(body.configured);
    expect(body.count).toBe(body.models.length);
    // An external catalogue must not decide this endpoint's payload size.
    expect(body.models.length).toBeLessThanOrEqual(200);
    expect(body.totalAvailable).toBeGreaterThanOrEqual(body.count);
    expect(body.truncated).toBe(body.totalAvailable > body.count);
    expect(JSON.stringify(body)).not.toMatch(/sk-[A-Za-z0-9]{8}/);
  });
});

/**
 * GUI string contracts for the panels that surface these routes. The local GUI
 * is a no-build single file, so a string contract is the only deterministic
 * assertion available offline; the live path is covered by
 * `bun run test:browser`.
 */
describe("GUI corpus-intelligence panels", () => {
  test("the analytics overlay exposes graph, lexicon, and longevity panels", async () => {
    const html = await Bun.file("src/gui/static/index.html").text();
    for (const marker of [
      'data-tab="graph"',
      'data-tab="lexicon"',
      'data-tab="longevity"',
      'id="intel-graph"',
      'id="intel-lexicon"',
      'id="intel-longevity"',
      "loadSectionGraphPanel",
      "loadLexiconPanel",
      "loadLongevityPanel",
      "/api/sections/graph?",
      "/api/lexicon/frequency?",
      "/api/sections/longevity?",
      "egoNetworkSvg",
      "decadeHistogram",
      'data-tab="chronology"',
      'id="intel-chronology"',
      "loadChronologyPanel",
      "ordinanceTimeline",
      "/api/ordinance/chronology?",
    ]) {
      expect(html).toContain(marker);
    }
  });

  test("the feeds overlay exposes the civic insight brief", async () => {
    const html = await Bun.file("src/gui/static/index.html").text();
    expect(html).toContain('data-tab="insights"');
    expect(html).toContain('id="intel-insights"');
    expect(html).toContain("loadInsightsPanel");
    expect(html).toContain("/api/insights");
  });

  test("chat carries a model picker wired to both the streaming and fallback paths", async () => {
    const html = await Bun.file("src/gui/static/index.html").text();
    expect(html).toContain('id="chat-model"');
    expect(html).toContain("loadChatModels");
    expect(html).toContain("/api/llm/models");
    expect(html).toContain("chatRequestBody(msg)");
    expect(html).toContain("chatSelectedModel()");
    // The default must send no `model` field at all, not an empty string.
    expect(html).toContain("if (model) body.model = model;");
  });
});

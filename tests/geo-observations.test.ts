/**
 * Tests for the GEO-INFER hazard-observation interface
 * (`crescent-city-geo-observations/v1`) and the check-geo-sync drift guard.
 *
 * Deterministic and offline: the builder is exercised with plain fixtures,
 * the sync-check comparisons run against tmp files under output/state/ (the
 * output-corpus fence), and the runner smoke test redirects both the Pages
 * seed dir and CC_OUTPUT_DIR into that same fenced tmp tree.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_OBSERVATION_ANCHOR,
  GEO_INTEL_CONTRACT_SCHEMA,
  GEO_OBSERVATIONS_SCHEMA,
  buildHazardObservations,
  hazardTagSummary,
  monitorId,
  normalizeCompositeSnapshot,
  normalizeMonitorObservation,
  type GeoObservationInput,
} from "../src/geo_observations";
import { STABLE_CONTRACT_FIELDS, compareBundledCopy, compareRebuiltContract } from "../scripts/check-geo-sync.ts";
import { geoObservationPaths, runGeoObservations } from "../scripts/run-geo-observations.ts";
import type { SourceHealth } from "../src/types";
import { buildMunicipalityContract, getDefaultCrescentSpec } from "../src/geo";

const fencedDir = join(process.cwd(), "output", "state", "geo-observations-test");
const seedDir = join(fencedDir, "pages-data");
const outDir = join(fencedDir, "output");

const GENERATED_AT = "2026-09-08T00:00:00.000Z";

/** Small inline hazard subset mirroring the contract's hazard.relevantDomains. */
const FIXTURE_HAZARD_DOMAINS = [
  {
    id: "emergency-management",
    name: "Emergency Management",
    hazardTags: ["tsunami", "seismic"],
    topics: [
      { tags: ["tsunami", "seismic"] },
      { tags: ["flood"] },
    ],
  },
  {
    id: "environmental-protection",
    name: "Environmental Protection",
    topics: [
      { tags: ["sea level", "erosion"] },
      { tags: ["erosion"] },
    ],
  },
];

/**
 * Build a SourceHealth fixture. Deliberately-invalid runtime shapes (status
 * casing, non-string status) are cast once at the boundary with a reason:
 * the normalization defends the JSON artifact boundary, which typed values
 * cannot express.
 */
function healthFixture(record: Record<string, unknown>): SourceHealth {
  return record as unknown as SourceHealth;
}

function baseInput(overrides: Partial<GeoObservationInput> = {}): GeoObservationInput {
  return {
    anchor: DEFAULT_OBSERVATION_ANCHOR,
    generatedAt: GENERATED_AT,
    composite: null,
    monitors: [],
    hazardDomains: FIXTURE_HAZARD_DOMAINS,
    contractGeneratedAt: null,
    ...overrides,
  };
}

beforeAll(() => {
  rmSync(fencedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
});

afterAll(() => {
  rmSync(fencedDir, { recursive: true, force: true });
});

describe("buildHazardObservations envelope", () => {
  test("emits the registered schema id and literal freshness contract schema", () => {
    const envelope = buildHazardObservations(baseInput({
      composite: { level: "WATCH", reason: "Gale warning", assessedAt: GENERATED_AT, hasUnavailableMonitors: false },
      contractGeneratedAt: "2026-08-24T15:42:41.522Z",
    }));
    expect(envelope.schema).toBe("crescent-city-geo-observations/v1");
    expect(envelope.schema).toBe(GEO_OBSERVATIONS_SCHEMA);
    expect(envelope.freshness.contractSchema).toBe("crescent-city-geo-intel/v1");
    expect(envelope.freshness.contractSchema).toBe(GEO_INTEL_CONTRACT_SCHEMA);
    expect(envelope.freshness.contractGeneratedAt).toBe("2026-08-24T15:42:41.522Z");
    expect(envelope.generatedAt).toBe(GENERATED_AT);
  });

  test("carries the geo-intel anchor shape (point identity, no bounds)", () => {
    const envelope = buildHazardObservations(baseInput());
    expect(envelope.anchor).toEqual({
      name: "Crescent City",
      guid: "CR4919",
      municipality: "Crescent City, CA",
      county: "Del Norte County",
      state: "California",
      latitude: 41.76,
      longitude: -124.2,
    });
  });

  test("absent artifacts surface as honest empty states, never invented values", () => {
    const envelope = buildHazardObservations(baseInput());
    expect(envelope.composite).toBeNull();
    expect(envelope.monitors).toEqual([]);
    expect(envelope.freshness.contractGeneratedAt).toBeNull();
    // Hazard summary still aggregates whatever the contract subset provides.
    expect(envelope.hazardSummary.length).toBeGreaterThan(0);
  });

  test("JSON-safe: round-trips through stringify without loss", () => {
    const envelope = buildHazardObservations(baseInput({
      monitors: [{ id: "nws-weather", label: "NWS Weather", status: "ok", checkedAt: GENERATED_AT, itemCount: 2 }],
    }));
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});

describe("monitor entry normalization", () => {
  test("lower-cases known statuses and degrades unknown ones to unavailable", () => {
    expect(normalizeMonitorObservation(healthFixture({ source: "NWS Weather", status: "OK", checkedAt: GENERATED_AT, itemCount: 1 })).status).toBe("ok");
    expect(normalizeMonitorObservation(healthFixture({ source: "NDBC Marine", status: "EMPTY", checkedAt: GENERATED_AT, itemCount: 0 })).status).toBe("empty");
    expect(normalizeMonitorObservation(healthFixture({ source: "X", status: "Totally Bogus", checkedAt: GENERATED_AT, itemCount: 0 })).status).toBe("unavailable");
    expect(normalizeMonitorObservation(healthFixture({ source: "X", status: 42, checkedAt: GENERATED_AT, itemCount: 0 })).status).toBe("unavailable");
  });

  test("rounds ageMs to whole milliseconds and omits absent optionals", () => {
    const entry = normalizeMonitorObservation({
      source: "USGS Earthquake", status: "ok", checkedAt: GENERATED_AT, ageMs: 1499.6, itemCount: 3,
      url: "https://earthquake.usgs.gov/feed", freshness: "fresh",
    });
    expect(entry.ageMs).toBe(1500);
    expect(entry.itemCount).toBe(3);
    expect(entry.url).toBe("https://earthquake.usgs.gov/feed");
    const sparse = normalizeMonitorObservation({ source: "NOAA Tides", status: "stale", checkedAt: GENERATED_AT, itemCount: 0 });
    expect(sparse.ageMs).toBeUndefined();
    expect(sparse.itemCount).toBe(0);
    expect(sparse.url).toBeUndefined();
    expect(sparse.checkedAt).toBe(GENERATED_AT);
  });

  test("derives stable slug ids from source labels", () => {
    expect(monitorId("NWS Weather")).toBe("nws-weather");
    expect(monitorId("CAL FIRE Wildfire")).toBe("cal-fire-wildfire");
    const entry = normalizeMonitorObservation({ source: "NOAA Tsunami", status: "ok", checkedAt: GENERATED_AT, itemCount: 0 });
    expect(entry.id).toBe("noaa-tsunami");
    expect(entry.label).toBe("NOAA Tsunami");
  });
});

describe("composite snapshot normalization", () => {
  test("null for absent, corrupt, or level-less artifacts", () => {
    expect(normalizeCompositeSnapshot(null)).toBeNull();
    expect(normalizeCompositeSnapshot(undefined)).toBeNull();
    expect(normalizeCompositeSnapshot("CALM")).toBeNull();
    expect(normalizeCompositeSnapshot({})).toBeNull();
    expect(normalizeCompositeSnapshot({ reason: "no level" })).toBeNull();
  });

  test("keeps the four envelope fields and drops extras like healer", () => {
    const snapshot = normalizeCompositeSnapshot({
      level: "WARNING", reason: "High surf", assessedAt: GENERATED_AT,
      hasUnavailableMonitors: true, healer: { lastCycleRun: GENERATED_AT, monitorsRetried: [], monitorsRecovered: [], monitorsWithFailures: 1 },
      monitors: [{ source: "x" }],
    });
    expect(snapshot).toEqual({ level: "WARNING", reason: "High surf", assessedAt: GENERATED_AT, hasUnavailableMonitors: true });
  });

  test("missing assessedAt / hasUnavailableMonitors become honest defaults", () => {
    expect(normalizeCompositeSnapshot({ level: "CALM" })).toEqual({
      level: "CALM", reason: "", assessedAt: null, hasUnavailableMonitors: false,
    });
  });
});

describe("hazard summary aggregation", () => {
  test("aggregates domain and topic counts per tag, sorted by tag", () => {
    expect(hazardTagSummary(FIXTURE_HAZARD_DOMAINS)).toEqual([
      { tag: "erosion", domainCount: 1, topicCount: 2 },
      { tag: "flood", domainCount: 1, topicCount: 1 },
      { tag: "sea level", domainCount: 1, topicCount: 1 },
      { tag: "seismic", domainCount: 1, topicCount: 1 },
      { tag: "tsunami", domainCount: 1, topicCount: 1 },
    ]);
  });

  test("counts domains referencing a tag via hazardTags even with no topics", () => {
    expect(hazardTagSummary([{ hazardTags: ["tsunami"] }, { hazardTags: ["tsunami", "storm"] }])).toEqual([
      { tag: "storm", domainCount: 1, topicCount: 0 },
      { tag: "tsunami", domainCount: 2, topicCount: 0 },
    ]);
  });

  test("empty subset aggregates to an empty summary", () => {
    expect(hazardTagSummary([])).toEqual([]);
  });
});

describe("check-geo-sync comparison logic", () => {
  test("rebuild check matches when the seed equals the builder output", () => {
    const rebuilt = buildMunicipalityContract(getDefaultCrescentSpec());
    const comparison = compareRebuiltContract(rebuilt, JSON.parse(JSON.stringify(rebuilt)));
    expect(comparison.matches).toBe(true);
    expect(comparison.differingFields).toEqual([]);
  });

  test("rebuild check ignores generatedAt (clock-stamped) drift", () => {
    const rebuilt = buildMunicipalityContract(getDefaultCrescentSpec());
    const seeded = JSON.parse(JSON.stringify(rebuilt));
    seeded.generatedAt = "1999-01-01T00:00:00.000Z";
    expect(compareRebuiltContract(rebuilt, seeded).matches).toBe(true);
    expect(STABLE_CONTRACT_FIELDS).not.toContain("generatedAt");
  });

  test("rebuild check detects stable-field drift", () => {
    const rebuilt = buildMunicipalityContract(getDefaultCrescentSpec());
    const seeded = JSON.parse(JSON.stringify(rebuilt));
    seeded.domainCount = 99;
    (seeded.anchor as Record<string, unknown>).latitude = 0;
    const comparison = compareRebuiltContract(rebuilt, seeded);
    expect(comparison.matches).toBe(false);
    expect(comparison.differingFields).toEqual(["anchor", "domainCount"]);
  });

  test("bundled copy comparison: identical bytes on tmp files", async () => {
    const rebuilt = buildMunicipalityContract(getDefaultCrescentSpec());
    const text = `${JSON.stringify(rebuilt, null, 2)}\n`;
    const seedPath = join(fencedDir, "identical-seed.json");
    const bundledPath = join(fencedDir, "identical-bundled.json");
    writeFileSync(seedPath, text);
    writeFileSync(bundledPath, text);
    const comparison = await compareBundledCopy(readFileSync(seedPath, "utf-8"), readFileSync(bundledPath, "utf-8"));
    expect(comparison.identical).toBe(true);
    expect(comparison.shaSeed).toBe(comparison.shaBundled);
    expect(comparison.shaSeed).toMatch(/^[0-9a-f]{64}$/);
  });

  test("bundled copy comparison: drift reports both sha256s and a non-identical verdict", async () => {
    const seedPath = join(fencedDir, "drift-seed.json");
    const bundledPath = join(fencedDir, "drift-bundled.json");
    writeFileSync(seedPath, '{"schema":"crescent-city-geo-intel/v1"}\n');
    writeFileSync(bundledPath, '{"schema":"crescent-city-geo-intel/v1","extra":true}\n');
    const comparison = await compareBundledCopy(readFileSync(seedPath, "utf-8"), readFileSync(bundledPath, "utf-8"));
    expect(comparison.identical).toBe(false);
    expect(comparison.shaSeed).not.toBe(comparison.shaBundled);
    expect(comparison.shaSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(comparison.shaBundled).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("run-geo-observations thin runner", () => {
  // Bun runs every test file in ONE process: these two tests set CC_OUTPUT_DIR
  // and PAGES_SEED_DIR inline, so without this restore the env leaks into every
  // later file (shared-paths.test.ts pinned output/ and failed suite-wide).
  afterAll(() => {
    delete process.env.CC_OUTPUT_DIR;
    delete process.env.PAGES_SEED_DIR;
  });
  test("writes both exports from real artifact fixtures, empty-state on missing inputs", async () => {
    process.env.PAGES_SEED_DIR = seedDir;
    process.env.CC_OUTPUT_DIR = outDir;

    // A real contract seed (only the fields the runner reads) + absent alert artifacts.
    const contract = buildMunicipalityContract(getDefaultCrescentSpec());
    writeFileSync(join(seedDir, "geo-intel.json"), JSON.stringify(contract, null, 2));

    const written = await runGeoObservations();

    expect(written).toEqual([geoObservationPaths.pagesSeed, geoObservationPaths.liveExport]);
    const envelope = JSON.parse(readFileSync(join(seedDir, "geo-observations.json"), "utf-8"));
    expect(envelope.schema).toBe("crescent-city-geo-observations/v1");
    expect(envelope.anchor.name).toBe("Crescent City");
    expect(envelope.composite).toBeNull();
    expect(envelope.monitors).toEqual([]);
    expect(envelope.hazardSummary.length).toBeGreaterThan(0);

    // Live export is the same envelope.
    const live = JSON.parse(readFileSync(join(outDir, "geo-observations.json"), "utf-8"));
    expect(live).toEqual(envelope);
  });

  test("normalizes real composite + source-health fixtures into the envelope", async () => {
    process.env.PAGES_SEED_DIR = seedDir;
    process.env.CC_OUTPUT_DIR = outDir;

    const alertsDir = join(outDir, "alerts");
    mkdirSync(join(alertsDir, "composite"), { recursive: true });
    writeFileSync(
      join(alertsDir, "composite", "current.json"),
      JSON.stringify({ level: "WATCH", reason: "Small craft advisory", assessedAt: GENERATED_AT, hasUnavailableMonitors: false }),
    );
    writeFileSync(
      join(alertsDir, "source-health.json"),
      JSON.stringify({
        checkedAt: GENERATED_AT,
        sources: [
          { source: "NOAA Tsunami", status: "OK", checkedAt: GENERATED_AT, itemCount: 0, url: "https://api.weather.gov/alerts/active?area=CA", ageMs: 2500.4 },
          { source: "NWS Weather", status: "WEIRD", checkedAt: GENERATED_AT, itemCount: 2 },
        ],
      }),
    );

    await runGeoObservations();
    const envelope = JSON.parse(readFileSync(join(seedDir, "geo-observations.json"), "utf-8"));

    expect(envelope.composite).toEqual({
      level: "WATCH", reason: "Small craft advisory", assessedAt: GENERATED_AT, hasUnavailableMonitors: false,
    });
    expect(envelope.monitors).toEqual([
      { id: "noaa-tsunami", label: "NOAA Tsunami", status: "ok", checkedAt: GENERATED_AT, itemCount: 0, ageMs: 2500, url: "https://api.weather.gov/alerts/active?area=CA" },
      { id: "nws-weather", label: "NWS Weather", status: "unavailable", checkedAt: GENERATED_AT, itemCount: 2 },
    ]);
  });
});

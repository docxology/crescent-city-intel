/**
 * Tests for buildExtendedMonitorDefinitions - the pure builder that turns the
 * runner's settled results into typed SourceHealth definitions for the extended
 * monitors (the five Phase-12 monitors plus the NWS marine forecast).
 *
 * Zero-mock policy: real arrays, real settled results, real edge shapes.
 * The url/provenance/spec triples are asserted against the live spec table so
 * a spec edit that changes provenance wording is a deliberate, reviewed act.
 */
import { describe, test, expect } from "bun:test";
import {
  buildExtendedMonitorDefinitions,
  EXTENDED_MONITOR_SPECS,
  MONITOR_KEYS,
  type MonitorKey,
} from "../src/alerts/composite.ts";

function settled<T>(value: T, status: "fulfilled" | "rejected" = "fulfilled"): PromiseSettledResult<T> {
  return status === "fulfilled" ? { status, value } : { status, reason: new Error("boom") };
}

/** An all-rejected baseline, keyed by monitor (the 8 core + 6 extended). */
function baseline(): Record<MonitorKey, PromiseSettledResult<unknown>> {
  return Object.fromEntries(MONITOR_KEYS.map(key => [key, settled(null, "rejected")])) as Record<MonitorKey, PromiseSettledResult<unknown>>;
}

describe("EXTENDED_MONITOR_SPECS", () => {
  test("covers exactly the six extended monitors, by key", () => {
    // Keys, not positions: a monitor's identity used to be where it sat in the
    // runner's array, restated by hand in five places across three files.
    expect(EXTENDED_MONITOR_SPECS.map(spec => spec[1])).toEqual(["drought", "psps", "smoke", "roads", "schools", "marinezone"]);
    expect(EXTENDED_MONITOR_SPECS.map(spec => spec[0])).toEqual([
      "USDM Drought", "PG&E PSPS", "HRRR Smoke", "Caltrans Roads", "DUSD Schools", "NWS Marine Forecast",
    ]);
    for (const [, key] of EXTENDED_MONITOR_SPECS) expect(MONITOR_KEYS).toContain(key);
  });

  test("every spec url is an https endpoint and carries a provenance string", () => {
    for (const [, , , url, provenance] of EXTENDED_MONITOR_SPECS) {
      expect(url.startsWith("https://")).toBe(true);
      expect(provenance.length).toBeGreaterThan(5);
    }
  });
});

describe("buildExtendedMonitorDefinitions", () => {
  test("a rejected result yields an unavailable-source definition with a null report", () => {
    const defs = buildExtendedMonitorDefinitions(baseline());
    expect(defs.length).toBe(6);
    for (const def of defs) {
      expect(def.report).toBeNull();
      expect(def.itemCount).toBe(0);
    }
  });

  test("array list fields count their elements", () => {
    const results = baseline();
    results.drought = settled({ readings: [{ fips: "06015" }, { fips: "06015" }] });
    results.roads = settled({ incidents: [{ id: 1 }] });
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.key === "drought")?.itemCount).toBe(2);
    expect(defs.find(d => d.key === "roads")?.itemCount).toBe(1);
  });

  test("a non-array truthy value (smoke forecast object) counts as exactly 1", () => {
    const results = baseline();
    results.smoke = settled({ forecast: { maxPm25: 4.2 } });
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.key === "smoke")?.itemCount).toBe(1);
  });

  test("a report whose list field is missing or null counts as 0, not a crash", () => {
    const results = baseline();
    results.psps = settled({ events: null });
    results.schools = settled({});
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.key === "psps")?.itemCount).toBe(0);
    expect(defs.find(d => d.key === "schools")?.itemCount).toBe(0);
  });

  test("definitions carry the spec url and provenance verbatim", () => {
    const defs = buildExtendedMonitorDefinitions(baseline());
    for (const [i, def] of defs.entries()) {
      const spec = EXTENDED_MONITOR_SPECS[i];
      expect(def.url).toBe(spec[3]);
      expect(def.provenance).toBe(spec[4]);
      expect(def.source).toBe(spec[0]);
      expect(def.key).toBe(spec[1]);
    }
  });
});

describe("monitor identity survives a change to the batch order", () => {
  test("each definition resolves to its OWN monitor's result", () => {
    const results = baseline();
    results.drought = settled({ readings: [{ fips: "06015" }] });
    results.psps = settled({ events: [{ id: "a" }, { id: "b" }] });
    results.smoke = settled({ forecast: { maxPm25: 9 } });
    results.roads = settled({ incidents: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    results.schools = settled({ items: [{ id: "x" }] });
    const counts = Object.fromEntries(buildExtendedMonitorDefinitions(results).map(def => [def.key, def.itemCount]));
    expect(counts).toEqual({ drought: 1, psps: 2, smoke: 1, roads: 3, schools: 1, marinezone: 0 });
  });

  test("inserting a monitor cannot shift another monitor's data", () => {
    // The defect this replaces: results were addressed by array position, so a
    // new monitor inserted mid-batch silently handed its neighbour's result to
    // the wrong health record. With keys, an extra entry changes nothing.
    const results = baseline();
    results.roads = settled({ incidents: [{ id: 1 }, { id: 2 }] });
    const before = buildExtendedMonitorDefinitions(results);
    const withSentinel = { ...results, sentinel: settled({ incidents: [{ id: 99 }] }) } as typeof results;
    const after = buildExtendedMonitorDefinitions(withSentinel);
    expect(after.map(def => [def.key, def.itemCount])).toEqual(before.map(def => [def.key, def.itemCount]));
    expect(after.find(def => def.key === "roads")?.itemCount).toBe(2);
  });

  test("a monitor with no result at all is unavailable, not another monitor's data", () => {
    const results = baseline();
    delete (results as Record<string, unknown>).roads;
    const defs = buildExtendedMonitorDefinitions(results);
    const roads = defs.find(def => def.key === "roads");
    expect(roads?.report).toBeNull();
    expect(roads?.itemCount).toBe(0);
  });
});

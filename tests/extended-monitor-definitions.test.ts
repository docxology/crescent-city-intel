/**
 * Tests for buildExtendedMonitorDefinitions - the pure builder that turns the
 * runner's settled results into typed SourceHealth definitions for the five
 * Phase-12 extended monitors.
 *
 * Zero-mock policy: real arrays, real settled results, real edge shapes.
 * The url/provenance/spec triples are asserted against the live spec table so
 * a spec edit that changes provenance wording is a deliberate, reviewed act.
 */
import { describe, test, expect } from "bun:test";
import {
  buildExtendedMonitorDefinitions,
  EXTENDED_MONITOR_SPECS,
} from "../src/alerts/composite.ts";

function settled<T>(value: T, status: "fulfilled" | "rejected" = "fulfilled"): PromiseSettledResult<T> {
  return status === "fulfilled" ? { status, value } : { status, reason: new Error("boom") };
}

/** 13-slot all-rejected baseline (the 8 core + 5 extended monitor batch). */
function baseline(): Array<PromiseSettledResult<unknown>> {
  return Array.from({ length: 13 }, () => settled(null, "rejected"));
}

describe("EXTENDED_MONITOR_SPECS", () => {
  test("covers exactly the five extended monitors at indices 8-12", () => {
    expect(EXTENDED_MONITOR_SPECS.map(s => s[1])).toEqual([8, 9, 10, 11, 12]);
    expect(EXTENDED_MONITOR_SPECS.map(s => s[0])).toEqual([
      "USDM Drought", "PG&E PSPS", "HRRR Smoke", "Caltrans Roads", "DUSD Schools",
    ]);
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
    expect(defs.length).toBe(5);
    for (const def of defs) {
      expect(def.report).toBeNull();
      expect(def.itemCount).toBe(0);
    }
  });

  test("array list fields count their elements", () => {
    const results = baseline();
    results[8] = settled({ readings: [{ fips: "06015" }, { fips: "06015" }] });
    results[11] = settled({ incidents: [{ id: 1 }] });
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.index === 8)?.itemCount).toBe(2);
    expect(defs.find(d => d.index === 11)?.itemCount).toBe(1);
  });

  test("a non-array truthy value (smoke forecast object) counts as exactly 1", () => {
    const results = baseline();
    results[10] = settled({ forecast: { maxPm25: 4.2 } });
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.index === 10)?.itemCount).toBe(1);
  });

  test("a report whose list field is missing or null counts as 0, not a crash", () => {
    const results = baseline();
    results[9] = settled({ events: null });
    results[12] = settled({});
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.index === 9)?.itemCount).toBe(0);
    expect(defs.find(d => d.index === 12)?.itemCount).toBe(0);
  });

  test("definitions carry the spec url and provenance verbatim", () => {
    const defs = buildExtendedMonitorDefinitions(baseline());
    for (const [i, def] of defs.entries()) {
      const spec = EXTENDED_MONITOR_SPECS[i];
      expect(def.url).toBe(spec[3]);
      expect(def.provenance).toBe(spec[4]);
      expect(def.source).toBe(spec[0]);
      expect(def.index).toBe(spec[1]);
    }
  });
});

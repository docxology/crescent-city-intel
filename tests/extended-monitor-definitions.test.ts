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
import type { DroughtReport } from "../src/alerts/usdm_drought.ts";
import type { PspsReport } from "../src/alerts/pge_psps.ts";
import { buildHmsSmokeReport, type SmokeReport } from "../src/alerts/hrrr_smoke.ts";
import type { RoadClosureReport } from "../src/alerts/caltrans_roads.ts";
import type { SchoolClosureReport } from "../src/alerts/dusd_schools.ts";
import type { MarineZoneForecast } from "../src/alerts/nws_marine.ts";
import type { UscgBroadcastReport } from "../src/alerts/uscg_broadcasts.ts";
import type { PermitsReport } from "../src/alerts/permits.ts";
import type { DredgingReport } from "../src/alerts/dredging.ts";
import type { FuelReport } from "../src/alerts/fuel.ts";
import type { PacfinMonitorReport } from "../src/alerts/pacfin.ts";
import type { AisReport } from "../src/alerts/ais.ts";

function settled<T>(value: T, status: "fulfilled" | "rejected" = "fulfilled"): PromiseSettledResult<T> {
  return status === "fulfilled" ? { status, value } : { status, reason: new Error("boom") };
}

/**
 * Real report objects, typed against each monitor's own exported interface.
 * The type annotations are load-bearing: `bunx tsc --noEmit` runs inside
 * `bun run validate`, so renaming `SmokeReport.forecasts` or
 * `SchoolClosureReport.events` fails the gate here rather than silently
 * zeroing that monitor's itemCount at runtime.
 */
function realDrought(): DroughtReport {
  return { timestamp: FIXED, readings: [{ fips: "06015", county: "Del Norte", state: "CA", severity: "D0", percent: 1 }], compositeSeverity: "D0", severeDroughtPercent: 0, summary: "s" };
}
function realPsps(): PspsReport {
  return { timestamp: FIXED, events: [], totalEvents: 0, overallStatus: "NONE", delNorteAffected: false, summary: "s" };
}
function realSmoke(): SmokeReport {
  return buildHmsSmokeReport({ mapDate: FIXED.slice(0, 10).replaceAll("-", ""), plumes: 0, maxDensity: "Unknown" }, FIXED);
}
function realRoads(): RoadClosureReport {
  return { timestamp: FIXED, incidents: [], totalIncidents: 0, delNorteIncidents: [], overallSeverity: "NONE", hasMajorClosure: false, summary: "s" };
}
function realSchools(): SchoolClosureReport {
  return { timestamp: FIXED, events: [], totalEvents: 0, districtStatus: "OPEN", hasActiveClosure: false, hasActiveDelay: false, summary: "s" };
}
function realMarineZone(): MarineZoneForecast {
  return { timestamp: FIXED, zone: "PZZ450", zoneTitle: "t", issuance: "i", office: "EKA", periods: [], peakWindKt: null, worstLevel: "CALM", worstPeriodName: null, summary: "s" };
}
function realUscg(): UscgBroadcastReport {
  return { fetchedAt: FIXED, sourceUrl: "https://www.navcen.uscg.gov/", windowDays: 7, totalBroadcasts: 0, items: [], relevantCount: 0, worstLevel: "CALM", summary: "s" };
}
function realPermits(): PermitsReport {
  return { fetchedAt: FIXED, sourceUrl: "https://public.mygov.us/crescent_city_ca/module?module=pi", permits: [{ id: "2108", name: "Over the Counter Permit", category: "Over the Counter Permit", department: "Building Department", description: "d", applyUrl: "", applyRequiresLogin: true }], catalogSize: 1, changedEntries: [], catalogHash: "h", worstLevel: "CALM", summary: "s" };
}
function realDredging(): DredgingReport {
  return { fetchedAt: FIXED, sourceUrl: "https://www.ccharbor.com/sitemap.xml", windowDays: 90, totalUrls: 10, items: [], relevantCount: 0, worstLevel: "CALM", summary: "s" };
}
function realFuel(): FuelReport {
  return { fetchedAt: FIXED, sourceUrl: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=EMM_EPM0_PTE_SCA_DPG&f=W", latest: { weekOf: FIXED, pricePerGallon: 4.2 }, previousWeeks: [{ weekOf: FIXED, pricePerGallon: 4.1 }], medianPrice: 4.1, deltaVsMedian: 0.02, worstLevel: "CALM", scopeNote: "s", summary: "s" };
}
function realPacfin(): PacfinMonitorReport {
  return { fetchedAt: FIXED, sourceUrl: "https://reports.psmfc.org/pacfin/", reports: [{ id: "2", label: "ALL001 - ALL001 WOC All Species", categoryPath: "All Species Reports (ALL)", tooltip: "t" }], reportCount: 1, changedReports: [], landingDataAvailable: false, limitation: "l", worstLevel: "CALM", summary: "s" };
}
function realAis(): AisReport {
  return { fetchedAt: FIXED, sourceUrl: "https://meri.digitraffic.fi/api/ais/v1/locations", feedName: "digitraffic open AIS", vesselsObserved: 3, vesselsInWatchArea: [], coversDelNorteWaters: false, worstLevel: "CALM", summary: "s" };
}

const FIXED = "2026-09-26T12:00:00.000Z";

/** An all-rejected baseline, keyed by monitor (the 8 core + 7 extended). */
function baseline(): Record<MonitorKey, PromiseSettledResult<unknown>> {
  return Object.fromEntries(MONITOR_KEYS.map(key => [key, settled(null, "rejected")])) as Record<MonitorKey, PromiseSettledResult<unknown>>;
}

describe("EXTENDED_MONITOR_SPECS", () => {
  test("covers exactly the twelve extended monitors, by key", () => {
    // Keys, not positions: a monitor's identity used to be where it sat in the
    // runner's array, restated by hand in five places across three files.
    expect(EXTENDED_MONITOR_SPECS.map(spec => spec[1])).toEqual([
      "drought", "psps", "smoke", "roads", "schools", "marinezone", "uscg",
      "permits", "dredging", "fuel", "pacfin", "ais",
    ]);
    expect(EXTENDED_MONITOR_SPECS.map(spec => spec[0])).toEqual([
      "USDM Drought", "PG&E PSPS", "HRRR Smoke", "Caltrans Roads", "DUSD Schools", "NWS Marine Forecast", "USCG Broadcast Notice to Mariners",
      "Crescent City Permits Portal", "Crescent City Harbor District", "EIA California Fuel", "PacFIN Reports Dashboard", "AIS Vessel Traffic",
    ]);
    for (const [, key] of EXTENDED_MONITOR_SPECS) expect(MONITOR_KEYS).toContain(key);
  });

  test("every spec url is an https endpoint and carries a provenance string", () => {
    for (const [, , , url, provenance] of EXTENDED_MONITOR_SPECS) {
      expect(url.startsWith("https://")).toBe(true);
      expect(provenance.length).toBeGreaterThan(5);
    }
  });

  test("covers every extended monitor key, so the roster cannot silently shrink", () => {
    // The recurring defect in this repo: a monitor is in some lists and not
    // others. MONITOR_KEYS minus the 8 core keys IS the extended set, so assert
    // the spec table against that derivation rather than restating it.
    const CORE = ["tsunami", "earthquake", "weather", "airquality", "wildfire", "marine", "tides", "fishing"];
    const extended = MONITOR_KEYS.filter(key => !CORE.includes(key));
    expect(EXTENDED_MONITOR_SPECS.map(spec => spec[1]).sort()).toEqual([...extended].sort());
  });

  test("every spec listField names a real list on that monitor's own report interface", () => {
    // The defect this replaces: `smoke` and `schools` named a field that does
    // not exist on the monitor's report (`forecast` vs `forecasts`, `items` vs
    // `events`), so itemCount was permanently 0 for both — reported as `empty`,
    // which counts as *present*, while the monitor was actively emitting plumes
    // and closures. The test file itself fed fabricated shapes matching the spec,
    // so it agreed with the bug. Asserting against the real report interfaces
    // makes a renamed field fail here instead of silently zeroing coverage.
    const reportShapes: Record<string, () => object> = {
      drought: () => realDrought(),
      psps: () => realPsps(),
      smoke: () => realSmoke(),
      roads: () => realRoads(),
      schools: () => realSchools(),
      marinezone: () => realMarineZone(),
      uscg: () => realUscg(),
      permits: () => realPermits(),
      dredging: () => realDredging(),
      fuel: () => realFuel(),
      pacfin: () => realPacfin(),
      ais: () => realAis(),
    };
    for (const [, key, listField] of EXTENDED_MONITOR_SPECS) {
      const report = reportShapes[key]!() as Record<string, unknown>;
      expect(Array.isArray(report[listField])).toBe(true);
    }
  });
});

describe("buildExtendedMonitorDefinitions", () => {
  test("a rejected result yields an unavailable-source definition with a null report", () => {
    const defs = buildExtendedMonitorDefinitions(baseline());
    expect(defs.length).toBe(12);
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

  test("unsupported legacy smoke forecast payload does not count as current evidence", () => {
    const results = baseline();
    results.smoke = settled({ forecasts: { maxPm25: 4.2 } });
    const defs = buildExtendedMonitorDefinitions(results);
    expect(defs.find(d => d.key === "smoke")?.itemCount).toBe(0);
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
    results.smoke = settled(buildHmsSmokeReport({ mapDate: "20260930", maxDensity: "Light", plumes: 1 }, "2026-09-30T12:00:00Z"));
    results.roads = settled({ incidents: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    results.schools = settled({ events: [{ id: "x" }] });
    const counts = Object.fromEntries(buildExtendedMonitorDefinitions(results).map(def => [def.key, def.itemCount]));
    expect(counts).toEqual({ drought: 1, psps: 2, smoke: 1, roads: 3, schools: 1, marinezone: 0, uscg: 0, permits: 0, dredging: 0, fuel: 0, pacfin: 0, ais: 0 });
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

/**
 * Regression tests for scripts/run-alerts.ts's composite-severity input
 * mapping.
 *
 * Before 2026-07-24, tides/fishing were invoked via `m.runTidesMonitor?.()`/
 * `m.runFishingMonitor?.()` against function names that never existed on
 * those modules (real exports are `monitorTides`/`monitorFishing`), silently
 * no-op'd via optional chaining + an empty `.catch(() => {})`, and even when
 * run individually their real output never fed the composite severity
 * calculation — it was always seeded with static `{available:false}`/
 * `{closureActive:false}` stubs. These tests assert the pure mapping
 * functions (`buildTidesInput`/`buildFishingInput`) correctly reflect real
 * monitor report data, so this exact regression can't silently recur.
 */
import { describe, test, expect } from "bun:test";
import { buildTidesInput, buildFishingInput, buildExtendedCompositeInput } from "../src/alerts/composite.ts";
import type { TideReport } from "../src/alerts/noaa_tides.ts";
import { coopsUrl } from "../src/alerts/noaa_tides.ts";
import type { FishingReport } from "../src/alerts/cdfw_fishing.ts";

function makeTideReport(maxPredictedLevel: number, observedLevel: number | null = null): TideReport {
  return {
    fetchedAt: new Date().toISOString(),
    stationId: "9419750",
    stationName: "Crescent City, CA",
    predictions: [],
    waterLevel: observedLevel === null
      ? null
      : { v: observedLevel.toString(), t: new Date().toISOString(), s: "9419750" } as TideReport["waterLevel"],
    highTideAlert: maxPredictedLevel >= 5,
    maxPredictedLevel,
    alertThresholdFt: 5,
    summary: "test",
  };
}

/** The psps composite input, as `buildExtendedCompositeInput` shapes it. */
function buildPspsInput(report: { status: string; delNorteAffected: boolean }): { delNorteAffected: boolean } {
  return buildExtendedCompositeInput({
    psps: { timestamp: new Date().toISOString(), overallStatus: report.status, totalEvents: 2, delNorteAffected: report.delNorteAffected },
  }).psps as { delNorteAffected: boolean };
}

function makeFishingReport(commercialOpen: boolean, recreationalOpen: boolean): FishingReport {
  return {
    fetchedAt: new Date().toISOString(),
    crabStatus: {
      fetchedAt: new Date().toISOString(),
      commercialOpen,
      recreationalOpen,
      statusNote: "test status",
      sourceUrl: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins",
    },
    bulletins: [],
    summary: "test",
  };
}

describe("buildTidesInput", () => {
  test("a live sensor reading is reported as the current water level", () => {
    const input = buildTidesInput(makeTideReport(6.77, 6.9));
    expect(input.available).toBe(true);
    expect(input.waterLevelFt).toBe(6.9);
  });

  test("an ACTIVE PSPS in Del Norte is distinguishable from one that is not", () => {
    // The live path hardcoded `delNorteAffected: false`, which made the
    // composite's documented WARNING tier ("an active PSPS event *in Del
    // Norte*") unreachable, so an ACTIVE event in Crescent City rendered as a
    // regional WATCH. `pge_psps` now derives the flag from the event page and
    // reports `null` when the page carries no county list — "cannot tell",
    // which is materially different from "named counties, none of them ours".
    expect(buildPspsInput({ status: "ACTIVE", delNorteAffected: true }).delNorteAffected).toBe(true);
    expect(buildPspsInput({ status: "ACTIVE", delNorteAffected: false }).delNorteAffected).toBe(false);
  });

  test("a null report (monitor failed) produces available=false, not a crash", () => {
    const input = buildTidesInput(null);
    expect(input.available).toBe(false);
    expect(input.waterLevelFt).toBeNull();
  });

  test("a dead sensor is unavailable, never a 48-hour forecast maximum presented as current", () => {
    // The defect this replaces: with `waterLevel: null` (sensor offline, a
    // routine occurrence) the input fell back to `maxPredictedLevel` — the
    // maximum over the next 48 hours — and the composite published it as
    // "Water level 7.1 ft MLLW (significant exceedance)" while the report's own
    // summary said "max *predicted* water level". A 48-hour forecast high is
    // not a reading, and forecasting one as an observation is exactly the
    // false-calm/false-alarm class this repo treats as a correctness bug.
    const input = buildTidesInput(makeTideReport(7.1, null));
    expect(input.waterLevelFt).toBeNull();
    expect(input.available).toBe(false);
  });

  test("NOAA requests UTC and ambiguous legacy civil clocks cannot score as observations", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    for (const product of ["water_level", "predictions"]) expect(new URL(coopsUrl(product, "20261001", "20261002")).searchParams.get("time_zone")).toBe("gmt");
    const report = makeTideReport(7.1, 4.2);
    report.waterLevel!.t = "2026-10-01 11:54";
    expect(buildTidesInput(report, now)).toEqual({ waterLevelFt: null, available: false });
    report.timeZone = "UTC";
    expect(buildTidesInput(report, now)).toEqual({ waterLevelFt: 4.2, available: true });
    for (const time of ["2026-02-30 11:54", "2026-10-01 14:00", "2026-10-01 08:00", "2026-10-01T11:54:00", "2026-10-01T25:54:00Z"]) {
      report.waterLevel!.t = time;
      expect(buildTidesInput(report, now)).toEqual({ waterLevelFt: null, available: false });
    }
    report.waterLevel!.t = "2026-10-01 11:54";
    for (const value of ["", "0x10", "0b1000", "0o10", "Infinity", "1e2"]) {
      report.waterLevel!.v = value;
      expect(buildTidesInput(report, now)).toEqual({ waterLevelFt: null, available: false });
    }
    report.waterLevel!.v = "-0.25";
    expect(buildTidesInput(report, now)).toEqual({ waterLevelFt: -0.25, available: true });
  });
});

describe("buildFishingInput", () => {
  test("both seasons closed produces closureActive=true with the real status message", () => {
    const input = buildFishingInput(makeFishingReport(false, false));
    expect(input.closureActive).toBe(true);
    expect(input.closureMessage).toBe("test status");
  });

  test("either season closed still produces closureActive=true", () => {
    expect(buildFishingInput(makeFishingReport(true, false)).closureActive).toBe(true);
    expect(buildFishingInput(makeFishingReport(false, true)).closureActive).toBe(true);
  });

  test("both seasons open produces closureActive=false", () => {
    const input = buildFishingInput(makeFishingReport(true, true));
    expect(input.closureActive).toBe(false);
  });

  test("a null report (monitor failed) produces closureActive=false, not a crash", () => {
    const input = buildFishingInput(null);
    expect(input.closureActive).toBe(false);
    expect(input.closureMessage).toBeUndefined();
  });
});

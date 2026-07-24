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
import { buildTidesInput, buildFishingInput } from "../scripts/run-alerts.ts";
import type { TideReport } from "../src/alerts/noaa_tides.ts";
import type { FishingReport } from "../src/alerts/cdfw_fishing.ts";

function makeTideReport(maxPredictedLevel: number): TideReport {
  return {
    fetchedAt: new Date().toISOString(),
    stationId: "9419750",
    stationName: "Crescent City, CA",
    predictions: [],
    waterLevel: null,
    highTideAlert: maxPredictedLevel >= 5,
    maxPredictedLevel,
    alertThresholdFt: 5,
    summary: "test",
  };
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
  test("a real high-tide report produces available=true with the predicted level", () => {
    const input = buildTidesInput(makeTideReport(6.77));
    expect(input.available).toBe(true);
    expect(input.waterLevelFt).toBe(6.77);
  });

  test("a null report (monitor failed) produces available=false, not a crash", () => {
    const input = buildTidesInput(null);
    expect(input.available).toBe(false);
    expect(input.waterLevelFt).toBeNull();
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

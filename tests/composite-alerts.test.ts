/**
 * Tests for the pure composite-input shaping in src/alerts/composite.ts
 * (buildCompositeInput). Regressions live here because the shaping maps the
 * 8 monitors' real report shapes into computeAlertSeverity's inputs — a
 * mismatch here silently skews the composite CALM/WATCH/WARNING/EMERGENCY.
 */
import { describe, test, expect } from "bun:test";
import { buildCompositeInput } from "../src/alerts/composite.ts";

const fresh = () => ({ fetchedAt: new Date().toISOString() });

describe("buildCompositeInput — wildfire distance rule", () => {
  test("a large fire FAR outside the 50 km nearby band does NOT raise the composite", () => {
    const input = buildCompositeInput({
      tsunami: null, earthquake: null, weather: null, airquality: null, marine: null,
      tidesReport: null, fishingReport: null,
      wildfire: {
        ...fresh(),
        totalIncidents: 1,
        incidents: [{ name: "Far Fire", acres: 5000, containmentPercent: 10, distanceKm: 140, hasEvacuationOrders: false }],
      },
    });
    // Matches classifyWildfireSeverity (which rates the monitor ADVISORY): a
    // far-away large fire must not be present as a WARNING-grade signal here.
    expect(input.wildfire.hasLargeFireNearby).toBe(false);
    expect(input.wildfire.hasEvacuationOrders).toBe(false);
  });

  test("a large fire WITHIN 50 km raises the composite", () => {
    const input = buildCompositeInput({
      tsunami: null, earthquake: null, weather: null, airquality: null, marine: null,
      tidesReport: null, fishingReport: null,
      wildfire: {
        ...fresh(),
        totalIncidents: 1,
        incidents: [{ name: "Close Fire", acres: 2000, containmentPercent: 20, distanceKm: 30, hasEvacuationOrders: false }],
      },
    });
    expect(input.wildfire.hasLargeFireNearby).toBe(true);
  });

  test("an evacuation order near Crescent City raises to the composite regardless of distance field", () => {
    const input = buildCompositeInput({
      tsunami: null, earthquake: null, weather: null, airquality: null, marine: null,
      tidesReport: null, fishingReport: null,
      wildfire: {
        ...fresh(),
        totalIncidents: 1,
        incidents: [{ name: "Evac Fire", acres: 50, containmentPercent: 90, distanceKm: 20, hasEvacuationOrders: true }],
      },
    });
    expect(input.wildfire.hasEvacuationOrders).toBe(true);
  });
});

describe("buildCompositeInput — marine prefers the primary buoy 46027", () => {
  test("when both a far-field and 46027 are present, 46027 drives wave/wind", () => {
    const input = buildCompositeInput({
      tsunami: null, earthquake: null, weather: null, airquality: null, wildfire: null,
      tidesReport: null, fishingReport: null,
      marine: {
        ...fresh(),
        observations: [
          { stationId: "46022", waveHeightFt: 2, windSpeedKt: 8 },
          { stationId: "46027", waveHeightFt: 12, windSpeedKt: 30 },
        ],
      },
    });
    expect(input.marine.waveHeightFt).toBe(12);
    expect(input.marine.windSpeedKt).toBe(30);
    expect(input.marine.available).toBe(true);
  });
});

describe("buildCompositeInput — tides/fishing availability freshness", () => {
  test("a stale tides report is treated as unavailable (freshness-gated)", () => {
    const stale = {
      fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      waterLevel: { v: "6.5" },
      maxPredictedLevel: 6.5,
    };
    const input = buildCompositeInput({
      tsunami: null, earthquake: null, weather: null, airquality: null, marine: null, wildfire: null,
      fishingReport: null,
      tidesReport: stale as never,
    });
    expect(input.tides.available).toBe(false);
    // Even though a water level is present, a stale snapshot must not elevate.
    expect(input.tides.waterLevelFt).toBe(6.5);
  });

  test("a fresh tides report is available", () => {
    const fresh = {
      fetchedAt: new Date().toISOString(),
      waterLevel: { v: "4.2" },
      maxPredictedLevel: 7.2,
    };
    const input = buildCompositeInput({
      tsunami: null, earthquake: null, weather: null, airquality: null, marine: null, wildfire: null,
      fishingReport: null,
      tidesReport: fresh as never,
    });
    expect(input.tides.available).toBe(true);
    expect(input.tides.waterLevelFt).toBe(4.2);
  });
});

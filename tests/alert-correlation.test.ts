/**
 * Tests for src/alert_correlation.ts — cross-monitor co-occurrence analysis.
 * Pure: events are injected; no filesystem, no network, no LLM.
 */
import { describe, expect, test } from "bun:test";
import {
  buildAlertCorrelations,
  CORRELATION_PAIR_SPECS,
  CORRELATION_SOURCES,
  maxAqiOf,
  type CorrelationEvent,
} from "../src/alert_correlation";

const MIN = 60_000;

function event(
  source: CorrelationEvent["source"],
  minutesFromEpoch: number,
  extra: Record<string, unknown> = {},
): CorrelationEvent {
  return {
    source,
    timestamp: new Date(minutesFromEpoch * MIN).toISOString(),
    severity: "WATCH",
    description: `${source} event`,
    record: { fetchedAt: new Date(minutesFromEpoch * MIN).toISOString(), ...extra },
  };
}

describe("pair spec sanity", () => {
  test("every spec is directional, self-consistent, and over known sources", () => {
    for (const spec of CORRELATION_PAIR_SPECS) {
      expect(spec.windowMinutes).toBeGreaterThan(0);
      expect(CORRELATION_SOURCES).toContain(spec.typeA);
      expect(CORRELATION_SOURCES).toContain(spec.typeB);
      expect(spec.typeA).not.toBe(spec.typeB);
      expect(spec.rationale.length).toBeGreaterThan(10);
    }
  });
});

describe("buildAlertCorrelations", () => {
  test("detects a following event inside the window and reports lift", () => {
    // M6 earthquake at t=0 (severity WARNING via magnitude), tsunami 20 min later.
    const report = buildAlertCorrelations({
      earthquake: [event("earthquake", 0, { magnitude: 6.2, place: "Cascadia margin" })],
      tsunami: [event("tsunami", 20, { headline: "Tsunami Warning" })],
    });
    const pair = report.pairs.find((p) => p.id === "earthquake-tsunami")!;
    expect(pair.observedPairs).toBe(1);
    expect(pair.eventsA).toBe(1);
    expect(pair.eventsB).toBe(1);
    expect(pair.lift).not.toBeNull();
    expect(pair.medianLagMinutes).toBe(20);
    expect(pair.samples[0]?.lagMinutes).toBe(20);
    // Legacy view carries the same detection.
    expect(report.totalCorrelations).toBeGreaterThan(0);
    expect(report.correlations[0]?.type).toBe("earthquake-tsunami");
    expect(report.correlations[0]?.description).toContain("20 min later");
  });

  test("a B event BEFORE the A event is never a co-occurrence (directionality)", () => {
    const report = buildAlertCorrelations({
      earthquake: [event("earthquake", 100, { magnitude: 6.4 })],
      tsunami: [event("tsunami", 30, { headline: "Earlier tsunami alert" })],
    });
    const pair = report.pairs.find((p) => p.id === "earthquake-tsunami")!;
    expect(pair.observedPairs).toBe(0);
    expect(report.totalCorrelations).toBe(0);
  });

  test("relevance gates exclude non-qualifying events (M5 quake, healthy AQI)", () => {
    const report = buildAlertCorrelations({
      earthquake: [event("earthquake", 0, { magnitude: 5.2 })],
      tsunami: [event("tsunami", 10, {})],
      wildfire: [event("wildfire", 0, { acres: 20, hasEvacuationOrders: false })],
      airquality: [event("airquality", 30, { readings: [{ aqi: 42 }] })],
    });
    expect(report.pairs.find((p) => p.id === "earthquake-tsunami")!.observedPairs).toBe(0);
    expect(report.pairs.find((p) => p.id === "wildfire-airquality")!.observedPairs).toBe(0);
  });

  test("wildfire -> airquality fires only on an unhealthy AQI spike", () => {
    const report = buildAlertCorrelations({
      wildfire: [event("wildfire", 0, { name: "MP18 Fire", acres: 7610 })],
      airquality: [event("airquality", 90, { readings: [{ aqi: 168 }] })],
    });
    const pair = report.pairs.find((p) => p.id === "wildfire-airquality")!;
    expect(pair.observedPairs).toBe(1);
    expect(pair.medianLagMinutes).toBe(90);
  });

  test("drought -> wildfire pairs across the 30-day window", () => {
    const report = buildAlertCorrelations({
      drought: [event("drought", 0, { county: "Del Norte", severity: "D3", percent: 100 })],
      wildfire: [event("wildfire", 10 * 24 * 60, { name: "Six Rivers Fire", acres: 500 })],
    });
    const pair = report.pairs.find((p) => p.id === "drought-wildfire")!;
    expect(pair.observedPairs).toBe(1);
    // 10 days is well inside the 30-day window: informative, not cadence.
    expect(pair.cadenceSensitive).toBe(false);
  });

  test("sub-window monitor cadence is flagged as cadence-sensitive, not a finding", () => {
    // Marine writes every 60 min; weather WARNING writes once — co-occurrences
    // within the 1440-min window are cadence, and the flag must say so.
    const marine = Array.from({ length: 40 }, (_, i) => event("marine", 30 + i * 60, { level: "WATCH", stationName: "46027" }));
    const report = buildAlertCorrelations({
      weather: [event("weather", 0, { severity: "WARNING", event: "High Wind Warning" })],
      marine,
    });
    const pair = report.pairs.find((p) => p.id === "weather-marine")!;
    expect(pair.observedPairs).toBeGreaterThan(0);
    expect(pair.cadenceSensitive).toBe(true);
    expect(report.notes.some((n) => n.startsWith("weather-marine:"))).toBe(true);
    // Cadence artifacts sort last.
    expect(report.pairs[report.pairs.length - 1]?.cadenceSensitive).toBe(true);
  });

  test("empty world: no events, no span, no throw", () => {
    const report = buildAlertCorrelations({});
    expect(report.analyzedSpan).toBeNull();
    expect(report.totalEventsScanned).toBe(0);
    for (const pair of report.pairs) {
      expect(pair.observedPairs).toBe(0);
      expect(pair.lift).toBeNull();
      expect(pair.expectedPairs).toBe(0);
    }
    expect(report.totalCorrelations).toBe(0);
  });

  test("sourcesScanned covers every correlation source", () => {
    const report = buildAlertCorrelations({});
    expect(report.sourcesScanned.map((s) => s.source).sort()).toEqual([...CORRELATION_SOURCES].sort());
  });
});

describe("maxAqiOf", () => {
  test("reads both persisted shapes and rejects garbage", () => {
    expect(maxAqiOf({ maxAqi: 88 })).toBe(88);
    expect(maxAqiOf({ readings: [{ aqi: 17 }, { aqi: 56 }] })).toBe(56);
    expect(maxAqiOf({})).toBeNull();
    expect(maxAqiOf({ readings: "bad" })).toBeNull();
  });
});

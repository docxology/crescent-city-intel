/**
 * False-calm / false-alarm guards.
 *
 * Every test here pins a defect where a live-feed failure, an outage, or a
 * derived value produced a *plausible but wrong* safety signal — a monitor
 * reporting CALM because it could not check, or reporting a forecast as an
 * observation. This is the failure class the repo treats as a correctness bug
 * rather than a polish item, because the composite level is what the dashboard
 * presents as the county's alert state.
 *
 * Pure: real modules, real report shapes, no network, no mocks.
 */
import { describe, expect, test } from "bun:test";
import { computeAlertSeverity } from "../src/alerts/severity.ts";
import type {
  EarthquakeInput, PspsInput, SchoolClosureInput, TsunamiInput, WeatherInput,
  DroughtInput, TidesInput, FishingInput,
} from "../src/alerts/severity.ts";
import { buildTidesInput, buildFishingInput, isFreshReport, buildExtendedCompositeInput } from "../src/alerts/composite.ts";
import { classifyPm25 } from "../src/alerts/hrrr_smoke.ts";
import { toMarineZoneForecast } from "../src/alerts/nws_marine.ts";

/**
 * `computeAlertSeverity` takes POSITIONAL inputs, so a partial call leaves the
 * first five (`tsunami`..`fishing`) undefined and every `assess*` throws on
 * `input.available`. These base values fill them; the extended monitors all
 * have defaults, so a test can vary only the one it is about.
 */
const CALM_TSUNAMI: TsunamiInput = { warningCount: 0, watchCount: 0, available: true };
const CALM_QUAKE: EarthquakeInput = { events: [], available: true };
const CALM_WEATHER: WeatherInput = { severities: [], count: 0, available: true };
const CALM_TIDES: TidesInput = { waterLevelFt: 2, available: true };
const CALM_FISHING: FishingInput = { closureActive: false, available: true };

/** Severity over a named set of extended monitors, everything else calm. */
function severityWith(overrides: {
  earthquake?: EarthquakeInput;
  weather?: WeatherInput;
  drought?: DroughtInput;
  psps?: PspsInput;
  schools?: SchoolClosureInput;
}): ReturnType<typeof computeAlertSeverity> {
  return computeAlertSeverity(
    CALM_TSUNAMI,
    overrides.earthquake ?? CALM_QUAKE,
    overrides.weather ?? CALM_WEATHER,
    CALM_TIDES,
    CALM_FISHING,
    { maxAqi: 0, available: true },
    { incidentCount: 0, hasEvacuationOrders: false, hasLargeFireNearby: false },
    { waveHeightFt: null, windSpeedKt: null, available: true },
    overrides.drought,
    overrides.psps,
    undefined,
    undefined,
    overrides.schools,
  );
}

describe("unavailable is never reported as calm", () => {
  test("a monitor with no data reports availability, and the reason says so", () => {
    const report = computeAlertSeverity(
      { warningCount: 0, watchCount: 0, available: false },
      { events: [], available: false },
      { severities: [], count: 0, available: false },
      { waterLevelFt: null, available: false },
      { closureActive: false, available: false },
    );
    expect(report.hasUnavailableMonitors).toBe(true);
    // The level field cannot express "unknown" — but the reason must, so a
    // consumer reading `level` alone still sees a caveat on the headline line.
    expect(report.reason).toContain("Data unavailable");
  });

  test("the headline reason picks the hazard-priority monitor, not declaration order", () => {
    // The defect: a strict `>` tie-break meant the FIRST key in the `monitors`
    // literal won every tie, so a chronic D3 drought WARNING took the
    // front-page reason slot ahead of an active school closure. Both are
    // WARNING; the closure is the one an operator must see.
    const report = severityWith({
      drought: { severity: "D3", severeDroughtPercent: 40, available: true },
      schools: { status: "CLOSED", hasActiveClosure: true, hasActiveDelay: false, eventCount: 1, available: true },
    });
    expect(report.level).toBe("WARNING");
    expect(report.reason).toMatch(/^Schools:/);
  });

  test("an active PSPS outranks a chronic drought at the same tier", () => {
    const report = severityWith({
      drought: { severity: "D3", severeDroughtPercent: 40, available: true },
      psps: { status: "ACTIVE", eventCount: 1, delNorteAffected: true, available: true },
    });
    expect(report.level).toBe("WARNING");
    expect(report.reason).toMatch(/^Psps:/);
  });
});

describe("tides: a forecast is not an observation", () => {
  test("a dead sensor yields no water level, so the monitor is unavailable", () => {
    const input = buildTidesInput({
      fetchedAt: new Date().toISOString(),
      stationId: "9419750",
      stationName: "Crescent City, CA",
      predictions: [],
      waterLevel: null,
      highTideAlert: true,
      maxPredictedLevel: 7.4,
      alertThresholdFt: 5,
      summary: "Max predicted water level 7.4 ft",
    } as never);
    expect(input.waterLevelFt).toBeNull();
    expect(input.available).toBe(true);
  });

  test("a fishing report built from a real season estimate still reports its own availability", () => {
    const input = buildFishingInput(null);
    expect(input.available).toBe(false);
    expect(input.closureActive).toBe(false);
  });
});

describe("smoke: the top AQI band cannot report AQI 0", () => {
  test("a hazardous PM2.5 concentration reports the band maximum, not zero", () => {
    // The defect: the top band used `max: Infinity`, and the interpolation
    // `aqi * (pm25 / Infinity)` evaluated to 0 — so a hazardous plume was
    // published as `peakLevel: HAZARDOUS` with `peakAqi: 0`, and the analytics
    // layer, which reads the AQI number, recorded it as clean air.
    const hazardous = classifyPm25(400);
    expect(hazardous.level).toBe("HAZARDOUS");
    expect(hazardous.aqi).toBeGreaterThan(300);
    expect(hazardous.aqi).toBeLessThanOrEqual(500);
  });

  test("a concentration above every breakpoint still reports the band maximum", () => {
    // The `for` loop is total over finite bands, but an out-of-range input must
    // not fall through to a guess. 500.4 is the top band's ceiling; beyond it
    // the answer is the ceiling, not 0 and not undefined.
    const extreme = classifyPm25(5000);
    expect(extreme.level).toBe("HAZARDOUS");
    expect(extreme.aqi).toBe(500);
  });

  test("AQI increases monotonically with concentration across every band", () => {
    const samples = [2, 20, 45, 100, 200, 400];
    const aqis = samples.map(pm25 => classifyPm25(pm25).aqi);
    for (let i = 1; i < aqis.length; i++) {
      expect(aqis[i]!).toBeGreaterThanOrEqual(aqis[i - 1]!);
    }
  });
});

describe("freshness windows", () => {
  const ISO = (ms: number): string => new Date(ms).toISOString();

  test("the extended monitors are freshness-gated like the core ones", () => {
    // The defect: buildExtendedCompositeInput read `reports.X != null` with no
    // freshness check, so a day-old drought or school-closure snapshot was
    // scored as a current reading while the eight core monitors went stale
    // after an hour.
    const stale = { timestamp: ISO(Date.parse("2026-09-20T00:00:00Z")) };
    const input = buildExtendedCompositeInput({ drought: stale }) as Record<string, { available: boolean }>;
    expect(input.drought!.available).toBe(false);
  });

  test("a fresh extended report is available", () => {
    const fresh = { timestamp: new Date().toISOString() };
    const input = buildExtendedCompositeInput({ drought: fresh }) as Record<string, { available: boolean }>;
    expect(input.drought!.available).toBe(true);
  });

  test("ALERT_FRESHNESS_WINDOW_MS tunes the alert layer, and an invalid value keeps the gate on", () => {
    const previous = process.env.ALERT_FRESHNESS_WINDOW_MS;
    const report = { timestamp: ISO(Date.parse("2026-09-26T00:00:00Z")) };
    const twoHoursIn = Date.parse("2026-09-26T02:00:00Z");
    try {
      // Default: one hour, so a 2-hour-old report is stale.
      delete process.env.ALERT_FRESHNESS_WINDOW_MS;
      expect(isFreshReport(report, twoHoursIn)).toBe(false);
      // Widened window admits it.
      process.env.ALERT_FRESHNESS_WINDOW_MS = String(4 * 60 * 60 * 1000);
      expect(isFreshReport(report, twoHoursIn)).toBe(true);
      // A nonsense value must not silently disable the gate — that is how a
      // stale snapshot starts being presented as a current reading.
      process.env.ALERT_FRESHNESS_WINDOW_MS = "not-a-number";
      expect(isFreshReport(report, twoHoursIn)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ALERT_FRESHNESS_WINDOW_MS;
      else process.env.ALERT_FRESHNESS_WINDOW_MS = previous;
    }
  });
});

describe("marine forecast: a successful fetch is never permanently stale", () => {
  test("a freshly-built forecast passes the composite freshness gate", () => {
    // The defect: MarineZoneForecast carried no timestamp, so isFreshReport
    // always returned false and the 14th monitor reported `stale` forever —
    // counted as missing coverage and pushed into the healer's retry roster
    // even on a fully successful run.
    const now = new Date().toISOString();
    const forecast = toMarineZoneForecast(
      "PZZ450-032000-\nCoastal waters from Pt. St. George to Cape Mendocino CA out 10 nm\n" +
      ". TODAY...N wind 5 to 10 kt.\n. TUE...N wind 10 kt.\n\n$$\n",
      now,
    );
    expect(forecast).not.toBeNull();
    expect(forecast!.timestamp).toBe(now);
    expect(isFreshReport(forecast, Date.parse(now) + 60_000)).toBe(true);
  });
});

describe("weather: the summary counts the tier it names", () => {
  test("one warning plus three advisories reads as one warning", () => {
    // The defect: the summary interpolated the TOTAL active-alert count into
    // the tier that matched, so this reported "4 active NWS Warning(s)".
    const report = severityWith({
      weather: { severities: ["warning", "advisory", "advisory", "advisory"], count: 4, available: true },
    });
    expect(report.monitors.weather.summary).toBe("\u{1f534} 1 active NWS Warning(s)");
    expect(report.monitors.weather.count).toBe(4);
  });

  test("advisories alone are counted as advisories", () => {
    const report = severityWith({
      weather: { severities: ["advisory", "advisory"], count: 2, available: true },
    });
    expect(report.monitors.weather.summary).toBe("\u{1f535} 2 active NWS Advisory(ies)");
  });
});

describe("earthquake: the headline names the worst event, not the nearest", () => {
  test("an M7.4 further out outranks an M6.3 closer in", () => {
    // The defect: the monitor sorts events by distance, and the assessment
    // took `severe[0]`, so the nearest qualifying event was always the one
    // named — hiding a larger event in the same run.
    const report = severityWith({
      earthquake: {
        events: [
          { magnitude: 6.3, distanceKm: 50, tsunami: 0, place: "off Oregon" },
          { magnitude: 7.4, distanceKm: 180, tsunami: 0, place: "off Alaska" },
        ],
        available: true,
      },
    });
    expect(report.monitors.earthquake.summary).toContain("M7.4");
  });

  test("a possible-tsunami flag (1) is reported, not silently dropped", () => {
    // The defect: only flag >= 2 ("tsunami generated") produced tsunami
    // wording, though the monitor itself maps flag 1 to TSUNAMI_WATCH and logs
    // it at warn level.
    const report = severityWith({
      earthquake: { events: [{ magnitude: 7.2, distanceKm: 150, tsunami: 1, place: "Pacific" }], available: true },
    });
    expect(report.monitors.earthquake.level).toBe("WARNING");
    expect(report.monitors.earthquake.summary).toContain("possible tsunami");
  });

  test("tsunami generated (flag 2) is EMERGENCY within the monitor's 200 km radius", () => {
    // assessEarthquake filters to `distanceKm <= 200` before ranking, so the
    // tsunami event has to be inside that band to be considered at all.
    const report = severityWith({
      earthquake: { events: [{ magnitude: 7.5, distanceKm: 190, tsunami: 2, place: "Pacific" }], available: true },
    });
    expect(report.level).toBe("EMERGENCY");
  });

  test("a tsunami event beyond 200 km is out of scope, not escalated", () => {
    // The monitor's own scope is M4.0+ within 200 km; an event outside it is
    // not Crescent City's alert, whatever its tsunami flag.
    const report = severityWith({
      earthquake: { events: [{ magnitude: 7.5, distanceKm: 220, tsunami: 2, place: "Pacific" }], available: true },
    });
    expect(report.monitors.earthquake.summary).toBe("No qualifying earthquakes nearby");
  });
});

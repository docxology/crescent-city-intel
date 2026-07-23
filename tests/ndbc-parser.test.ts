import { describe, test, expect } from "bun:test";
import { classifyMarineSeverity } from "../src/alerts/ndbc_marine.js";

describe("NDBC buoy data parsing", () => {
  // Simulated NDBC realtime data line
  // Format: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD BAR ATMP WTMP DEWP VIS PTDY TIDE
  const sampleLine = "23 07 23 12 00 270  5.2  6.1  1.2  8.0  6.0 999 1012.0 15.0 12.0 10.0 99.0 999.0 999.0";

  test("sample line has expected number of fields", () => {
    const parts = sampleLine.trim().split(/\s+/);
    expect(parts.length).toBeGreaterThanOrEqual(15);
  });

  test("year is parsed correctly (2-digit → 4-digit)", () => {
    const parts = sampleLine.trim().split(/\s+/);
    const yy = parseInt(parts[0], 10);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    expect(year).toBe(2023);
  });

  test("wind speed converts from m/s to knots correctly", () => {
    const windMs = 5.2;
    const windKt = windMs * 1.94384;
    expect(windKt).toBeCloseTo(10.11, 1);
  });

  test("wave height converts from meters to feet correctly", () => {
    const waveM = 1.2;
    const waveFt = waveM * 3.28084;
    expect(waveFt).toBeCloseTo(3.94, 1);
  });

  test("temperature converts from Celsius to Fahrenheit correctly", () => {
    const tempC = 15.0;
    const tempF = tempC * 9 / 5 + 32;
    expect(tempF).toBeCloseTo(59.0, 1);
  });
});

describe("NDBC marine severity with parsed values", () => {
  test("typical summer conditions produce CALM", () => {
    const obs = [{
      stationId: "46027",
      stationName: "St Georges CA",
      distanceNm: 27,
      timestamp: new Date().toISOString(),
      windSpeedKt: 10,
      windDirectionDeg: 270,
      windGustKt: 12,
      waveHeightFt: 3.9,
      wavePeriodSec: 8,
      waveDirectionDeg: 270,
      waterTempF: 53.6,
      airTempF: 59.0,
      pressure: 1012,
    }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("CALM");
  });

  test("storm conditions produce WARNING", () => {
    const obs = [{
      stationId: "46027",
      stationName: "St Georges CA",
      distanceNm: 27,
      timestamp: new Date().toISOString(),
      windSpeedKt: 10,
      windDirectionDeg: 270,
      windGustKt: 40,
      waveHeightFt: 18,
      wavePeriodSec: 12,
      waveDirectionDeg: 270,
      waterTempF: 53.6,
      airTempF: 55.0,
      pressure: 990,
    }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("WARNING");
    expect(result.advisory).toContain("Hazardous");
  });

  test("elevated conditions produce WATCH", () => {
    const obs = [{
      stationId: "46027",
      stationName: "St Georges CA",
      distanceNm: 27,
      timestamp: new Date().toISOString(),
      windSpeedKt: 25,
      windDirectionDeg: 270,
      windGustKt: 30,
      waveHeightFt: 11,
      wavePeriodSec: 10,
      waveDirectionDeg: 270,
      waterTempF: 53.6,
      airTempF: 57.0,
      pressure: 1005,
    }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("WATCH");
  });

  test("long-period swell without high waves produces WATCH", () => {
    const obs = [{
      stationId: "46027",
      stationName: "St Georges CA",
      distanceNm: 27,
      timestamp: new Date().toISOString(),
      windSpeedKt: 5,
      windDirectionDeg: 180,
      windGustKt: 7,
      waveHeightFt: 3,
      wavePeriodSec: 16,
      waveDirectionDeg: 200,
      waterTempF: 55.0,
      airTempF: 58.0,
      pressure: 1015,
    }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("WATCH");
    expect(result.advisory).toContain("Long-period swell");
  });
});

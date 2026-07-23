import { describe, test, expect } from "bun:test";
import {
  classifyAqi,
  getAdvisory,
} from "../src/alerts/epa_airnow.js";
import {
  classifyWildfireSeverity,
} from "../src/alerts/calfire_wildfire.js";
import {
  classifyMarineSeverity,
} from "../src/alerts/ndbc_marine.js";
import {
  computeAlertSeverity,
} from "../src/alerts/severity.js";

describe("classifyAqi", () => {
  test("AQI 0-50 is GOOD", () => {
    expect(classifyAqi(0)).toBe("GOOD");
    expect(classifyAqi(50)).toBe("GOOD");
  });

  test("AQI 51-100 is MODERATE", () => {
    expect(classifyAqi(51)).toBe("MODERATE");
    expect(classifyAqi(100)).toBe("MODERATE");
  });

  test("AQI 101-150 is UNHEALTHY_SENSITIVE", () => {
    expect(classifyAqi(101)).toBe("UNHEALTHY_SENSITIVE");
    expect(classifyAqi(150)).toBe("UNHEALTHY_SENSITIVE");
  });

  test("AQI 151-200 is UNHEALTHY", () => {
    expect(classifyAqi(151)).toBe("UNHEALTHY");
    expect(classifyAqi(200)).toBe("UNHEALTHY");
  });

  test("AQI 201-300 is VERY_UNHEALTHY", () => {
    expect(classifyAqi(201)).toBe("VERY_UNHEALTHY");
    expect(classifyAqi(300)).toBe("VERY_UNHEALTHY");
  });

  test("AQI 301+ is HAZARDOUS", () => {
    expect(classifyAqi(301)).toBe("HAZARDOUS");
    expect(classifyAqi(500)).toBe("HAZARDOUS");
  });
});

describe("getAdvisory", () => {
  test("GOOD has no advisory", () => {
    expect(getAdvisory("GOOD")).toBeNull();
  });

  test("MODERATE has advisory", () => {
    expect(getAdvisory("MODERATE")).toContain("sensitive");
  });

  test("HAZARDOUS has emergency advisory", () => {
    expect(getAdvisory("HAZARDOUS")).toContain("Emergency");
  });
});

describe("classifyWildfireSeverity", () => {
  test("no incidents = NONE", () => {
    expect(classifyWildfireSeverity([])).toBe("NONE");
  });

  test("incident with evac orders = EMERGENCY", () => {
    const incidents = [{ hasEvacuationOrders: true, acres: 500, containmentPercent: 50, distanceKm: 100 }];
    expect(classifyWildfireSeverity(incidents as any)).toBe("EMERGENCY");
  });

  test("large fire nearby = WARNING", () => {
    const incidents = [{ hasEvacuationOrders: false, acres: 2000, containmentPercent: 30, distanceKm: 40 }];
    expect(classifyWildfireSeverity(incidents as any)).toBe("WARNING");
  });

  test("small incident = ADVISORY", () => {
    const incidents = [{ hasEvacuationOrders: false, acres: 50, containmentPercent: 80, distanceKm: 100 }];
    expect(classifyWildfireSeverity(incidents as any)).toBe("ADVISORY");
  });
});

describe("classifyMarineSeverity", () => {
  test("no observations = CALM", () => {
    expect(classifyMarineSeverity([]).level).toBe("CALM");
  });

  test("high waves = WARNING", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 18, windSpeedKt: 10 }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("WARNING");
    expect(result.advisory).toContain("Hazardous");
  });

  test("gale force winds = WARNING", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 5, windSpeedKt: 40 }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("WARNING");
  });

  test("elevated seas = WATCH", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 12, windSpeedKt: 15 }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("WATCH");
  });

  test("normal conditions = CALM", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 4, windSpeedKt: 10 }];
    const result = classifyMarineSeverity(obs as any);
    expect(result.level).toBe("CALM");
  });
});

describe("computeAlertSeverity (8-monitor composite)", () => {
  const calmInputs = {
    tsunami: { warningCount: 0, watchCount: 0 },
    earthquake: { events: [] },
    weather: { severities: [], count: 0 },
    tides: { waterLevelFt: 2, available: true },
    fishing: { closureActive: false },
    airQuality: { maxAqi: 30, available: true },
    wildfire: { incidentCount: 0, hasEvacuationOrders: false, hasLargeFireNearby: false },
    marine: { waveHeightFt: 3, windSpeedKt: 10, available: true },
  };

  test("all calm = CALM", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing, calmInputs.airQuality,
      calmInputs.wildfire, calmInputs.marine,
    );
    expect(report.level).toBe("CALM");
    expect(report.monitors).toHaveProperty("airQuality");
    expect(report.monitors).toHaveProperty("wildfire");
    expect(report.monitors).toHaveProperty("marine");
  });

  test("wildfire emergency overrides calm", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing, calmInputs.airQuality,
      { incidentCount: 2, hasEvacuationOrders: true, hasLargeFireNearby: true },
      calmInputs.marine,
    );
    expect(report.level).toBe("EMERGENCY");
    expect(report.reason).toContain("Wildfire");
  });

  test("marine warning detected", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing, calmInputs.airQuality,
      calmInputs.wildfire,
      { waveHeightFt: 20, windSpeedKt: 15, available: true },
    );
    expect(report.level).toBe("WARNING");
    expect(report.reason).toContain("Marine");
  });

  test("air quality watch detected", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing,
      { maxAqi: 120, available: true },
      calmInputs.wildfire, calmInputs.marine,
    );
    expect(report.monitors.airQuality.level).toBe("WATCH");
  });
});

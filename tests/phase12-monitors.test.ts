/**
 * Offline-verifiable tests for the five Phase-12 external-source alert
 * monitors (drought / PSPS / smoke / roads / schools).
 *
 * These monitors were added in v2.6.0 but shipped without any test coverage
 * and without runner wiring (tracked in TODO.md as a deferred Medium item).
 * The fetch paths require live external feeds, but each module exports pure
 * classification/aggregation functions whose behavior is fully verifiable
 * offline with real inputs — which is what these tests exercise. No mock
 * frameworks: real module imports, real computation, real edge inputs.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyDroughtSeverity,
  computeDroughtComposite,
  type DroughtReading,
} from "../src/alerts/usdm_drought.ts";
import {
  classifyPspsStatus,
} from "../src/alerts/pge_psps.ts";
import {
  classifyPm25,
  getSmokeAdvisory,
} from "../src/alerts/hrrr_smoke.ts";
import {
  classifyRoadSeverity,
} from "../src/alerts/caltrans_roads.ts";
import {
  classifySchoolStatus,
} from "../src/alerts/dusd_schools.ts";

describe("usdm_drought classification", () => {
  test("each D0-D4 category maps to its own severity", () => {
    for (const d of ["D0", "D1", "D2", "D3", "D4"] as const) {
      expect(classifyDroughtSeverity(d)).toBe(d);
    }
  });

  test("category matching is case-insensitive and whitespace-tolerant", () => {
    expect(classifyDroughtSeverity(" d2 ")).toBe("D2");
    expect(classifyDroughtSeverity("d4")).toBe("D4");
  });

  test("unknown or empty categories are honest NONE, not a fabricated level", () => {
    expect(classifyDroughtSeverity("")).toBe("NONE");
    expect(classifyDroughtSeverity("D5")).toBe("NONE");
    expect(classifyDroughtSeverity("abnormal")).toBe("NONE");
  });

  test("composite of empty readings is NONE", () => {
    expect(computeDroughtComposite([])).toBe("NONE");
  });

  test("composite returns the worst severity present at >=1% coverage", () => {
    const readings: DroughtReading[] = [
      { fips: "06015", county: "Del Norte", state: "CA", severity: "D1", percent: 40 },
      { fips: "06015", county: "Del Norte", state: "CA", severity: "D3", percent: 5 },
      { fips: "06015", county: "Del Norte", state: "CA", severity: "D2", percent: 20 },
    ];
    expect(computeDroughtComposite(readings)).toBe("D3");
  });

  test("a severity at 0% coverage is skipped in favor of the next present one", () => {
    const readings: DroughtReading[] = [
      { fips: "06015", county: "Del Norte", state: "CA", severity: "D4", percent: 0 },
      { fips: "06015", county: "Del Norte", state: "CA", severity: "D0", percent: 100 },
    ];
    expect(computeDroughtComposite(readings)).toBe("D0");
  });
});

describe("pge_psps classification", () => {
  test("status keywords map to the documented lifecycle states", () => {
    expect(classifyPspsStatus("Event is ACTIVE")).toBe("ACTIVE");
    expect(classifyPspsStatus("planned outage")).toBe("PLANNED");
    expect(classifyPspsStatus("weather warning")).toBe("PLANNED");
    expect(classifyPspsStatus("monitoring conditions")).toBe("MONITORED");
    expect(classifyPspsStatus("restoration underway")).toBe("RESTORATION");
  });

  test("unrecognized text is NONE rather than a guessed state", () => {
    expect(classifyPspsStatus("")).toBe("NONE");
    expect(classifyPspsStatus("all clear")).toBe("NONE");
  });

  test("'monitor' inside another word does not force MONITORED when an earlier keyword matched", () => {
    // 'active' is checked before 'monitor', so a combined string resolves to ACTIVE
    expect(classifyPspsStatus("active monitoring")).toBe("ACTIVE");
  });
});

describe("hrrr_smoke PM2.5 -> AQI/level", () => {
  test("threshold boundaries land in the correct EPA bucket", () => {
    expect(classifyPm25(0).level).toBe("GOOD");
    expect(classifyPm25(12.0).level).toBe("GOOD");
    expect(classifyPm25(12.1).level).toBe("MODERATE");
    expect(classifyPm25(35.4).level).toBe("MODERATE");
    expect(classifyPm25(35.5).level).toBe("UNHEALTHY_SENSITIVE");
    expect(classifyPm25(55.5).level).toBe("UNHEALTHY");
    expect(classifyPm25(150.5).level).toBe("VERY_UNHEALTHY");
    expect(classifyPm25(250.5).level).toBe("HAZARDOUS");
  });

  test("AQI is a positive integer scaled within the bucket", () => {
    const { level, aqi } = classifyPm25(6);
    expect(level).toBe("GOOD");
    expect(aqi).toBe(25);
    expect(Number.isInteger(classifyPm25(20).aqi)).toBe(true);
  });

  test("advisory text exists exactly when air is not GOOD", () => {
    for (const level of ["MODERATE", "UNHEALTHY_SENSITIVE", "UNHEALTHY", "VERY_UNHEALTHY", "HAZARDOUS"] as const) {
      expect(getSmokeAdvisory(level)).not.toBeNull();
    }
    expect(getSmokeAdvisory("GOOD")).toBeNull();
  });
});

describe("caltrans_roads severity classification", () => {
  test("closure language wins over everything else", () => {
    expect(classifyRoadSeverity("Closure", "full closure of US-101")).toBe("CLOSURE");
    expect(classifyRoadSeverity("Incident", "road closed due to slide")).toBe("CLOSURE");
  });

  test("hazard/accident language is WARNING", () => {
    expect(classifyRoadSeverity("Collision", "accident blocking lane")).toBe("WARNING");
    expect(classifyRoadSeverity("Flood", "water over roadway")).toBe("WARNING");
  });

  test("construction/lane language is ADVISORY", () => {
    expect(classifyRoadSeverity("Construction", "lane closed for maintenance")).toBe("ADVISORY");
  });

  test("ordinary incidents are honestly NONE", () => {
    expect(classifyRoadSeverity("Info", "routine patrol reported")).toBe("NONE");
  });
});

describe("dusd_schools status classification", () => {
  test("closure phrases map to CLOSED", () => {
    expect(classifySchoolStatus("All schools closed today")).toBe("CLOSED");
    expect(classifySchoolStatus("event cancelled")).toBe("CLOSED");
    expect(classifySchoolStatus("no school Monday")).toBe("CLOSED");
  });

  test("partial vs full closure are distinguished", () => {
    expect(classifySchoolStatus("some schools affected")).toBe("PARTIAL_CLOSURE");
    expect(classifySchoolStatus("selected sites impacted")).toBe("PARTIAL_CLOSURE");
  });

  test("early release and delayed opening are distinct states", () => {
    expect(classifySchoolStatus("early dismissal at noon")).toBe("EARLY_RELEASE");
    expect(classifySchoolStatus("2 hour delay / late start")).toBe("DELAYED");
  });

  test("normal operation is OPEN, not a guessed disruption", () => {
    expect(classifySchoolStatus("Regular schedule; board meeting tonight")).toBe("OPEN");
  });
});

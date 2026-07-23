import { describe, test, expect } from "bun:test";
import {
  levenshtein,
  similarity,
  closestMatch,
  fuzzyCorrect,
  expandQueryFuzzy,
} from "../src/shared/fuzzy.js";
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
  parseLegislativeHistory,
} from "../src/structured_queries.js";
import {
  extractCitations,
  extractOrdinanceAmendments,
  extractDefinitions,
  extractEffectiveDate,
  buildGlossary,
} from "../src/legal_parser.js";
import {
  computeAlertSeverity,
} from "../src/alerts/severity.js";

describe("levenshtein edge cases", () => {
  test("transposition of adjacent characters = distance 2", () => {
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  test("long string with one difference", () => {
    expect(levenshtein("harborfront", "harborfronX")).toBe(1);
  });

  test("handles repeated characters", () => {
    expect(levenshtein("aaa", "aa")).toBe(1);
    expect(levenshtein("aa", "aaa")).toBe(1);
  });
});

describe("similarity edge cases", () => {
  test("empty vs non-empty = 0", () => {
    expect(similarity("", "abc")).toBe(0);
  });

  test("both empty = 1", () => {
    expect(similarity("", "")).toBe(1);
  });
});

describe("closestMatch edge cases", () => {
  test("exact match in candidates returns score 1", () => {
    const result = closestMatch("harbor", ["harbor", "zoning"], 0.5);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
  });

  test("empty candidates returns null", () => {
    expect(closestMatch("test", [], 0.5)).toBeNull();
  });
});

describe("classifyAqi boundary values", () => {
  test("AQI exactly 50 is GOOD (boundary)", () => {
    expect(classifyAqi(50)).toBe("GOOD");
  });
  test("AQI exactly 51 is MODERATE (boundary)", () => {
    expect(classifyAqi(51)).toBe("MODERATE");
  });
  test("AQI exactly 100 is MODERATE (boundary)", () => {
    expect(classifyAqi(100)).toBe("MODERATE");
  });
  test("AQI exactly 101 is UNHEALTHY_SENSITIVE (boundary)", () => {
    expect(classifyAqi(101)).toBe("UNHEALTHY_SENSITIVE");
  });
  test("AQI exactly 200 is UNHEALTHY (boundary)", () => {
    expect(classifyAqi(200)).toBe("UNHEALTHY");
  });
  test("AQI exactly 201 is VERY_UNHEALTHY (boundary)", () => {
    expect(classifyAqi(201)).toBe("VERY_UNHEALTHY");
  });
  test("AQI exactly 300 is VERY_UNHEALTHY (boundary)", () => {
    expect(classifyAqi(300)).toBe("VERY_UNHEALTHY");
  });
  test("AQI exactly 301 is HAZARDOUS (boundary)", () => {
    expect(classifyAqi(301)).toBe("HAZARDOUS");
  });
  test("AQI 0 is GOOD", () => {
    expect(classifyAqi(0)).toBe("GOOD");
  });
  test("AQI 500 is HAZARDOUS", () => {
    expect(classifyAqi(500)).toBe("HAZARDOUS");
  });
});

describe("getAdvisory for all levels", () => {
  test("UNHEALTHY_SENSITIVE has advisory", () => {
    expect(getAdvisory("UNHEALTHY_SENSITIVE")).not.toBeNull();
  });
  test("UNHEALTHY has advisory", () => {
    expect(getAdvisory("UNHEALTHY")).not.toBeNull();
  });
  test("VERY_UNHEALTHY has advisory", () => {
    expect(getAdvisory("VERY_UNHEALTHY")).not.toBeNull();
  });
});

describe("classifyWildfireSeverity edge cases", () => {
  test("large fire NOT nearby = ADVISORY (not WARNING)", () => {
    const incidents = [{ hasEvacuationOrders: false, acres: 2000, containmentPercent: 30, distanceKm: 150 }];
    expect(classifyWildfireSeverity(incidents as any)).toBe("ADVISORY");
  });

  test("small nearby fire = ADVISORY", () => {
    const incidents = [{ hasEvacuationOrders: false, acres: 100, containmentPercent: 80, distanceKm: 30 }];
    expect(classifyWildfireSeverity(incidents as any)).toBe("ADVISORY");
  });

  test("multiple incidents with evac = EMERGENCY", () => {
    const incidents = [
      { hasEvacuationOrders: true, acres: 500, containmentPercent: 50, distanceKm: 50 },
      { hasEvacuationOrders: false, acres: 50, containmentPercent: 90, distanceKm: 80 },
    ];
    expect(classifyWildfireSeverity(incidents as any)).toBe("EMERGENCY");
  });
});

describe("classifyMarineSeverity edge cases", () => {
  test("exactly 15 ft waves = WARNING (boundary)", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 15, windSpeedKt: 10 }];
    expect(classifyMarineSeverity(obs as any).level).toBe("WARNING");
  });
  test("exactly 10 ft waves = WATCH (boundary)", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 10, windSpeedKt: 10 }];
    expect(classifyMarineSeverity(obs as any).level).toBe("WATCH");
  });
  test("exactly 34 kt wind = WARNING (boundary)", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 5, windSpeedKt: 34 }];
    expect(classifyMarineSeverity(obs as any).level).toBe("WARNING");
  });
  test("exactly 22 kt wind = WATCH (boundary)", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 5, windSpeedKt: 22 }];
    expect(classifyMarineSeverity(obs as any).level).toBe("WATCH");
  });
  test("long-period swell at 15s = WATCH", () => {
    const obs = [{ stationId: "46027", waveHeightFt: 3, windSpeedKt: 5, wavePeriodSec: 15 }];
    expect(classifyMarineSeverity(obs as any).level).toBe("WATCH");
  });
  test("uses primary station 46027 even if not first", () => {
    const obs = [
      { stationId: "46022", waveHeightFt: 20, windSpeedKt: 5 },
      { stationId: "46027", waveHeightFt: 3, windSpeedKt: 5 },
    ];
    expect(classifyMarineSeverity(obs as any).level).toBe("CALM");
  });
});

describe("parseLegislativeHistory edge cases", () => {
  test("handles 'Ordinance' full word", () => {
    const result = parseLegislativeHistory("Ordinance No. 100, 2005");
    expect(result).toHaveLength(1);
    expect(result[0].ordinance).toBe("Ord. No. 100");
  });

  test("handles multiple actions with different types", () => {
    const result = parseLegislativeHistory("Ord. No. 100 enacted 2005; Ord. No. 200 amended 2010; Ord. No. 300 repealed 2015");
    expect(result).toHaveLength(3);
    expect(result[0].action).toBe("enacted");
    expect(result[1].action).toBe("amended");
    expect(result[2].action).toBe("repealed");
  });

  test("handles entry without year", () => {
    const result = parseLegislativeHistory("Ord. No. 100");
    expect(result).toHaveLength(1);
    expect(result[0].date).toBeNull();
  });
});

describe("extractCitations edge cases", () => {
  test("extracts multiple CA code citations from same text", () => {
    const text = "See Government Code § 65850 and Health and Safety Code § 12095 for details.";
    const citations = extractCitations(text);
    expect(citations.filter(c => c.type === "ca-code").length).toBeGreaterThanOrEqual(2);
  });

  test("extracts Penal Code citation", () => {
    const text = "Violations are subject to Penal Code § 422 for assault.";
    const citations = extractCitations(text);
    expect(citations.some(c => c.codeName?.includes("Penal"))).toBe(true);
  });

  test("extracts Vehicle Code citation", () => {
    const text = "Parking violations per Vehicle Code § 22507.";
    const citations = extractCitations(text);
    expect(citations.some(c => c.codeName?.includes("Vehicle"))).toBe(true);
  });
});

describe("extractDefinitions edge cases", () => {
  test("extracts 'is defined as' pattern", () => {
    const text = "Nuisance is defined as any condition that endangers public health.";
    const defs = extractDefinitions(text, "1.04.010");
    expect(defs.length).toBeGreaterThanOrEqual(1);
  });

  test("filters out definitions that are too long", () => {
    const longDef = "Building shall mean " + "x".repeat(600) + ".";
    const defs = extractDefinitions(longDef, "1.04.020");
    expect(defs).toEqual([]);
  });

  test("filters out terms with numbers", () => {
    const text = "Section3 shall mean a numbered division of the code.";
    const defs = extractDefinitions(text, "1.04.030");
    expect(defs.find(d => d.term.includes("Section3"))).toBeUndefined();
  });
});

describe("buildGlossary", () => {
  test("returns array of DefinitionEntry objects", () => {
    const sections = [
      { number: "1.04.010", text: "Building shall mean any structure used for occupancy." },
      { number: "2.04.020", text: "Dwelling means a building for living purposes." },
    ];
    const glossary = buildGlossary(sections);
    expect(Array.isArray(glossary)).toBe(true);
    expect(glossary.length).toBeGreaterThanOrEqual(1);
    for (const entry of glossary) {
      expect(entry).toHaveProperty("term");
      expect(entry).toHaveProperty("definition");
      expect(entry).toHaveProperty("sectionNumber");
    }
  });

  test("prefers Title 1 definitions in sort order", () => {
    const sections = [
      { number: "17.04.010", text: "Building shall mean a zoning structure." },
      { number: "1.04.010", text: "Building shall mean a general structure for occupancy." },
    ];
    const glossary = buildGlossary(sections);
    const buildingEntries = glossary.filter(g => g.term.toLowerCase().includes("building"));
    if (buildingEntries.length > 0) {
      // Title 1 entry should come first
      expect(buildingEntries[0].sectionNumber.startsWith("1.")).toBe(true);
    }
  });
});

describe("extractEffectiveDate edge cases", () => {
  test("handles multiple amendments with mixed years", () => {
    const result = extractEffectiveDate("Ord. No. 100, 2005; Ord. No. 200, 2010; Ord. No. 300, 2008");
    expect(result).toBe(2010);
  });

  test("returns null for text without year", () => {
    expect(extractEffectiveDate("Ord. No. 100")).toBeNull();
  });

  test("handles ordinance without 'No.' prefix", () => {
    const result = extractEffectiveDate("Ord. 500, 2015");
    expect(result).toBe(2015);
  });
});

describe("computeAlertSeverity 8-monitor edge cases", () => {
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

  test("earthquake emergency overrides calm", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami,
      { events: [{ magnitude: 8.0, distanceKm: 100, tsunami: 2, place: "offshore" }] },
      calmInputs.weather, calmInputs.tides, calmInputs.fishing,
      calmInputs.airQuality, calmInputs.wildfire, calmInputs.marine,
    );
    expect(report.level).toBe("EMERGENCY");
    expect(report.reason).toContain("Earthquake");
  });

  test("tsunami warning is EMERGENCY", () => {
    const report = computeAlertSeverity(
      { warningCount: 1, watchCount: 0 },
      calmInputs.earthquake, calmInputs.weather, calmInputs.tides, calmInputs.fishing,
      calmInputs.airQuality, calmInputs.wildfire, calmInputs.marine,
    );
    expect(report.level).toBe("EMERGENCY");
  });

  test("air quality WARNING when AQI > 200", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing,
      { maxAqi: 250, available: true },
      calmInputs.wildfire, calmInputs.marine,
    );
    expect(report.monitors.airQuality.level).toBe("WARNING");
  });

  test("wildfire with large fire nearby = WARNING", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing, calmInputs.airQuality,
      { incidentCount: 1, hasEvacuationOrders: false, hasLargeFireNearby: true },
      calmInputs.marine,
    );
    expect(report.monitors.wildfire.level).toBe("WARNING");
  });

  test("all 8 monitor statuses present in report", () => {
    const report = computeAlertSeverity(
      calmInputs.tsunami, calmInputs.earthquake, calmInputs.weather,
      calmInputs.tides, calmInputs.fishing, calmInputs.airQuality,
      calmInputs.wildfire, calmInputs.marine,
    );
    expect(report.monitors).toHaveProperty("tsunami");
    expect(report.monitors).toHaveProperty("earthquake");
    expect(report.monitors).toHaveProperty("weather");
    expect(report.monitors).toHaveProperty("tides");
    expect(report.monitors).toHaveProperty("fishing");
    expect(report.monitors).toHaveProperty("airQuality");
    expect(report.monitors).toHaveProperty("wildfire");
    expect(report.monitors).toHaveProperty("marine");
  });
});

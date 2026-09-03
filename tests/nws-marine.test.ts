/**
 * Tests for src/alerts/nws_marine.ts — the NWS Coastal Waters Forecast
 * (CWF) monitor for Crescent City's nearshore zone. Pure classifiers over a
 * verbatim excerpt of the live 2026-09-03 KEKA CWF product (US government
 * text, public domain). No network, no mocks.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyMarineForecastPeriod,
  extractZoneForecast,
  parseForecastPeriods,
  parseSeasFt,
  parseWindKt,
  toMarineZoneForecast,
  worstMarineLevel,
  MARINE_ZONE_CODE,
} from "../src/alerts/nws_marine";

/** Verbatim excerpt shape from the live 2026-09-03 KEKA CWF (FZUS56 KEKA). */
const CWF_TEXT = `PZZ400-040515-
Inner waters from Point Mugu to San Mateo Point CA-

PZZ450-040515-
Coastal waters from Pt. St. George to Cape Mendocino CA out 10 nm-
913 AM PDT Thu Sep 3 2026

.REST OF TODAY...S wind 5 to 10 kt. Seas 6 ft. Wave
Detail: W 6 ft at 10 seconds and S 2 ft at 12 seconds. Patchy
dense fog. A chance of rain. 
.TONIGHT...NE wind 5 kt. Seas 6 ft. Wave Detail: NW
6 ft at 11 seconds and S 2 ft at 12 seconds. Patchy fog. 
.FRI...S wind 5 to 10 kt. Seas 7 ft. Wave Detail: NW 7 ft
at 11 seconds and S 2 ft at 11 seconds. 
.SUN...NW wind 10 to 15 kt. Seas 5 ft. Wave Detail: NW
4 ft at 9 seconds and S 2 ft at 12 seconds. 

PZZ455-040515-
Coastal waters from Cape Mendocino to Pt. Arena CA out 10 nm-
913 AM PDT Thu Sep 3 2026

.REST OF TODAY...NW wind 10 kt. Seas 5 ft. 

$$`;

describe("parseWindKt", () => {
  test("reads the CWF range and single-value shapes", () => {
    expect(parseWindKt("S wind 5 to 10 kt. Seas 6 ft.")).toEqual({ min: 5, max: 10 });
    expect(parseWindKt("NE wind 5 kt.")).toEqual({ min: null, max: 5 });
    expect(parseWindKt("winds to 25 kt increasing")).toEqual({ min: null, max: 25 });
    expect(parseWindKt("no wind mention here")).toEqual({ min: null, max: null });
  });
});

describe("parseSeasFt", () => {
  test("reads single and ranged seas, takes the max of a range", () => {
    expect(parseSeasFt("Seas 6 ft.")).toBe(6);
    expect(parseSeasFt("seas 5 to 8 ft")).toBe(8);
    expect(parseSeasFt("no seas")).toBeNull();
  });
});

describe("classifyMarineForecastPeriod", () => {
  test("ranks headline and wind-threshold conditions strongest-first", () => {
    expect(classifyMarineForecastPeriod("STORM WARNING conditions", 20)).toBe("EMERGENCY");
    expect(classifyMarineForecastPeriod("Hurricane Force Wind Warning", null)).toBe("EMERGENCY");
    expect(classifyMarineForecastPeriod("calm text", 48)).toBe("EMERGENCY");
    expect(classifyMarineForecastPeriod("GALE WARNING in effect", 10)).toBe("WARNING");
    expect(classifyMarineForecastPeriod("HAZARDOUS SEAS WARNING", null)).toBe("WARNING");
    expect(classifyMarineForecastPeriod("winds building", 34)).toBe("WARNING");
    expect(classifyMarineForecastPeriod("SMALL CRAFT ADVISORY area", null)).toBe("ADVISORY");
    expect(classifyMarineForecastPeriod("breezy", 21)).toBe("ADVISORY");
    expect(classifyMarineForecastPeriod("SMALL CRAFT SHOULD EXERCISE CAUTION", null)).toBe("WATCH");
    expect(classifyMarineForecastPeriod("light winds", 5)).toBe("CALM");
  });
});

describe("worstMarineLevel", () => {
  test("returns the strongest level and the period that set it", () => {
    const periods = [
      { period: "TODAY", windKtMin: 5, windKtMax: 10, seasFt: 6, text: "S wind 5 to 10 kt. Seas 6 ft." },
      { period: "TONIGHT", windKtMin: 20, windKtMax: 30, seasFt: 9, text: "W wind 20 to 30 kt. GALE WARNING possible. Seas 9 ft." },
      { period: "FRI", windKtMin: 5, windKtMax: 10, seasFt: 7, text: "S wind 5 to 10 kt." },
    ];
    expect(worstMarineLevel(periods)).toEqual({ level: "WARNING", period: "TONIGHT" });
    expect(worstMarineLevel([])).toEqual({ level: "CALM", period: null });
  });
});

describe("extractZoneForecast", () => {
  test("extracts PZZ450 with title and issuance from the real product shape", () => {
    const zone = extractZoneForecast(CWF_TEXT, "PZZ450");
    expect(zone).not.toBeNull();
    expect(zone!.zoneTitle).toBe("Coastal waters from Pt. St. George to Cape Mendocino CA out 10 nm");
    expect(zone!.issuance).toBe("913 AM PDT Thu Sep 3 2026");
    expect(zone!.body).toContain(".REST OF TODAY...S wind 5 to 10 kt");
    expect(zone!.body).not.toContain("PZZ455");
  });

  test("returns null for an absent zone instead of a wrong forecast", () => {
    expect(extractZoneForecast(CWF_TEXT, "PZZ999")).toBeNull();
  });
});

describe("parseForecastPeriods", () => {
  test("splits wrapped CWF period segments into structured periods", () => {
    const zone = extractZoneForecast(CWF_TEXT, "PZZ450")!;
    const periods = parseForecastPeriods(zone.body);
    expect(periods.length).toBeGreaterThanOrEqual(4);
    expect(periods[0]).toMatchObject({ period: "REST OF TODAY", windKtMin: 5, windKtMax: 10, seasFt: 6 });
    expect(periods[1]).toMatchObject({ period: "TONIGHT", windKtMax: 5 });
    expect(periods[3]?.period).toBe("SUN");
    expect(periods[3]?.windKtMax).toBe(15);
  });
});

describe("toMarineZoneForecast", () => {
  test("builds the full report from the real product text", () => {
    const forecast = toMarineZoneForecast(CWF_TEXT, "2026-09-03T16:13:00Z");
    expect(forecast).not.toBeNull();
    expect(forecast!.zone).toBe(MARINE_ZONE_CODE);
    expect(forecast!.office).toBe("KEKA");
    expect(forecast!.peakWindKt).toBe(15);
    expect(forecast!.worstLevel).toBe("CALM");
    expect(forecast!.summary).toContain("peak forecast wind 15 kt");
  });

  test("returns null when the zone block is missing", () => {
    expect(toMarineZoneForecast("PZZ400-040515-\nSome other zone-\n. TODAY...N wind 5 kt.\n\n$$")).toBeNull();
  });
});

/**
 * Tests for src/section_longevity.ts — section age, churn, and dormancy.
 * Pure: fixture sections, a pinned `asOfYear`, no filesystem, no network.
 */
import { describe, expect, test } from "bun:test";
import { buildSectionLongevity, SECTION_LONGEVITY_SCHEMA } from "../src/section_longevity";

const AS_OF = 2020;

const sections = [
  // Enacted 1990, amended twice → age 30, 10 years dormant, churn 0.67/decade.
  { guid: "a", number: "8.04.010", title: "Rates", history: "Ord. No. 100, enacted 1990; Ord. No. 200, amended 2005; Ord. No. 300, amended 2010" },
  // Enacted 1975, never amended → age 45, 45 years dormant.
  { guid: "b", number: "8.04.020", title: "Old", history: "Ord. No. 50, enacted 1975" },
  // Enacted 2018, amended 2019 → recent.
  { guid: "c", number: "12.08.010", title: "Harbor", history: "Ord. No. 900, enacted 2018; Ord. No. 901, amended 2019" },
  // No parseable year → unknown, excluded from every statistic.
  { guid: "d", number: "17.56.040", title: "Zoning", history: "Ord. No. 777, amended" },
  // No history at all.
  { guid: "e", number: "5.02.010", title: "Admin", history: "" },
];

describe("buildSectionLongevity", () => {
  test("per-section ages are measured against asOfYear, not the wall clock", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 50 });
    expect(report.schemaVersion).toBe(SECTION_LONGEVITY_SCHEMA);
    expect(report.asOfYear).toBe(AS_OF);
    const a = report.oldest.find((s) => s.guid === "a")!;
    expect(a).toMatchObject({
      enactedYear: 1990,
      lastAmendedYear: 2010,
      ageYears: 30,
      yearsSinceLastAmendment: 10,
      status: "amended",
    });
    // Two amendments after the first, over 30 years of life.
    expect(a.churnPerDecade).toBeCloseTo((2 / 30) * 10, 2);
  });

  test("undatable sections are `unknown` and excluded from every statistic", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 50 });
    expect(report.summary.sectionsScanned).toBe(5);
    expect(report.summary.withHistory).toBe(3);
    expect(report.summary.withoutHistory).toBe(2);
    for (const list of [report.oldest, report.mostAmended, report.stalest, report.recentlyAmended]) {
      expect(list.some((s) => s.guid === "d" || s.guid === "e")).toBe(false);
    }
    // The undated section's amendment was still parsed — it just has no year.
    expect(report.summary.oldestYear).toBe(1975);
    expect(report.summary.newestYear).toBe(2019);
  });

  test("a single dated action is `original`, not a zero-amendment `amended`", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 50 });
    const b = report.oldest.find((s) => s.guid === "b")!;
    expect(b.status).toBe("original");
    expect(b.churnPerDecade).toBe(0);
    expect(report.summary.neverAmended).toBe(1);
  });

  test("medians and the dormancy count use only dated sections", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 50 });
    // Ages of the three dated sections: 30, 45, 2 → median 30.
    expect(report.summary.medianAgeYears).toBe(30);
    // Years since amendment: 10, 45, 1 → median 10.
    expect(report.summary.medianYearsSinceLastAmendment).toBe(10);
    // Only b (45 years) crosses the 20-year dormancy line.
    expect(report.summary.dormantOver20Years).toBe(1);
  });

  test("rankings order by their own key with unknowns absent", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 50 });
    expect(report.oldest[0]?.guid).toBe("b");
    expect(report.stalest[0]?.guid).toBe("b");
    expect(report.recentlyAmended[0]?.guid).toBe("c");
    expect(report.mostAmended[0]?.guid).toBe("a");
  });

  test("the decade histogram buckets enactment and last-touch separately", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 50 });
    const byDecade = Object.fromEntries(report.byDecade.map((d) => [d.decade, d]));
    expect(report.byDecade.map((d) => d.decade)).toEqual([1970, 1980, 1990, 2000, 2010]);
    expect(byDecade[1970]).toMatchObject({ enacted: 1, lastTouched: 1 });
    expect(byDecade[1990]).toMatchObject({ enacted: 1, lastTouched: 0 });
    expect(byDecade[2010]).toMatchObject({ enacted: 1, lastTouched: 2 });
    // 1980 and 2000 saw no enactment or last-touch, but the histogram is
    // contiguous so a chart cannot compress the empty stretch away.
    expect(byDecade[1980]).toMatchObject({ enacted: 0, lastTouched: 0 });
    expect(byDecade[2000]).toMatchObject({ enacted: 0, lastTouched: 0 });
  });

  test("title filter scopes the profile", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, titleFilter: "8.04", limit: 50 });
    expect(report.titleFilter).toBe("8.04");
    expect(report.summary.sectionsScanned).toBe(2);
    expect(report.summary.withHistory).toBe(2);
  });

  test("limit bounds every ranking and records the bound", () => {
    const report = buildSectionLongevity(sections, { asOfYear: AS_OF, limit: 1 });
    expect(report.oldest).toHaveLength(1);
    expect(report.mostAmended).toHaveLength(1);
    expect(report.truncated).toBe(true);
  });

  test("an empty corpus yields nulls, not fabricated years", () => {
    const report = buildSectionLongevity([], { asOfYear: AS_OF });
    expect(report.summary).toMatchObject({
      sectionsScanned: 0,
      withHistory: 0,
      withoutHistory: 0,
      oldestYear: null,
      newestYear: null,
      medianAgeYears: null,
      medianYearsSinceLastAmendment: null,
    });
    expect(report.byDecade).toEqual([]);
  });

  test("output is deterministic for identical input", () => {
    const a = buildSectionLongevity(sections, { asOfYear: AS_OF });
    const b = buildSectionLongevity(sections, { asOfYear: AS_OF });
    expect({ ...a, generatedAt: "" }).toEqual({ ...b, generatedAt: "" });
  });
});

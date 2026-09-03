/**
 * Tests for src/ordinance_chronology.ts — ordinance chronology and city-wide
 * legislative lineage. Pure: fixture sections, no filesystem, no network.
 */
import { describe, expect, test } from "bun:test";
import { buildOrdinanceChronology } from "../src/ordinance_chronology";

const sections = [
  { guid: "g1", number: "8.04.010", title: "Rates", history: "Ord. No. 123, enacted 1995; Ord. No. 200, amended 2001", articleTitle: "SEWER CHARGES" },
  { guid: "g2", number: "8.04.020", title: "Later rates", history: "Ord. No. 123, repealed 2010", articleTitle: "SEWER CHARGES" },
  { guid: "g3", number: "12.08.010", title: "Harbor", history: "No ordinance references on this line", articleTitle: "HARBOR" },
  { guid: "g4", number: "5.02.010", title: "Empty", history: "", articleTitle: "ADMIN" },
];

describe("buildOrdinanceChronology", () => {
  test("per-section chronology: trail sorted oldest-first with year bounds", () => {
    const report = buildOrdinanceChronology(sections);
    const g1 = report.sectionChronologies.find((s) => s.guid === "g1")!;
    expect(g1.amendments).toHaveLength(2);
    expect(g1.amendments[0]).toMatchObject({ ordinance: "Ord. No. 123", action: "enacted", year: 1995 });
    expect(g1.amendments[1]).toMatchObject({ ordinance: "Ord. No. 200", action: "amended", year: 2001 });
    expect(g1.firstYear).toBe(1995);
    expect(g1.lastYear).toBe(2001);
    expect(g1.articleTitle).toBe("SEWER CHARGES");
  });

  test("sections without ordinance references are excluded and counted", () => {
    const report = buildOrdinanceChronology(sections);
    expect(report.summary.sectionsScanned).toBe(4);
    expect(report.summary.sectionsWithOrdinanceHistory).toBe(2);
    expect(report.sectionChronologies.map((s) => s.guid).sort()).toEqual(["g1", "g2"]);
    expect(report.summary.totalAmendments).toBe(3);
  });

  test("city timeline groups sections per ordinance, newest first", () => {
    const report = buildOrdinanceChronology(sections);
    expect(report.summary.distinctOrdinances).toBe(2);
    expect(report.cityTimeline[0]?.ordinance).toBe("Ord. No. 200");
    expect(report.cityTimeline[0]?.year).toBe(2001);
    const ord123 = report.cityTimeline.find((o) => o.ordinance === "Ord. No. 123")!;
    // Earliest year across sections; enacted + repealed both recorded.
    expect(ord123.year).toBe(1995);
    expect(ord123.sectionNumbers.sort()).toEqual(["8.04.010", "8.04.020"]);
    expect(ord123.sectionCount).toBe(2);
    expect(ord123.actions.sort()).toEqual(["enacted", "repealed"]);
    expect(report.summary.earliestYear).toBe(1995);
    expect(report.summary.latestYear).toBe(2010);
  });

  test("unknown-year amendments sort last and never poison the year range", () => {
    const withUnknown = [
      ...sections,
      { guid: "g5", number: "9.20.010", title: "Undated", history: "Ord. No. 123, enacted 1988; Ord. No. 777, amended", articleTitle: "X" },
    ];
    const report = buildOrdinanceChronology(withUnknown);
    const g5 = report.sectionChronologies.find((s) => s.guid === "g5")!;
    expect(g5.amendments[0]?.year).toBe(1988);
    expect(g5.amendments[1]).toMatchObject({ ordinance: "Ord. No. 777", year: null });
    expect(g5.firstYear).toBe(1988);
    expect(g5.lastYear).toBe(1988);
    // The dated range never adopted the null sentinel.
    expect(report.summary.earliestYear).toBe(1988);
    expect(report.summary.latestYear).toBe(2010);
  });

  test("limit bounds both lists and truncation is recorded", () => {
    const report = buildOrdinanceChronology(sections, { limit: 1 });
    expect(report.cityTimeline).toHaveLength(1);
    expect(report.sectionChronologies).toHaveLength(1);
    expect(report.truncated).toBe(true);
  });

  test("guidFilter yields exactly one section and honest scan count", () => {
    const report = buildOrdinanceChronology(sections, { guidFilter: "g2" });
    expect(report.summary.sectionsScanned).toBe(1);
    expect(report.sectionChronologies).toHaveLength(1);
    expect(report.sectionChronologies[0]?.guid).toBe("g2");
    expect(report.truncated).toBe(false);
  });

  test("empty input produces an empty but well-formed report", () => {
    const report = buildOrdinanceChronology([]);
    expect(report.summary.sectionsWithOrdinanceHistory).toBe(0);
    expect(report.summary.earliestYear).toBeNull();
    expect(report.cityTimeline).toEqual([]);
    expect(report.truncated).toBe(false);
  });
});

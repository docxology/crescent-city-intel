/**
 * Regression guard for the section-marker comparison defect.
 *
 * Scraped sections store their number WITH the marker (`"§ 8.04.010"`), while
 * every citation extracted from prose, every `?title=` filter, and every
 * user-typed lookup is bare. `resolveSectionNumber` and
 * `validateAllCrossReferences` compared the two forms directly, so no citation
 * could ever resolve: `GET /api/cross-refs/validate` reported 0 of 170 resolved
 * — a flat 0% resolution rate — and `GET /api/citations/{guid}` returned
 * `resolved: false` for every reference. `gui/search.ts` and
 * `domains/coverage.ts` had each inlined their own strip, which is why their
 * prefix matching worked and the resolver's did not.
 *
 * These tests pin the corrected behaviour on marker-carrying data specifically,
 * because a fixture written in the bare form passes either way — that is
 * exactly how the defect survived a 1300-test suite.
 */
import { describe, expect, test } from "bun:test";
import { normalizeSectionNumber } from "../src/utils";
import { buildSectionNumberIndex, resolveSectionNumber, resolveSectionNumberIndexed } from "../src/structured_queries";
import { buildSectionGraph } from "../src/section_graph";
import { buildWordFrequency } from "../src/word_frequency";
import { buildSectionLongevity } from "../src/section_longevity";

/** The shape the scraper actually produces: numbers carry the marker. */
const stored = [
  { guid: "a", number: "§ 8.04.010", title: "Rates", text: "See § 8.04.020.", history: "Ord. No. 1, enacted 1990" },
  { guid: "b", number: "§ 8.04.020", title: "Details", text: "See § 8.04.010 and § 17.56.", history: "Ord. No. 2, enacted 2000" },
  { guid: "c", number: "§ 17.56.040", title: "Zoning", text: "No citations.", history: "" },
];

describe("normalizeSectionNumber", () => {
  test("strips the marker and surrounding whitespace, and is idempotent", () => {
    expect(normalizeSectionNumber("§ 8.04.010")).toBe("8.04.010");
    expect(normalizeSectionNumber("§8.04.010")).toBe("8.04.010");
    expect(normalizeSectionNumber("  § 8.04.010  ")).toBe("8.04.010");
    expect(normalizeSectionNumber("8.04.010")).toBe("8.04.010");
    expect(normalizeSectionNumber(normalizeSectionNumber("§ 8.04.010"))).toBe("8.04.010");
    expect(normalizeSectionNumber("")).toBe("");
    expect(normalizeSectionNumber("§")).toBe("");
  });
});

describe("a bare citation resolves against a marker-carrying corpus", () => {
  test("exact match works across the two forms", () => {
    expect(resolveSectionNumber("8.04.010", stored)?.guid).toBe("a");
    // A marked query is accepted too — normalisation applies to both sides.
    expect(resolveSectionNumber("§ 8.04.010", stored)?.guid).toBe("a");
  });

  test("dot-boundary prefix match works, and does not over-match", () => {
    expect(resolveSectionNumber("17.56", stored)?.guid).toBe("c");
    // "17.5" must not reach 17.56.040 — the boundary rule survives the fix.
    expect(resolveSectionNumber("17.5", stored)).toBeUndefined();
  });

  test("an empty or marker-only query resolves to nothing rather than the first section", () => {
    expect(resolveSectionNumber("", stored)).toBeUndefined();
    expect(resolveSectionNumber("§", stored)).toBeUndefined();
    const index = buildSectionNumberIndex(stored);
    expect(resolveSectionNumberIndexed("", index)).toBeUndefined();
  });

  test("the indexed resolver agrees with the linear one on marked data", () => {
    const index = buildSectionNumberIndex(stored);
    for (const probe of ["8.04.010", "8.04.020", "17.56", "17.56.040", "17.5", "8.04", "9.99.999", "§ 8.04.010", ""]) {
      expect(resolveSectionNumberIndexed(probe, index)).toBe(resolveSectionNumber(probe, stored));
    }
  });
});

describe("citations resolve to real edges on marker-carrying data", () => {
  test("the section graph finds the edges instead of reporting an empty graph", () => {
    const report = buildSectionGraph(stored);
    // a→b and b→a; b's "§ 17.56" prefix-resolves to c.
    expect(report.summary.edges).toBe(3);
    expect(report.summary.resolutionRate).toBe(1);
    expect(report.summary.reciprocalPairs).toBe(1);
    expect(report.summary.isolatedNodes).toBe(0);
  });
});

describe("title filters scope marker-carrying numbers", () => {
  test("the graph, lexicon, and longevity filters all match", () => {
    expect(buildSectionGraph(stored, { titleFilter: "8" }).summary.nodes).toBe(2);
    expect(buildWordFrequency(stored, { titleFilter: "8" }).summary.sectionsScanned).toBe(2);
    expect(buildSectionLongevity(stored, { titleFilter: "8", asOfYear: 2020 }).summary.sectionsScanned).toBe(2);
    // A marked filter value works too, and "17.5" still must not match 17.56.040.
    expect(buildSectionGraph(stored, { titleFilter: "§ 17" }).summary.nodes).toBe(1);
    expect(buildSectionGraph(stored, { titleFilter: "17.5" }).summary.nodes).toBe(0);
  });
});

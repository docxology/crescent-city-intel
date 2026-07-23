import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import {
  parseLegislativeHistory,
  resolveSectionNumber,
  findSimilarSections,
} from "../src/structured_queries.js";
import { loadAllSections } from "../src/shared/data.js";
import { paths } from "../src/shared/paths.js";

// Tests run against real scraped output/ if present; otherwise skip gracefully
// (same convention as tests/shared-data.test.ts).
const hasOutput = existsSync(paths.toc) && existsSync(paths.manifest);

describe("parseLegislativeHistory", () => {
  test("parses a single ordinance entry", () => {
    const result = parseLegislativeHistory("Ord. No. 942 § 1, 2011");
    expect(result).toHaveLength(1);
    expect(result[0].ordinance).toBe("Ord. No. 942");
    expect(result[0].action).toBe("amended");
    expect(result[0].date).toBe("2011");
  });

  test("parses multiple entries separated by semicolons", () => {
    const result = parseLegislativeHistory("Ord. No. 942 § 1, 2011; Ord. No. 723 § 1, 2004");
    expect(result).toHaveLength(2);
    expect(result[0].ordinance).toBe("Ord. No. 942");
    expect(result[1].ordinance).toBe("Ord. No. 723");
  });

  test("detects enacted action", () => {
    const result = parseLegislativeHistory("Ord. No. 500 enacted 1998");
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("enacted");
  });

  test("detects repealed action", () => {
    const result = parseLegislativeHistory("Ord. No. 300 repealed 2001");
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("repealed");
  });

  test("returns empty for empty string", () => {
    expect(parseLegislativeHistory("")).toEqual([]);
    expect(parseLegislativeHistory("   ")).toEqual([]);
  });

  test("handles null/undefined input", () => {
    expect(parseLegislativeHistory(null as any)).toEqual([]);
    expect(parseLegislativeHistory(undefined as any)).toEqual([]);
  });
});

describe("resolveSectionNumber — prefix-match dot boundary", () => {
  // Regression test for a boundary bug: the prefix-match fallback used to do
  // `s.number.startsWith(sectionNumber)` with no separator check, so a citation
  // like "§ 17.5" could falsely resolve against an unrelated section "17.56.040"
  // (since "17.56.040".startsWith("17.5") is true even though chapter 17.5 and
  // chapter 17.56 are different chapters). The fix requires a "." immediately
  // after the matched prefix.

  const corpus = [
    { guid: "g1", number: "17.56.040" },
    { guid: "g2", number: "17.04.010" },
    { guid: "g3", number: "8.04.020" },
  ];

  test("does NOT resolve a short digit-string prefix to an unrelated sibling chapter", () => {
    // "17.5" is a plain digit-string prefix of "17.56.040" but is NOT its
    // chapter — chapter 17.5 does not exist in this corpus at all.
    const result = resolveSectionNumber("17.5", corpus);
    expect(result).toBeUndefined();
  });

  test("still resolves a real dot-bounded chapter prefix", () => {
    // "17.56" IS a genuine chapter prefix of "17.56.040".
    const result = resolveSectionNumber("17.56", corpus);
    expect(result).toBeDefined();
    expect(result!.guid).toBe("g1");
  });

  test("resolves an exact section number match", () => {
    const result = resolveSectionNumber("8.04.020", corpus);
    expect(result).toBeDefined();
    expect(result!.guid).toBe("g3");
  });

  test("returns undefined when nothing matches", () => {
    expect(resolveSectionNumber("99.99", corpus)).toBeUndefined();
  });
});

describe("findSimilarSections — limit edge cases", () => {
  // Regression test for a bug where a negative `limit` reached
  // `Array.prototype.slice(0, limit)` unguarded. `slice(0, -1)` means "all
  // but the last element", not "zero results" — so a negative limit silently
  // returned nearly the entire scored list instead of an empty/small result.
  // This is reachable from the real HTTP API: src/gui/routes.ts parses
  // `?limit=` with `parseInt(...) || 10`, and that `|| 10` fallback does NOT
  // catch negative numbers (they're truthy), so `?limit=-1` flows straight
  // through to findSimilarSections unmodified.

  test("negative limit returns an empty array, not slice(0, -1) semantics", async () => {
    if (!hasOutput) return;
    const sections = await loadAllSections();
    if (sections.length < 2) return;
    const target = sections[0];

    const normal = await findSimilarSections(target.guid, 10);
    const negative = await findSimilarSections(target.guid, -1);

    expect(negative).toEqual([]);
    // Sanity: the positive-limit call is a meaningful comparison baseline —
    // it must not itself be empty when there's a large real corpus to search.
    if (sections.length > 20) {
      expect(normal.length).toBeGreaterThan(0);
    }
  });

  test("zero limit returns an empty array", async () => {
    if (!hasOutput) return;
    const sections = await loadAllSections();
    if (sections.length === 0) return;
    const result = await findSimilarSections(sections[0].guid, 0);
    expect(result).toEqual([]);
  });
});

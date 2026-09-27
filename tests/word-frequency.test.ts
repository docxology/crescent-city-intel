/**
 * Tests for src/word_frequency.ts — corpus word-frequency and distinctiveness.
 * Pure: fixture sections, no filesystem, no network.
 */
import { describe, expect, test } from "bun:test";
import { buildWordFrequency, WORD_FREQUENCY_SCHEMA } from "../src/word_frequency";
import { LEGAL_STOP_WORDS } from "../src/gui/search";

const sections = [
  { guid: "a", number: "8.04.010", title: "Rates", text: "The sewer rates shall apply to every sewer connection in the city." },
  { guid: "b", number: "8.04.020", title: "Connections", text: "A sewer connection requires a permit; the permit shall be issued by the city." },
  { guid: "c", number: "17.56.040", title: "Zoning", text: "Zoning districts govern land use; zoning applies to each parcel." },
];

describe("buildWordFrequency", () => {
  test("reports the schema, scan totals, and a bounded ranking", () => {
    const report = buildWordFrequency(sections, { limit: 5 });
    expect(report.schemaVersion).toBe(WORD_FREQUENCY_SCHEMA);
    expect(report.titleFilter).toBeNull();
    expect(report.summary.sectionsScanned).toBe(3);
    expect(report.summary.totalTokens).toBeGreaterThan(0);
    expect(report.topByFrequency.length).toBeLessThanOrEqual(5);
    expect(report.topBySalience.length).toBeLessThanOrEqual(5);
  });

  test("stop words and legal boilerplate never enter the index", () => {
    const report = buildWordFrequency(sections, { limit: 500 });
    const terms = new Set(report.topByFrequency.map((t) => t.term));
    for (const stopWord of ["the", "shall", "city", "section", "code"]) {
      expect(LEGAL_STOP_WORDS.has(stopWord)).toBe(true);
      expect(terms.has(stopWord)).toBe(false);
    }
  });

  test("counts aggregate across sections and documentFrequency counts sections", () => {
    const report = buildWordFrequency(sections, { limit: 500 });
    const sewer = report.topByFrequency.find((t) => t.surface === "sewer")!;
    expect(sewer).toBeDefined();
    // "sewer" appears twice in a and once in b.
    expect(sewer.count).toBe(3);
    expect(sewer.documentFrequency).toBe(2);
    expect(sewer.documentFrequencyRatio).toBeCloseTo(2 / 3, 4);
  });

  test("salience is zero for a term present in every section", () => {
    // "permit" is only in b; craft a corpus where one term is universal.
    const universal = [
      { guid: "a", number: "1.01.010", title: "A", text: "harbor harbor dredging" },
      { guid: "b", number: "1.01.020", title: "B", text: "harbor mooring" },
    ];
    const report = buildWordFrequency(universal, { limit: 50 });
    const harbor = report.topByFrequency.find((t) => t.surface === "harbor")!;
    expect(harbor.documentFrequency).toBe(2);
    expect(harbor.salience).toBe(0);
    // A term in only one of two sections carries positive salience.
    const dredging = report.topBySalience.find((t) => t.surface.startsWith("dredg"))!;
    expect(dredging.salience).toBeGreaterThan(0);
  });

  test("surface form is the most common spelling behind the stem", () => {
    const stemmed = [
      { guid: "a", number: "2.01.010", title: "A", text: "permits permits permit" },
    ];
    const report = buildWordFrequency(stemmed, { limit: 10 });
    const entry = report.topByFrequency[0];
    expect(entry.count).toBe(3);
    expect(entry.surface).toBe("permits");
  });

  test("title filter scopes the scan", () => {
    const report = buildWordFrequency(sections, { titleFilter: "17", limit: 50 });
    expect(report.titleFilter).toBe("17");
    expect(report.summary.sectionsScanned).toBe(1);
    expect(report.topByFrequency.some((t) => t.surface === "sewer")).toBe(false);
    expect(report.topByFrequency.some((t) => t.surface.startsWith("zoning"))).toBe(true);
  });

  test("section titles are tokenised, so heading-only terms get a document frequency", () => {
    // The module documents itself as mirroring the BM25 index's tokenisation,
    // and the index feeds BOTH `text` and `title` into one term map. A term
    // appearing only in a heading (very common: "Appeals", "Definitions") had
    // index df > 0 but this module's df 0, so it was missing from
    // topBySalience instead of correctly scoring 0 as universal boilerplate.
    const report = buildWordFrequency([
      { guid: "a", number: "1.01.010", title: "Appeals", text: "A person may appeal." },
      { guid: "b", number: "1.01.020", title: "Appeals", text: "Another person may appeal." },
    ], { limit: 50 });
    const appeals = report.topByFrequency.find((e: { term: string }) => e.term === "appeal");
    expect(appeals).toBeDefined();
    expect(appeals!.documentFrequency).toBe(2);
    // Present in every section, so it has no discriminative value.
    expect(appeals!.salience).toBe(0);
  });

  test("the vocabulary summary describes the filtered tables, not the raw corpus", () => {
    // distinctTerms/hapaxCount were computed before the minDocumentFrequency
    // filter, so with `minDf=2` the summary reported a vocabulary the two
    // ranked lists did not contain.
    const sections = [
      { guid: "a", number: "1.01.010", title: "T", text: "harbor harbor harbor dock" },
      { guid: "b", number: "1.01.020", title: "T", text: "harbor dock dock" },
      { guid: "c", number: "1.01.030", title: "T", text: "harbor dock" },
    ];
    const report = buildWordFrequency(sections, { minDocumentFrequency: 2, limit: 50 });
    const listed = new Set([...report.topByFrequency, ...report.topBySalience].map((e: { term: string }) => e.term));
    for (const term of listed) {
      expect(report.summary.distinctTerms).toBeGreaterThanOrEqual(listed.size);
    }
    // Every term the summary counts is actually present in the tables.
    expect(report.summary.distinctTerms).toBe(listed.size);
    // "dock" appears in all three sections so it survives minDf=2.
    expect(listed.has("dock")).toBe(true);
  });

  test("a non-finite limit falls back to the default rather than emptying the tables", () => {
    // `Math.max(1, NaN)` is NaN, `[].slice(0, NaN)` is [], and `x > NaN` is
    // false — so a direct caller passing `limit: NaN` got empty tables with
    // `truncated: false`, claiming nothing was cut when everything was.
    const report = buildWordFrequency(
      [{ guid: "a", number: "1.01.010", title: "T", text: "harbor dock quay" }],
      { limit: Number.NaN as unknown as number },
    );
    expect(report.topByFrequency.length).toBeGreaterThan(0);
    expect(report.truncated).toBe(false);
  });

  test("minLength and minDocumentFrequency filter the ranking", () => {
    const long = buildWordFrequency(sections, { minLength: 8, limit: 50 });
    expect(long.topByFrequency.every((t) => t.surface.length >= 8)).toBe(true);

    const common = buildWordFrequency(sections, { minDocumentFrequency: 2, limit: 50 });
    expect(common.topByFrequency.every((t) => t.documentFrequency >= 2)).toBe(true);
  });

  test("an empty corpus yields zeroed statistics, not NaN", () => {
    const report = buildWordFrequency([], { limit: 10 });
    expect(report.summary).toMatchObject({
      sectionsScanned: 0,
      totalTokens: 0,
      distinctTerms: 0,
      typeTokenRatio: 0,
      meanTokensPerSection: 0,
    });
    expect(report.topByFrequency).toEqual([]);
    expect(report.truncated).toBe(false);
  });

  test("output is deterministic for identical input", () => {
    const a = buildWordFrequency(sections, { limit: 20 });
    const b = buildWordFrequency(sections, { limit: 20 });
    expect({ ...a, generatedAt: "" }).toEqual({ ...b, generatedAt: "" });
  });
});

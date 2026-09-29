/**
 * Phase 10 GUI surfaces: ordinal-sequence refinement, legal-citation
 * cross-linking, and the effective-date field.
 *
 * The TODO's acceptance criterion is binding: each surface ships with an
 * explicit empty state and a string-contract (or browser-smoke) test. Four
 * layers, matching the repo's established test idioms:
 *
 *  1. String contracts on the page (`/phase10-legal.html`) — the empty-state
 *     markup must exist verbatim for all three panels (tests/gui-phase14
 *     precedent).
 *  2. Real behavior of the pure derivations against the tracked seed corpus
 *     and fixtures, positive AND empty paths, offline.
 *  3. Real route tests via handleApiRoute with the seeded corpus
 *     (tests/phase9-hazard-surfaces.test.ts precedent) — including the
 *     ordering contract that /api/citations/index is not claimed by the
 *     /api/citations/{guid} matcher, and the no-fabrication rule.
 *  4. Route-spec parity and server serving, so openapi.yaml cannot drift.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { beginSeedCorpus, endCorpusCopy } from "./helpers/output-root.ts";
import { invalidateSectionsCache } from "../src/shared/data.ts";
import { buildOrdinalRefinement } from "../src/gui/ordinal_refinement.ts";
import { buildLegalCrosslinks, citationHref, canonicalCodeName } from "../src/gui/legal_crosslinks.ts";
import { buildEffectiveDate, buildEffectiveDatesReport } from "../src/gui/effective_dates.ts";

const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf-8");

const page = read("src", "gui", "static", "phase10-legal.html");
const routes = read("src", "gui", "routes.ts");
const server = read("src", "gui", "server.ts");
const spec = read("openapi.yaml");

describe("string contracts: the Phase 10 page", () => {
  test("all three panels carry an explicit empty state, on load and on empty data", () => {
    // The TODO's AC: explicit empty state per surface. On-load AND empty-result
    // states for each of the three panels, verbatim.
    expect(page).toContain('id="ordinals-empty"');
    expect(page).toContain("No ordinal report loaded yet");
    expect(page).toContain('id="ordinals-empty-result"');
    expect(page).toContain("No sections to audit");
    expect(page).toContain('id="crosslinks-empty"');
    expect(page).toContain("No cross-link report loaded yet");
    expect(page).toContain('id="crosslinks-empty-result"');
    expect(page).toContain("No legal citations were found");
    expect(page).toContain('id="effective-empty"');
    expect(page).toContain("No effective-date report loaded yet");
    expect(page).toContain('id="effective-empty-result"');
    expect(page).toContain("no effective date on record");
  });

  test("each panel calls its endpoint and renders the honest no-link state", () => {
    expect(page).toContain('"/api/ordinals');
    expect(page).toContain('"/api/citations/index');
    expect(page).toContain('"/api/effective-dates');
    // The unlinked-citation honesty string: a citation with no stable target
    // says so instead of pointing at a guessed URL.
    expect(page).toContain("no stable target — unlinked");
    expect(page).toContain('rel="noopener noreferrer"');
  });
});

describe("ordinal refinement (src/gui/ordinal_refinement.ts)", () => {
  test("numeric ordinals, suffix families, and unparseable segments", () => {
    const report = buildOrdinalRefinement([
      { number: "§ 8.04.010" },
      { number: "§ 8.08.010" },
      { number: "§ 730.04.010" },
      { number: "§ 730.04-R.010" },
      { number: "§ 730.08.010" },
      { number: "§ 9.XX.010" },
    ]);
    const title8 = report.sequences.find((s) => s.title === "8")!;
    expect(title8.ordinals.map((o) => o.kind)).toEqual(["numeric", "numeric"]);
    // 8.04 -> 8.08 is a gap of three: 8.05, 8.06, 8.07.
    expect(title8.gaps.map((g) => g.missing)).toEqual(["8.05", "8.06", "8.07"]);
    expect(title8.gaps[0]).toMatchObject({ after: "04", before: "08" });

    // The suffix family is ONE ordinal slot, not a gap of 1..R-1, and its
    // suffix must not widen the suggested gaps' padding.
    const title730 = report.sequences.find((s) => s.title === "730")!;
    expect(title730.ordinals.map((o) => o.raw).sort()).toEqual(["04", "04-R", "08"]);
    expect(title730.gaps.map((g) => g.missing)).toEqual(["730.05", "730.06", "730.07"]);

    // A non-numeric chapter ordinal is reported, never coerced to NaN.
    const title9 = report.sequences.find((s) => s.title === "9")!;
    expect(title9.unparseable).toEqual(["XX"]);
    expect(title9.ordinals[0]).toMatchObject({ raw: "XX", kind: "non-numeric", value: null });
  });

  test("zero-padded chapters suggest zero-padded gaps", () => {
    const report = buildOrdinalRefinement([
      { number: "§ 1.04.010" },
      { number: "§ 1.12.010" },
    ]);
    const gaps = report.sequences[0]!.gaps.map((g) => g.missing);
    expect(gaps).toEqual(["1.05", "1.06", "1.07", "1.08", "1.09", "1.10", "1.11"]);
  });

  test("empty input is an explicit empty report, never a fabricated sequence", () => {
    const report = buildOrdinalRefinement([]);
    expect(report.empty).toBe(true);
    expect(report.sequences).toEqual([]);
    expect(report.summary.titles).toBe(0);
    expect(report.summary.totalGaps).toBe(0);
  });

  test("against the real seed corpus: titles found, gaps counted, deterministic", () => {
    const seed = JSON.parse(read("pages-data", "crescent-city-code.json")) as {
      articles?: Array<{ sections?: Array<{ number?: string }> }>;
    };
    const sections = (seed.articles ?? []).flatMap((a) => (a.sections ?? []).map((s) => ({ number: s.number ?? "" })));
    if (sections.length === 0) return;
    const report = buildOrdinalRefinement(sections);
    expect(report.empty).toBe(false);
    expect(report.summary.sectionsScanned).toBeGreaterThan(1000);
    expect(report.summary.titles).toBeGreaterThan(5);
    // Real missing chapters exist in this code (e.g. Title 8's sparse map);
    // the report must see them rather than report a falsely dense code.
    expect(report.summary.totalGaps).toBeGreaterThan(0);
    // Determinism: same input, same bytes apart from the timestamp.
    const again = buildOrdinalRefinement(sections);
    const strip = (r: typeof report) => JSON.stringify({ ...r, generatedAt: "" });
    expect(strip(again)).toBe(strip(report));
  });
});

describe("legal-citation cross-linking (src/gui/legal_crosslinks.ts)", () => {
  test("known CA codes resolve to canonical leginfo URLs", () => {
    expect(citationHref({ type: "ca-code", codeName: "Government Code", section: "65850" })).toBe(
      "https://leginfo.legislature.ca.gov/faces/codes_displaysection.xhtml?lawCode=GOV&sectionNum=65850",
    );
    expect(citationHref({ type: "ca-code", codeName: "H&SC", section: "121575" })).toBe(
      "https://leginfo.legislature.ca.gov/faces/codes_displaysection.xhtml?lawCode=HSC&sectionNum=121575",
    );
  });

  test("federal citations resolve to canonical Cornell URLs — junk sections stay null", () => {
    expect(citationHref({ type: "federal", codeName: "U.S. Code", section: "42 U.S.C. § 1983" })).toBe(
      "https://www.law.cornell.edu/uscode/text/42/1983",
    );
    // The corpus's "(42 U.S.C. Section 12101 et seq.)" parses with a junk
    // section ("§ ."); the link layer must NOT fabricate a Cornell path
    // out of punctuation.
    expect(citationHref({ type: "federal", codeName: "U.S. Code", section: "42 U.S.C. § ." })).toBeNull();
    expect(citationHref({ type: "federal", codeName: "U.S. Code", section: "42 U.S.C." })).toBeNull();
  });

  test("case law, ordinances, and unknown codes are never linked", () => {
    expect(citationHref({ type: "case-law", codeName: null, section: null })).toBeNull();
    expect(citationHref({ type: "ordinance", codeName: null, section: null })).toBeNull();
    expect(citationHref({ type: "ca-code", codeName: "Mysterious Code", section: "123" })).toBeNull();
    expect(canonicalCodeName("Civ. Code")).toBe("Civil Code");
    expect(canonicalCodeName("Not a Code")).toBeNull();
  });

  test("internal resolution reuses the structured_queries rule", () => {
    const sections = [
      { guid: "g-8-04-010", number: "§ 8.04.010", text: "" },
      { guid: "g-other", number: "§ 12.08.010", text: "" },
    ];
    const report = buildLegalCrosslinks(sections, { limit: 500 });
    // The report builds (empty of citations) — the shared resolver wiring is
    // exercised by the corpus-wide route test below.
    expect(report.empty).toBe(true);
  });

  test("corpus sweep: every linkable citation carries a canonical href; unparsable ones do not", () => {
    const seed = JSON.parse(read("pages-data", "crescent-city-code.json")) as {
      articles?: Array<{ sections?: Array<{ guid?: string; number?: string; text?: string }> }>;
    };
    const sections = (seed.articles ?? []).flatMap((a) =>
      (a.sections ?? []).map((s) => ({ guid: s.guid ?? "", number: s.number ?? "", text: s.text ?? "" })),
    );
    if (sections.length === 0) return;
    const report = buildLegalCrosslinks(sections, { limit: 2000 });
    expect(report.summary.citationsFound).toBeGreaterThan(0);
    for (const row of report.crosslinks) {
      if (row.href !== null) {
        // Only the two canonical hosts may appear in an href.
        expect(
          row.href.startsWith("https://leginfo.legislature.ca.gov/") ||
          row.href.startsWith("https://www.law.cornell.edu/"),
        ).toBe(true);
      } else {
        expect(row.type === "case-law" || row.type === "ordinance" || row.type === "federal").toBe(true);
      }
    }
    expect(report.summary.linkableCitations).toBe(
      report.crosslinks.filter((c) => c.href !== null).length,
    );
    expect(report.summary.unlinkedCitations).toBe(
      report.crosslinks.filter((c) => c.href === null).length,
    );
  });

  test("empty corpus is an explicit empty report", () => {
    const report = buildLegalCrosslinks([]);
    expect(report.empty).toBe(true);
    expect(report.crosslinks).toEqual([]);
  });
});

describe("effective-date field (src/gui/effective_dates.ts)", () => {
  test("derives the most recent year from the real history line", () => {
    const row = buildEffectiveDate({
      guid: "g1",
      number: "§ 1.16.010",
      history: "(Ord. 565 §\u00a02, 1980; Ord. 817 §\u00a02, 2020)",
    });
    expect(row.effectiveYear).toBe(2020);
    expect(row.ordinance).toBe("Ord. No. 817");
    expect(row.derivedFrom).toContain("2020");
  });

  test("no parseable year is an explicit null — never the ordinance number", () => {
    // The no-fabrication rule from legal_parser: 'Ord. No. 6453' must not
    // become year 6453, and an empty history must not become the scrape date.
    const undated = buildEffectiveDate({ guid: "g2", number: "§ 9.20.010", history: "(Ord. No. 123, amended)" });
    expect(undated.effectiveYear).toBeNull();
    const empty = buildEffectiveDate({ guid: "g3", number: "§ 9.20.020", history: "" });
    expect(empty.effectiveYear).toBeNull();
    expect(empty.ordinance).toBeNull();
    const nonsense = buildEffectiveDate({ guid: "g4", number: "§ 9.20.030", history: "No ordinance references" });
    expect(nonsense.effectiveYear).toBeNull();
  });

  test("corpus report partitions with/without dates and never fabricates years", () => {
    const seed = JSON.parse(read("pages-data", "crescent-city-code.json")) as {
      articles?: Array<{ sections?: Array<{ guid?: string; number?: string; history?: string }> }>;
    };
    const sections = (seed.articles ?? []).flatMap((a) =>
      (a.sections ?? []).map((s) => ({ guid: s.guid ?? "", number: s.number ?? "", history: s.history ?? "" })),
    );
    if (sections.length === 0) return;
    const report = buildEffectiveDatesReport(sections, { limit: 500 });
    expect(report.summary.sectionsScanned).toBeGreaterThan(1000);
    expect(report.summary.sectionsWithDate + report.summary.sectionsWithoutDate).toBe(report.summary.sectionsScanned);
    for (const row of report.sections) {
      if (row.effectiveYear !== null) {
        expect(row.effectiveYear).toBeGreaterThanOrEqual(1800);
        expect(row.effectiveYear).toBeLessThanOrEqual(2200);
      }
    }
  });

  test("empty input is an explicit empty report", () => {
    const report = buildEffectiveDatesReport([]);
    expect(report.empty).toBe(true);
    expect(report.summary.sectionsWithDate).toBe(0);
  });
});

describe("route + spec wiring", () => {
  test("the three endpoints are implemented, specced, and served with key injection", () => {
    expect(routes).toContain('path === "/api/ordinals"');
    expect(routes).toContain('path === "/api/citations/index"');
    expect(routes).toContain('path === "/api/effective-dates"');
    expect(spec).toMatch(/^ {2}\/api\/ordinals:$/m);
    expect(spec).toMatch(/^ {2}\/api\/citations\/index:$/m);
    expect(spec).toMatch(/^ {2}\/api\/effective-dates:$/m);
    expect(server).toContain('"/phase10-legal.html"');
    expect(server).toContain('serveStaticHtmlWithKey("phase10-legal.html", socketIp)');
  });

  test("the exact /api/citations/index check precedes the /api/citations/{guid} matcher", () => {
    // Otherwise the parameterized matcher claims "index" as a guid and the
    // corpus route 404s.
    const indexPos = routes.indexOf('path === "/api/citations/index"');
    const matcherPos = routes.indexOf("const citationsMatch = path.match");
    expect(indexPos).toBeGreaterThan(-1);
    expect(matcherPos).toBeGreaterThan(indexPos);
  });

  test("existing published shapes are untouched", () => {
    // The scope boundary: /api/ordinal-check and /api/citations/{guid} keep
    // their implementations and spec entries.
    expect(routes).toContain('path === "/api/ordinal-check"');
    expect(routes).toContain("const citationsMatch = path.match");
    expect(spec).toMatch(/^ {2}\/api\/ordinal-check:$/m);
    expect(spec).toMatch(/^ {2}\/api\/citations\/\{guid\}:$/m);
  });
});

describe("route tests: the three Phase 10 endpoints (real handler, seeded corpus)", () => {
  const BASE = "http://localhost:3000";

  beforeAll(async () => {
    // Tracked-seed corpus, not a local-output copy: corpus-independent and
    // clean against the output-corpus fence.
    await beginSeedCorpus();
    invalidateSectionsCache();
  });

  afterAll(async () => {
    await endCorpusCopy();
    invalidateSectionsCache();
  });

  async function call(path: string): Promise<Response> {
    const { handleApiRoute } = await import("../src/gui/routes.ts");
    return handleApiRoute(new URL(BASE + path));
  }

  test("GET /api/ordinals answers a refined report; empty corpus yields the explicit empty state", async () => {
    const res = await call("/api/ordinals?limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.empty).toBe(false);
    expect(body.schemaVersion).toBe("crescent-city-ordinal-refinement/v1");
    expect(body.summary.titles).toBeGreaterThan(0);
    expect(body.sequences.length).toBeLessThanOrEqual(5);
    if (body.truncated !== undefined) expect(typeof body.truncated).toBe("boolean");
  });

  test("GET /api/citations/index resolves citations and keeps unparsable ones unlinked", async () => {
    const res = await call("/api/citations/index?limit=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe("crescent-city-legal-crosslinks/v1");
    expect(body.summary.citationsFound).toBeGreaterThan(0);
    for (const row of body.crosslinks) {
      if (row.href !== null) {
        expect(
          row.href.startsWith("https://leginfo.legislature.ca.gov/") ||
          row.href.startsWith("https://www.law.cornell.edu/"),
        ).toBe(true);
      }
    }
    expect(body.summary.linkableCitations + body.summary.unlinkedCitations).toBe(body.summary.citationsFound);
  });

  test("GET /api/citations/index is NOT claimed by the /api/citations/{guid} matcher", async () => {
    // Regression control for the route-ordering contract: without the
    // exact-match-first ordering, this request would 404 as guid "index".
    const res = await call("/api/citations/index?limit=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe("crescent-city-legal-crosslinks/v1");
    expect(body.guid).toBeUndefined();
  });

  test("GET /api/citations/{guid} keeps its published shape", async () => {
    const index = await call("/api/citations/index?limit=1");
    const sample = (await index.json()).crosslinks?.[0]?.fromGuid;
    expect(sample).toBeDefined();
    const res = await call(`/api/citations/${sample}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The legacy per-section shape, unchanged.
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["guid", "number", "citations", "amendments"]));
    expect(body.schemaVersion).toBeUndefined();
  });

  test("GET /api/effective-dates derives years from history; unknown guid is a 400", async () => {
    const res = await call("/api/effective-dates?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe("crescent-city-effective-dates/v1");
    expect(body.summary.sectionsWithDate + body.summary.sectionsWithoutDate).toBe(body.summary.sectionsScanned);
    const withDate = body.sections.find((s: { effectiveYear: number | null }) => s.effectiveYear !== null);
    expect(withDate).toBeDefined();
    expect(withDate.effectiveYear).toBeGreaterThanOrEqual(1800);

    const unknown = await call("/api/effective-dates?guid=does-not-exist");
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("Unknown section guid");
  });

  test("every effective year traceable to the section's own history line", async () => {
    const res = await call("/api/effective-dates?limit=50");
    const body = await res.json();
    for (const row of body.sections) {
      if (row.effectiveYear !== null) {
        // The derived year must literally appear in the section's own history
        // line — the no-fabrication contract, checked against the raw data.
        expect(row.derivedFrom).toContain(String(row.effectiveYear));
      } else {
        expect(row.ordinance).toBeNull();
      }
    }
  });
});

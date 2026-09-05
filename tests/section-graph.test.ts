/**
 * Tests for src/section_graph.ts — the section dependency graph.
 * Pure: fixture sections, no filesystem, no network.
 */
import { describe, expect, test } from "bun:test";
import { buildSectionGraph, SECTION_GRAPH_SCHEMA } from "../src/section_graph";
import { buildSectionNumberIndex, resolveSectionNumber, resolveSectionNumberIndexed } from "../src/structured_queries";

/**
 * A small corpus with every structural case the graph has to get right:
 * a chain (a→b→c), a back-edge making a reciprocal pair (c→b), a repeated
 * citation (a cites b twice), a self-reference, a dangling citation, a
 * prefix-resolved citation, and an island with no citations at all.
 */
const sections = [
  {
    guid: "a",
    number: "8.04.010",
    title: "Rates",
    articleNumber: "8.04",
    text: "See § 8.04.020 for details. As stated in § 8.04.020, rates apply. Nothing in § 8.04.010 limits this.",
  },
  {
    guid: "b",
    number: "8.04.020",
    title: "Details",
    articleNumber: "8.04",
    text: "Refer to § 8.04.030 and to the missing § 9.99.999.",
  },
  {
    guid: "c",
    number: "8.04.030",
    title: "Appeals",
    articleNumber: "8.04",
    text: "Appeals follow § 8.04.020.",
  },
  {
    guid: "d",
    number: "17.56.040",
    title: "Zoning",
    articleNumber: "17.56",
    // "§ 17.5" must NOT prefix-match 17.56.040 (dot-boundary rule); "§ 17.56"
    // must resolve to 17.56.040 by prefix.
    text: "Zoning per § 17.56 and per § 17.5.",
  },
  { guid: "e", number: "12.08.010", title: "Harbor", articleNumber: "12.08", text: "No citations here." },
];

describe("buildSectionGraph", () => {
  test("edges are distinct resolved pairs; repeat citations raise weight, not degree", () => {
    const report = buildSectionGraph(sections);
    expect(report.schemaVersion).toBe(SECTION_GRAPH_SCHEMA);
    const aToB = report.edges.find((e) => e.fromGuid === "a" && e.toGuid === "b")!;
    expect(aToB).toBeDefined();
    expect(aToB.weight).toBe(2);
    expect(report.edges.filter((e) => e.fromGuid === "a")).toHaveLength(1);
    const nodeA = report.nodes.find((n) => n.guid === "a")!;
    expect(nodeA.outDegree).toBe(1);
  });

  test("self-references are counted and never become edges", () => {
    const report = buildSectionGraph(sections);
    // Two: a cites "§ 8.04.010" (itself), and d's "§ 17.56" prefix-resolves to d.
    expect(report.summary.selfReferences).toBe(2);
    expect(report.edges.some((e) => e.fromGuid === e.toGuid)).toBe(false);
  });

  test("dangling citations are reported, not silently dropped", () => {
    const report = buildSectionGraph(sections);
    const dangling = report.unresolved.find((u) => u.target === "9.99.999")!;
    expect(dangling).toBeDefined();
    expect(dangling.fromGuid).toBe("b");
    expect(report.summary.unresolvedCitations).toBe(report.unresolved.length);
    expect(report.summary.distinctUnresolvedTargets).toBeGreaterThanOrEqual(1);
    // Resolution rate is a ratio over every citation the scan saw.
    expect(report.summary.resolutionRate).toBeGreaterThan(0);
    expect(report.summary.resolutionRate).toBeLessThan(1);
  });

  test("dot-boundary prefix resolution matches the cross-reference view", () => {
    const report = buildSectionGraph(sections);
    // "§ 17.56" resolves to 17.56.040 by prefix — but it is a self-reference
    // (d cites its own section), so it is counted, not edged.
    expect(report.edges.some((e) => e.fromGuid === "d")).toBe(false);
    expect(report.nodes.find((n) => n.guid === "d")?.outDegree).toBe(0);
    // "§ 17.5" must dangle: 17.56.040 does not start with "17.5.".
    expect(report.unresolved.some((u) => u.target === "17.5")).toBe(true);
  });

  test("reciprocal pairs, isolated nodes, and components describe real structure", () => {
    const report = buildSectionGraph(sections);
    // b→c and c→b are mutual.
    expect(report.summary.reciprocalPairs).toBe(1);
    // e cites nothing and is cited by nothing; d's only resolved citation is
    // to itself, so it is isolated too.
    expect(report.isolated.map((s) => s.guid).sort()).toEqual(["d", "e"]);
    expect(report.summary.isolatedNodes).toBe(2);
    // {a,b,c} is one component; d and e are one each.
    expect(report.summary.components).toBe(3);
    expect(report.summary.largestComponentSize).toBe(3);
  });

  test("hubs rank by out-degree and authorities by in-degree", () => {
    const report = buildSectionGraph(sections);
    expect(report.authorities[0]?.guid).toBe("b");
    expect(report.authorities[0]?.degree).toBe(2);
    expect(report.hubs.every((h) => h.degree > 0)).toBe(true);
  });

  test("density is edges over the directed simple-graph maximum", () => {
    const report = buildSectionGraph(sections);
    const n = report.summary.nodes;
    expect(report.summary.density).toBeCloseTo(report.summary.edges / (n * (n - 1)), 10);
  });

  test("title filter scopes the graph and its statistics", () => {
    const report = buildSectionGraph(sections, { titleFilter: "8.04" });
    expect(report.summary.nodes).toBe(3);
    expect(report.nodes.every((n) => n.number.startsWith("8.04"))).toBe(true);
    // 9.99.999 still dangles inside the scope; 17.5 is out of scope entirely.
    expect(report.unresolved.some((u) => u.target === "17.5")).toBe(false);
  });

  test("ego network is undirected and respects depth", () => {
    const depth1 = buildSectionGraph(sections, { focusGuid: "a", depth: 1 });
    expect(depth1.focus).toMatchObject({ guid: "a", depth: 1, neighborhoodSize: 2 });
    expect(depth1.nodes.map((n) => n.guid).sort()).toEqual(["a", "b"]);

    const depth2 = buildSectionGraph(sections, { focusGuid: "a", depth: 2 });
    expect(depth2.nodes.map((n) => n.guid).sort()).toEqual(["a", "b", "c"]);
    // Ego summaries describe the ego network, not the corpus behind it.
    expect(depth2.summary.nodes).toBe(3);
    expect(depth2.summary.components).toBe(1);
  });

  test("an unknown focus guid is an error the caller can distinguish", () => {
    expect(() => buildSectionGraph(sections, { focusGuid: "nope" })).toThrow(/Unknown section guid/);
  });

  test("limit bounds every list and records the bound", () => {
    const report = buildSectionGraph(sections, { limit: 1 });
    expect(report.nodes).toHaveLength(1);
    expect(report.edges).toHaveLength(1);
    expect(report.truncated).toBe(true);
    // The summary still reports the true totals behind the bound.
    expect(report.summary.nodes).toBe(5);
  });

  test("an empty corpus is a valid empty graph, not a crash", () => {
    const report = buildSectionGraph([]);
    expect(report.summary).toMatchObject({ nodes: 0, edges: 0, density: 0, components: 0, largestComponentSize: 0, resolutionRate: 0 });
    expect(report.truncated).toBe(false);
  });

  test("output is deterministic for identical input", () => {
    const a = buildSectionGraph(sections);
    const b = buildSectionGraph(sections);
    expect({ ...a, generatedAt: "" }).toEqual({ ...b, generatedAt: "" });
  });
});

/**
 * The graph resolves citations through the PRECOMPUTED index rather than the
 * linear `resolveSectionNumber` the per-section cross-reference view uses.
 * That is only safe while the two agree, so assert it directly instead of
 * trusting the comment that says so.
 */
describe("indexed and linear section resolution agree", () => {
  const corpus = [
    { number: "8.04.010" },
    { number: "8.04.020" },
    { number: "8.04" },
    { number: "17.56.040" },
    { number: "17.56.050" },
    { number: "12.08.010" },
    // A duplicate number: both resolvers must pick the FIRST occurrence.
    { number: "8.04.010", marker: "second" },
  ];
  const index = buildSectionNumberIndex(corpus);

  const probes = [
    // exact hits
    "8.04.010", "8.04.020", "8.04", "17.56.040", "12.08.010",
    // dot-boundary prefix hits
    "17.56", "12.08", "17",
    // the boundary rule: "17.5" must NOT reach 17.56.040
    "17.5", "8.0", "1",
    // misses
    "9.99.999", "", "8.04.999",
  ];

  test("every probe resolves identically through both paths", () => {
    for (const probe of probes) {
      expect(resolveSectionNumberIndexed(probe, index)).toBe(resolveSectionNumber(probe, corpus));
    }
  });

  test("a duplicate section number resolves to the first occurrence in both", () => {
    expect(resolveSectionNumberIndexed("8.04.010", index)).toBe(corpus[0]);
    expect(resolveSectionNumber("8.04.010", corpus)).toBe(corpus[0]);
  });
});

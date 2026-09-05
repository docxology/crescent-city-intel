#!/usr/bin/env bun
/**
 * Section dependency graph (roadmap Long-term: "Section dependency graph
 * (network visualization)" — the data layer; the rendering is GUI work).
 *
 * Municipal-code sections cite each other in prose ("...as provided in
 * § 17.56.040"). Those citations form a directed graph whose structure is
 * civic-intelligence in its own right: which sections everything hangs off
 * (authorities), which sections reach furthest into the code (hubs), which
 * sections nothing points at and which point nowhere (isolated), which
 * citations dangle (unresolved), and how many disconnected islands the code
 * actually decomposes into.
 *
 * The citation grammar and the dot-boundary-anchored resolution rule are the
 * SAME ones `structured_queries.resolveCrossReferences` uses — the resolver is
 * imported rather than re-derived so the graph can never drift from the
 * per-section cross-reference view the API already serves. A corpus-wide sweep
 * resolves every citation in every section, so it uses the precomputed
 * `buildSectionNumberIndex` form of that rule (O(1) per lookup instead of two
 * linear scans); a test asserts the indexed and linear resolvers agree.
 *
 * Deterministic, offline, LLM-free. Bounded output via `limit`, with the bound
 * recorded in `truncated` rather than hidden.
 */
import { buildSectionNumberIndex, resolveSectionNumberIndexed } from "./structured_queries.js";
import { normalizeSectionNumber } from "./utils.js";

/**
 * Dot-boundary title scoping. Stored numbers carry the marker ("§ 17.56.040")
 * and a `?title=` filter does not, so both sides are normalised first — the
 * same defect class that made cross-reference resolution read 0%.
 */
function matchesTitle(sectionNumber: string, titleFilter: string): boolean {
  const number = normalizeSectionNumber(sectionNumber);
  const title = normalizeSectionNumber(titleFilter);
  return number === title || number.startsWith(title + ".");
}

export const SECTION_GRAPH_SCHEMA = "crescent-city-section-graph/v1" as const;

/** Citation grammar — mirrors structured_queries.resolveCrossReferences. */
const CITATION_PATTERN = /§\s*(\d+\.\d+(?:\.\d+)?)(?:\(?[A-Z]\)?)?/g;

/** Structural shape this module needs from a scraped section. */
export interface GraphSectionInput {
  guid: string;
  number: string;
  title: string;
  text: string;
  articleNumber?: string;
  articleTitle?: string;
}

export interface GraphNode {
  guid: string;
  number: string;
  title: string;
  articleNumber: string;
  /** Distinct sections this section cites. */
  outDegree: number;
  /** Distinct sections that cite this section. */
  inDegree: number;
}

export interface GraphEdge {
  fromGuid: string;
  fromNumber: string;
  toGuid: string;
  toNumber: string;
  /** The citation exactly as written in the source text. */
  citation: string;
  /** True when the citation resolved by dot-boundary prefix, not exact match. */
  viaPrefix: boolean;
  /** Occurrences of this citation target within the source section's text. */
  weight: number;
}

export interface UnresolvedCitation {
  fromGuid: string;
  fromNumber: string;
  citation: string;
  /** The bare section number the citation names, e.g. "9.99.999". */
  target: string;
  count: number;
}

export interface DegreeEntry {
  guid: string;
  number: string;
  title: string;
  degree: number;
}

export interface SectionGraphSummary {
  /** Sections considered (after any title filter), i.e. graph order. */
  nodes: number;
  /** Distinct resolved from→to pairs, excluding self-references. */
  edges: number;
  /** Citations a section makes to itself (counted, never edges). */
  selfReferences: number;
  /** Total distinct citation targets found across all sections. */
  citations: number;
  unresolvedCitations: number;
  /** Distinct section numbers cited but absent from the corpus. */
  distinctUnresolvedTargets: number;
  /** resolved / citations, 0 when there are no citations. */
  resolutionRate: number;
  /** edges / (n·(n−1)) for a directed simple graph; 0 when n < 2. */
  density: number;
  /** Nodes with no in- and no out-edges. */
  isolatedNodes: number;
  /** Unordered pairs {a,b} where a→b and b→a both exist. */
  reciprocalPairs: number;
  /** Weakly connected components (isolated nodes each count as one). */
  components: number;
  largestComponentSize: number;
}

export interface GraphFocus {
  guid: string;
  number: string;
  depth: number;
  /** Nodes inside the ego network, including the focus itself. */
  neighborhoodSize: number;
}

export interface SectionGraphReport {
  schemaVersion: typeof SECTION_GRAPH_SCHEMA;
  generatedAt: string;
  summary: SectionGraphSummary;
  /** Highest out-degree: the sections that reach furthest into the code. */
  hubs: DegreeEntry[];
  /** Highest in-degree: the sections the rest of the code hangs off. */
  authorities: DegreeEntry[];
  /** Sections that neither cite nor are cited (bounded). */
  isolated: Array<{ guid: string; number: string; title: string }>;
  /** Citations that name a section the corpus does not contain (bounded). */
  unresolved: UnresolvedCitation[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Present only when the report is an ego network around one section. */
  focus: GraphFocus | null;
  /** True when any bounded list was cut by `limit`. */
  truncated: boolean;
}

export interface BuildSectionGraphOptions {
  /** Bounds every list in the report (default 200, min 1). */
  limit?: number;
  /** Restrict the graph to sections whose number starts with this title, e.g. "17". */
  titleFilter?: string;
  /** Build the ego network around this section instead of the whole graph. */
  focusGuid?: string;
  /** Ego-network radius in undirected hops (default 1, clamped to 1..3). */
  depth?: number;
}

/** Distinct citation targets in one section's text, with occurrence counts. */
function citationCounts(text: string): Map<string, { citation: string; count: number }> {
  const counts = new Map<string, { citation: string; count: number }>();
  // matchAll needs a fresh lastIndex per call; the pattern is module-level and global.
  CITATION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const target = match[1];
    const existing = counts.get(target);
    if (existing) existing.count++;
    else counts.set(target, { citation: match[0], count: 1 });
  }
  return counts;
}

/** Union-find over node indices, used for weakly connected components. */
function componentSizes(nodeCount: number, pairs: Array<[number, number]>): number[] {
  const parent = Array.from({ length: nodeCount }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression keeps repeated lookups near-constant on large corpora.
    let cursor = x;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  for (const [a, b] of pairs) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < nodeCount; i++) {
    const root = find(i);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  return [...sizes.values()];
}

/** Stable section-number ordering ("8.4.10" before "8.10.10"). */
function byNumber(a: { number: string }, b: { number: string }): number {
  return a.number.localeCompare(b.number, "en", { numeric: true });
}

/** Rank by degree descending, ties broken by section number for determinism. */
function byDegreeThenNumber(a: DegreeEntry, b: DegreeEntry): number {
  return b.degree - a.degree || byNumber(a, b);
}

/**
 * Build the section dependency graph from scraped sections.
 *
 * Edges are DISTINCT resolved from→to pairs; repeated citations of the same
 * target raise `weight`, never edge count, so degree means "how many other
 * sections", not "how many times the text says §". Self-references are
 * counted in the summary and deliberately excluded from the edge set: a
 * section citing itself is a drafting artifact, not a dependency.
 */
export function buildSectionGraph(
  sections: readonly GraphSectionInput[],
  options: BuildSectionGraphOptions = {},
): SectionGraphReport {
  const limit = Math.max(1, options.limit ?? 200);
  const depth = Math.min(3, Math.max(1, options.depth ?? 1));

  const scoped = options.titleFilter
    ? sections.filter((section) => matchesTitle(section.number, options.titleFilter!))
    : [...sections];

  const indexByGuid = new Map<string, number>();
  scoped.forEach((section, index) => indexByGuid.set(section.guid, index));

  const numberIndex = buildSectionNumberIndex(scoped);
  const outSets = scoped.map(() => new Set<number>());
  const inSets = scoped.map(() => new Set<number>());
  const edges: GraphEdge[] = [];
  const unresolvedByKey = new Map<string, UnresolvedCitation>();
  // Per-source tallies, so an ego-network report's summary describes the ego
  // network and not the whole corpus behind it.
  const perSource = scoped.map(() => ({ citations: 0, resolved: 0, self: 0 }));

  for (let i = 0; i < scoped.length; i++) {
    const section = scoped[i];
    for (const [target, { citation, count }] of citationCounts(section.text ?? "")) {
      perSource[i].citations++;
      const resolved = resolveSectionNumberIndexed(target, numberIndex);
      if (!resolved) {
        const key = `${section.guid}|${target}`;
        const existing = unresolvedByKey.get(key);
        if (existing) existing.count += count;
        else unresolvedByKey.set(key, { fromGuid: section.guid, fromNumber: section.number, citation, target, count });
        continue;
      }
      perSource[i].resolved++;
      const targetIndex = indexByGuid.get(resolved.guid);
      if (targetIndex === undefined) continue;
      if (targetIndex === i) {
        perSource[i].self++;
        continue;
      }
      if (outSets[i].has(targetIndex)) continue;
      outSets[i].add(targetIndex);
      inSets[targetIndex].add(i);
      edges.push({
        fromGuid: section.guid,
        fromNumber: section.number,
        toGuid: resolved.guid,
        toNumber: resolved.number,
        citation,
        viaPrefix: resolved.number !== target,
        weight: count,
      });
    }
  }

  // ─── Ego network ────────────────────────────────────────────────
  // Undirected expansion: a section's neighbourhood is what it cites AND what
  // cites it, because a reader following the code cares about both directions.
  let focus: GraphFocus | null = null;
  let visible: Set<number> | null = null;
  if (options.focusGuid) {
    const start = indexByGuid.get(options.focusGuid);
    if (start === undefined) {
      throw new Error(`Unknown section guid: ${options.focusGuid}`);
    }
    visible = new Set<number>([start]);
    let frontier = [start];
    for (let hop = 0; hop < depth; hop++) {
      const next: number[] = [];
      for (const node of frontier) {
        for (const neighbour of [...outSets[node], ...inSets[node]]) {
          if (!visible.has(neighbour)) {
            visible.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    focus = {
      guid: scoped[start].guid,
      number: scoped[start].number,
      depth,
      neighborhoodSize: visible.size,
    };
  }

  const inScope = (index: number): boolean => visible === null || visible.has(index);

  const nodes: GraphNode[] = [];
  const isolated: Array<{ guid: string; number: string; title: string }> = [];
  const hubEntries: DegreeEntry[] = [];
  const authorityEntries: DegreeEntry[] = [];
  for (let i = 0; i < scoped.length; i++) {
    if (!inScope(i)) continue;
    const section = scoped[i];
    const outDegree = outSets[i].size;
    const inDegree = inSets[i].size;
    nodes.push({
      guid: section.guid,
      number: section.number,
      title: section.title,
      articleNumber: section.articleNumber ?? section.number.split(".").slice(0, 2).join("."),
      outDegree,
      inDegree,
    });
    if (outDegree === 0 && inDegree === 0) {
      isolated.push({ guid: section.guid, number: section.number, title: section.title });
    }
    if (outDegree > 0) hubEntries.push({ guid: section.guid, number: section.number, title: section.title, degree: outDegree });
    if (inDegree > 0) authorityEntries.push({ guid: section.guid, number: section.number, title: section.title, degree: inDegree });
  }

  const visibleEdges = visible === null
    ? edges
    : edges.filter((edge) => visible!.has(indexByGuid.get(edge.fromGuid)!) && visible!.has(indexByGuid.get(edge.toGuid)!));

  let reciprocalPairs = 0;
  for (let i = 0; i < scoped.length; i++) {
    if (!inScope(i)) continue;
    for (const j of outSets[i]) {
      if (j <= i || !inScope(j)) continue;
      if (outSets[j].has(i)) reciprocalPairs++;
    }
  }

  const visibleIndices = nodes.map((node) => indexByGuid.get(node.guid)!);
  const compactIndex = new Map<number, number>();
  visibleIndices.forEach((original, compact) => compactIndex.set(original, compact));
  const componentPairs: Array<[number, number]> = visibleEdges.map((edge) => [
    compactIndex.get(indexByGuid.get(edge.fromGuid)!)!,
    compactIndex.get(indexByGuid.get(edge.toGuid)!)!,
  ]);
  const sizes = componentSizes(nodes.length, componentPairs);

  let citationCount = 0;
  let resolvedCount = 0;
  let selfReferences = 0;
  for (let i = 0; i < scoped.length; i++) {
    if (!inScope(i)) continue;
    citationCount += perSource[i].citations;
    resolvedCount += perSource[i].resolved;
    selfReferences += perSource[i].self;
  }

  const nodeCount = nodes.length;
  const possibleEdges = nodeCount * (nodeCount - 1);

  nodes.sort(byNumber);
  isolated.sort(byNumber);
  hubEntries.sort(byDegreeThenNumber);
  authorityEntries.sort(byDegreeThenNumber);
  const unresolved = [...unresolvedByKey.values()]
    .filter((entry) => visible === null || visible.has(indexByGuid.get(entry.fromGuid)!))
    .sort((a, b) => b.count - a.count || a.fromNumber.localeCompare(b.fromNumber, "en", { numeric: true }) || a.target.localeCompare(b.target, "en", { numeric: true }));
  const sortedEdges = [...visibleEdges].sort(
    (a, b) => a.fromNumber.localeCompare(b.fromNumber, "en", { numeric: true }) || a.toNumber.localeCompare(b.toNumber, "en", { numeric: true }),
  );

  const truncated =
    nodes.length > limit ||
    sortedEdges.length > limit ||
    isolated.length > limit ||
    unresolved.length > limit ||
    hubEntries.length > limit ||
    authorityEntries.length > limit;

  return {
    schemaVersion: SECTION_GRAPH_SCHEMA,
    generatedAt: new Date().toISOString(),
    summary: {
      nodes: nodeCount,
      edges: visibleEdges.length,
      selfReferences,
      citations: citationCount,
      unresolvedCitations: unresolved.length,
      distinctUnresolvedTargets: new Set(unresolved.map((entry) => entry.target)).size,
      resolutionRate: citationCount === 0 ? 0 : resolvedCount / citationCount,
      density: possibleEdges === 0 ? 0 : visibleEdges.length / possibleEdges,
      isolatedNodes: isolated.length,
      reciprocalPairs,
      components: sizes.length,
      largestComponentSize: sizes.length === 0 ? 0 : Math.max(...sizes),
    },
    hubs: hubEntries.slice(0, limit),
    authorities: authorityEntries.slice(0, limit),
    isolated: isolated.slice(0, limit),
    unresolved: unresolved.slice(0, limit),
    nodes: nodes.slice(0, limit),
    edges: sortedEdges.slice(0, limit),
    focus,
    truncated,
  };
}

/**
 * Legal-citation cross-linking (Phase 10).
 *
 * The corpus cites the codes around it — California codes ("Government Code §
 * 65850"), the U.S. Code ("42 U.S.C. § 1983") — the way its own sections cite
 * each other. `extractCitations` (src/legal_parser.ts) already parses those
 * citations. This module resolves parsed citations to stable, canonical URLs
 * a reader can follow, and counts which sections cite which outside authority.
 *
 * Two hard rules, matching the repo's cross-reference-linking doctrine
 * (src/gui/static/assets/modules/15-cross-ref-links.js):
 *
 *  1. Only ESCAPED HTML goes in; only safe markup goes out. The external href
 *     is built from parsed digits and a fixed code-name mapping — never from
 *     raw source text.
 *  2. A citation with no known target keeps its null href. An unparsable or
 *     unrecognized citation is honest plain text, never a link to a 404.
 *
 * Internal section targets resolve through the same dot-boundary rule as
 * structured_queries.resolveSectionNumber (exact first, then proper-prefix),
 * so an in-corpus citation links to the same section `/api/section/{guid}`
 * serves and the cross-ref validator validates.
 *
 * Pure, deterministic, LLM-free. Empty input is an explicit empty report.
 */
import { extractCitations } from "../legal_parser.js";
import { buildSectionNumberIndex, resolveSectionNumberIndexed } from "../structured_queries.js";
import { normalizeSectionNumber } from "../utils.js";

export const LEGAL_CROSSLINKS_SCHEMA = "crescent-city-legal-crosslinks/v1" as const;

/** Canonical, stable public URLs for the cited codes. */
export const CODE_CITATION_URLS = {
  california: "https://leginfo.legislature.ca.gov/faces/codes_displaysection.xhtml?lawCode={CODE}&sectionNum={SECTION}",
  federal: "https://www.law.cornell.edu/uscode/text/{TITLE}/{SECTION}",
} as const;

/** California code citation → the `lawCode` value leginfo expects. */
const CALIFORNIA_LAW_CODES: Array<[RegExp, string, string]> = [
  [/^Government Code$/i, "GOV", "Government Code"],
  [/^Gov\.?\s*Code$/i, "GOV", "Government Code"],
  [/^Health (?:and|&) Safety Code$|^H&SC$/i, "HSC", "Health and Safety Code"],
  [/^Penal Code$|^Pen\.?\s*Code$/i, "PEN", "Penal Code"],
  [/^Vehicle Code$|^Veh\.?\s*Code$/i, "VEH", "Vehicle Code"],
  [/^Water Code$/i, "WAT", "Water Code"],
  [/^Fish (?:and|&) Game Code$/i, "FGC", "Fish and Game Code"],
  [/^Public Resources Code$|^PRC$/i, "PRC", "Public Resources Code"],
  [/^Business (?:and|&) Professions Code$|^B&P\s*Code$/i, "BPC", "Business and Professions Code"],
  [/^Civil Code$|^Civ\.?\s*Code$/i, "CIV", "Civil Code"],
  [/^Elections Code$|^Elec\.?\s*Code$/i, "ELEC", "Elections Code"],
  [/^Education Code$|^Ed\.?\s*Code$/i, "EDC", "Education Code"],
  [/^Labor Code$|^Lab\.?\s*Code$/i, "LAB", "Labor Code"],
  [/^Welfare (?:and|&) Institutions Code$|^W&IC$/i, "WIC", "Welfare and Institutions Code"],
  [/^Probate Code$|^Prob\.?\s*Code$/i, "PROB", "Probate Code"],
  [/^Code of Civil Procedure$|^CCP$/i, "CCP", "Code of Civil Procedure"],
  [/^Revenue (?:and|&) Taxation Code$|^Rev\.?\s*&\s*Tax\.?\s*Code$/i, "RTC", "Revenue and Taxation Code"],
  [/^Streets (?:and|&) Highways Code$/i, "SHC", "Streets and Highways Code"],
  [/^Public Utilities Code$/i, "PUC", "Public Utilities Code"],
  [/^Food (?:and|&) Agricultural Code$/i, "FAC", "Food and Agricultural Code"],
  [/^Harbors (?:and|&) Navigation Code$/i, "HNC", "Harbors and Navigation Code"],
  [/^Public Contract Code$/i, "PCC", "Public Contract Code"],
];

/**
 * The link target for one citation. `href` is null exactly when no canonical
 * target is known — the explicit "no link" state.
 */
export interface CitationLink {
  /** The citation as the parser saw it. */
  citation: string;
  type: "ca-code" | "federal" | "case-law" | "ordinance";
  /** Canonical URL when the citation resolves to one; null otherwise. */
  href: string | null;
  /** Human label for the target system, e.g. "California Government Code". */
  targetLabel: string | null;
  /** When the citation targets a section of THIS corpus, its guid. */
  internalGuid: string | null;
}

export interface CrossLinkedCitation extends CitationLink {
  /** Section (guid) whose prose carries the citation. */
  fromGuid: string;
  fromNumber: string;
}

export interface LegalCrosslinksReport {
  schemaVersion: typeof LEGAL_CROSSLINKS_SCHEMA;
  generatedAt: string;
  /** True when no citations were found — the explicit empty state. */
  empty: boolean;
  summary: {
    sectionsScanned: number;
    citationsFound: number;
    linkableCitations: number;
    /** Citations with no canonical target: reported, never linked. */
    unlinkedCitations: number;
    /** Distinct outside codes cited, e.g. ["California Government Code"]. */
    distinctTargets: string[];
  };
  /** Corpus-wide citation rows, deterministic order, bounded by `limit`. */
  crosslinks: CrossLinkedCitation[];
  truncated: boolean;
}

/**
 * Build the canonical URL for one parsed citation. Returns null for every
 * citation this module cannot name a stable target for — case law and
 * ordinance references have no single official host the way the codes do.
 */
export function citationHref(citation: {
  type: "ca-code" | "federal" | "case-law" | "ordinance";
  codeName: string | null;
  section: string | null;
}): string | null {
  const section = (citation.section ?? "").trim();
  if (citation.type === "ca-code") {
    const codeName = (citation.codeName ?? "").trim();
    if (!codeName || !section) return null;
    const lawCode = CALIFORNIA_LAW_CODES.find(([pattern]) => pattern.test(codeName))?.[1];
    if (!lawCode || !/^[\d.]+$/.test(section)) return null;
    return CODE_CITATION_URLS.california
      .replace("{CODE}", lawCode)
      .replace("{SECTION}", encodeURIComponent(section));
  }
  if (citation.type === "federal") {
    // extractCitations normalises the federal `section` to "TITLE U.S.C. § N".
    // "(42 U.S.C. Section 12101 et seq.)" parses with a junk section ("\u00a7 ."),
    // so the target must be digits/dots only — otherwise the link fabricates a
    // Cornell path out of punctuation.
    const federal = /^(\d+)\s*U\.?S\.?C\.?\s*§\s*(\d[\d.]*)$/.exec(section);
    if (!federal) return null;
    return CODE_CITATION_URLS.federal
      .replace("{TITLE}", federal[1]!)
      .replace("{SECTION}", encodeURIComponent(federal[2]!));
  }
  return null;
}

/** Canonical display name for a cited code, or null when unrecognized. */
export function canonicalCodeName(codeName: string | null): string | null {
  const name = (codeName ?? "").trim();
  if (!name) return null;
  const match = CALIFORNIA_LAW_CODES.find(([pattern]) => pattern.test(name));
  if (match) return match[2]!;
  return null;
}

const TARGET_LABELS: Record<"ca-code" | "federal", (codeName: string | null) => string | null> = {
  "ca-code": (codeName) => {
    const canonical = canonicalCodeName(codeName);
    return canonical ? `California ${canonical}` : null;
  },
  federal: () => "United States Code",
};

/**
 * Link one parsed citation. `resolveInternal` resolves a citation that names a
 * section of this corpus (e.g. "§ 8.04.010" in prose) to its guid; absent,
 * internal resolution is skipped.
 */
export function linkCitation(
  citation: {
    type: "ca-code" | "federal" | "case-law" | "ordinance";
    codeName: string | null;
    section: string | null;
    citation: string;
  },
  resolveInternal?: (number: string) => string | undefined,
): CitationLink {
  const href = citationHref(citation);
  const targetLabel =
    citation.type === "ca-code" || citation.type === "federal"
      ? TARGET_LABELS[citation.type](citation.codeName)
      : null;
  const internalGuid =
    resolveInternal && citation.type !== "federal"
      ? resolveInternal(citation.section ?? "") ?? null
      : null;
  return {
    citation: citation.citation,
    type: citation.type,
    href,
    targetLabel,
    internalGuid,
  };
}

/**
 * Sweep the corpus and build the cross-link report.
 *
 * `limit` bounds `crosslinks` (deterministic order: section number, then
 * position in text); `truncated` records the bound rather than hiding it.
 */
export function buildLegalCrosslinks(
  sections: Array<{ guid: string; number: string; text: string }>,
  options: { limit?: number } = {},
): LegalCrosslinksReport {
  const limit = Math.max(1, options.limit ?? 500);

  if (!Array.isArray(sections) || sections.length === 0) {
    return {
      schemaVersion: LEGAL_CROSSLINKS_SCHEMA,
      generatedAt: new Date().toISOString(),
      empty: true,
      summary: { sectionsScanned: 0, citationsFound: 0, linkableCitations: 0, unlinkedCitations: 0, distinctTargets: [] },
      crosslinks: [],
      truncated: false,
    };
  }

  const index = buildSectionNumberIndex(sections);
  const resolveInternal = (number: string): string | undefined =>
    resolveSectionNumberIndexed(number, index)?.guid;

  const crosslinks: CrossLinkedCitation[] = [];
  const distinctTargets = new Set<string>();
  let linkable = 0;
  let scanned = 0;

  for (const section of sections) {
    if (!section || typeof section.text !== "string" || !section.text) continue;
    scanned++;
    const text = section.text.replace(/\u00a0/g, " ");
    for (const citation of extractCitations(text)) {
      const link = linkCitation(citation, resolveInternal);
      const row: CrossLinkedCitation = {
        ...link,
        fromGuid: section.guid,
        fromNumber: normalizeSectionNumber(section.number),
      };
      if (link.href !== null) {
        linkable++;
        if (link.targetLabel) distinctTargets.add(link.targetLabel);
      }
      crosslinks.push(row);
    }
  }

  crosslinks.sort((a, b) =>
    a.fromNumber.localeCompare(b.fromNumber, "en", { numeric: true }) || a.citation.localeCompare(b.citation),
  );

  return {
    schemaVersion: LEGAL_CROSSLINKS_SCHEMA,
    generatedAt: new Date().toISOString(),
    empty: crosslinks.length === 0,
    summary: {
      sectionsScanned: scanned,
      citationsFound: crosslinks.length,
      linkableCitations: linkable,
      unlinkedCitations: crosslinks.length - linkable,
      distinctTargets: [...distinctTargets].sort(),
    },
    crosslinks: crosslinks.slice(0, limit),
    truncated: crosslinks.length > limit,
  };
}

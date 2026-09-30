/**
 * Ordinal-sequence refinement (Phase 10).
 *
 * The existing `GET /api/ordinal-check` answers a narrower question: which
 * CHAPTER numbers are absent between two present ones inside one title. It
 * compares with `Number(...)` and reports nothing else, so suffix ordinals
 * ("730-R"), reference sections ("SR.010"), and non-numeric outliers are all
 * silently coerced to NaN and invisible.
 *
 * This module is the refinement: a per-chapter ordinal-sequence analysis that
 *
 *  - parses each section number into its title, chapter, and within-chapter
 *    ordinal segments with an explicit classification (`numeric`, `suffixed`,
 *    `non-numeric`) — a segment that does not parse is REPORTED, never
 *    coerced, so the shape of the numbering system stays visible;
 *  - detects the two kinds of gap that matter in a codified ordinance book:
 *    missing ordinals inside a chapter's sequence, and chapters whose ordinal
 *    jumps (e.g. 17.08 -> 17.56) skip numbers that may be reserved or
 *    repealed;
 *  - reports every sequence with its gaps, its classified outliers, and its
 *    coverage, deterministically and offline.
 *
 * Response-shape boundary: `GET /api/ordinal-check` keeps its published shape;
 * this module is served as `GET /api/ordinals` and never changes the old one.
 *
 * Pure, deterministic, LLM-free. Absent input is an explicit empty report
 * (`empty: true`), never a fabricated sequence.
 */

export const ORDINAL_REFINEMENT_SCHEMA = "crescent-city-ordinal-refinement/v1" as const;

/** How a chapter-level ordinal actually parsed. */
export type OrdinalKind = "numeric" | "suffixed" | "non-numeric";

export interface OrdinalSegment {
  /** The chapter-level ordinal exactly as written, e.g. "8.04" or "SR". */
  raw: string;
  kind: OrdinalKind;
  /** Numeric value when kind is numeric or suffixed (suffixes sort by number). */
  value: number | null;
  /** Alphabetic suffix when kind is suffixed, e.g. "R" for "730-R". */
  suffix: string | null;
}

export interface OrdinalGap {
  /** The missing ordinal, formatted like its neighbours ("7.06", "730-T"). */
  missing: string;
  /** The ordinal immediately before the gap (never present for leading gaps). */
  after: string | null;
  /** The ordinal immediately after the gap. */
  before: string;
}

export interface ChapterSequence {
  /** Title segment of the section numbers, e.g. "8" or "SR". */
  title: string;
  /** Ordinals actually present in this title, sorted in sequence order. */
  ordinals: OrdinalSegment[];
  /** Missing ordinals strictly between two present ones. */
  gaps: OrdinalGap[];
  /** Ordinal-shaped segments that could not be parsed into a value. */
  unparseable: string[];
  /** present ordinals / (present + gap count); 1 when the sequence is dense. */
  density: number;
}

export interface OrdinalRefinementReport {
  schemaVersion: typeof ORDINAL_REFINEMENT_SCHEMA;
  generatedAt: string;
  /** True when no sections were provided — the explicit empty state. */
  empty: boolean;
  summary: {
    sectionsScanned: number;
    titles: number;
    totalGaps: number;
    totalUnparseable: number;
    /** The title with the sparsest sequence, when any gaps exist. */
    sparsestTitle: string | null;
  };
  /** One row per title, sorted by title (numeric titles numerically). */
  sequences: ChapterSequence[];
  truncated: boolean;
}

/**
 * Parse a stored section number ("§ 8.04.010", with the marker and NBSP the
 * corpus actually carries) into (title, ordinal, leaf) with the same
 * normalisation `normalizeSectionNumber` applies to the marker.
 */
function splitSectionNumber(rawNumber: string): { title: string; ordinal: string; leaf: string } | null {
  const number = String(rawNumber ?? "")
    .replace(/§\s*/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!number) return null;
  const parts = number.split(".");
  // The corpus's own shapes: "8.04.010" (three segments), "SR.010"
  // (reference sections), and legacy two-segment forms.
  if (parts.length < 2) return null;
  return {
    title: parts[0]!.trim(),
    ordinal: parts[1]!.trim(),
    leaf: parts.slice(2).join("."),
  };
}

/** Parse one chapter-level ordinal into its kind, value, and suffix. */
export function parseOrdinalSegment(raw: string): OrdinalSegment {
  const ordinal = String(raw ?? "").trim();
  const numeric = /^(\d+)(?:([A-Za-z]+))?$/.exec(ordinal);
  if (numeric) {
    return {
      raw: ordinal,
      kind: numeric[2] ? "suffixed" : "numeric",
      value: parseInt(numeric[1]!, 10),
      suffix: numeric[2] ?? null,
    };
  }
  // A hyphenated suffix ("04-R", "5.5-B") is a REAL ordinal slot that shares
  // its base number with the plain form — the shape the ordinance book uses
  // for post-adoption insertions. Classify it as suffixed around the base
  // number rather than dumping it in the unparseable bucket.
  const hyphenated = /^(\d+)-(.+)$/.exec(ordinal);
  if (hyphenated) {
    return {
      raw: ordinal,
      kind: "suffixed",
      value: parseInt(hyphenated[1]!, 10),
      suffix: hyphenated[2]!,
    };
  }
  return { raw: ordinal, kind: "non-numeric", value: null, suffix: null };
}

/** Sequence order for one title's ordinals: value, then suffix, then raw. */
function compareOrdinals(a: OrdinalSegment, b: OrdinalSegment): number {
  if (a.value !== null && b.value !== null && a.value !== b.value) return a.value - b.value;
  if (a.value !== null && b.value === null) return -1;
  if (a.value === null && b.value !== null) return 1;
  const suffixOrder = (a.suffix ?? "").localeCompare(b.suffix ?? "");
  if (suffixOrder !== 0) return suffixOrder;
  return a.raw.localeCompare(b.raw);
}

/** Format a missing ordinal the way its neighbours are written. */
function formatMissing(before: OrdinalSegment, missingValue: number, width: number): string {
  // Zero-padded chapters ("8.04") keep their padding; the width is read from
  // the neighbour rather than assumed, so "1.04" suggests "1.06" not "1.6".
  const digits = Math.max(width, String(missingValue).length);
  return String(missingValue).padStart(digits, "0");
}

/**
 * Build the refined ordinal report from scraped sections.
 *
 * `limit` bounds the returned sequence rows (deterministically — titles sort
 * first); `truncated` records the bound rather than hiding it.
 */
export function buildOrdinalRefinement(
  sections: Array<{ number: string }>,
  options: { limit?: number } = {},
): OrdinalRefinementReport {
  const limit = Math.max(1, options.limit ?? 100);

  if (!Array.isArray(sections) || sections.length === 0) {
    return {
      schemaVersion: ORDINAL_REFINEMENT_SCHEMA,
      generatedAt: new Date().toISOString(),
      empty: true,
      summary: { sectionsScanned: 0, titles: 0, totalGaps: 0, totalUnparseable: 0, sparsestTitle: null },
      sequences: [],
      truncated: false,
    };
  }

  const byTitle = new Map<string, Map<string, OrdinalSegment>>();
  let scanned = 0;
  for (const section of sections) {
    const parsed = splitSectionNumber(section?.number ?? "");
    if (!parsed) continue;
    scanned++;
    let ordinals = byTitle.get(parsed.title);
    if (!ordinals) {
      ordinals = new Map();
      byTitle.set(parsed.title, ordinals);
    }
    if (!ordinals.has(parsed.ordinal)) {
      ordinals.set(parsed.ordinal, parseOrdinalSegment(parsed.ordinal));
    }
  }

  const sequences: ChapterSequence[] = [];
  let totalGaps = 0;
  let totalUnparseable = 0;

  for (const [title, ordinalMap] of byTitle) {
    const ordinals = [...ordinalMap.values()].sort(compareOrdinals);
    const numericOrdinals = ordinals.filter((o) => o.kind !== "non-numeric");
    const unparseable = ordinals.filter((o) => o.kind === "non-numeric").map((o) => o.raw);
    totalUnparseable += unparseable.length;

    const gaps: OrdinalGap[] = [];
    // Walk the numeric run(s). Suffix ordinals ("730-R") share their base
    // number with the plain form, so gaps are computed over distinct VALUES
    // strictly between consecutive distinct numeric values.
    const values = [...new Set(numericOrdinals.filter((o) => o.value !== null).map((o) => o.value!))].sort((a, b) => a - b);
    const widthByValue = new Map<number, number>();
    for (const o of numericOrdinals) {
      if (o.value === null) continue;
      // Width comes from the PLAIN form only — a suffixed sibling ("04-R")
      // must not widen the padding of suggested gaps ("730.05", not
      // "730.0005").
      if (o.suffix !== null) continue;
      widthByValue.set(o.value, Math.max(widthByValue.get(o.value) ?? 0, o.raw.length));
    }
    const byValue = new Map<number, OrdinalSegment>();
    for (const o of numericOrdinals) if (o.value !== null && !byValue.has(o.value)) byValue.set(o.value, o);

    for (let i = 1; i < values.length; i++) {
      const prevValue = values[i - 1]!;
      const nextValue = values[i]!;
      // A suffix family ("730-R" beside "730") is the same ordinal slot, not
      // a gap of 1..R-1; only a base-number jump of >1 is a gap.
      for (let missingValue = prevValue + 1; missingValue < nextValue; missingValue++) {
        const after = byValue.get(prevValue)!;
        const before = byValue.get(nextValue)!;
        gaps.push({
          missing: `${title}.${formatMissing(after, missingValue, widthByValue.get(prevValue) ?? 2)}`,
          after: after.raw,
          before: before.raw,
        });
      }
    }
    totalGaps += gaps.length;

    const present = numericOrdinals.length + unparseable.length;
    sequences.push({
      title,
      ordinals,
      gaps,
      unparseable,
      density: present + gaps.length > 0 ? present / (present + gaps.length) : 1,
    });
  }

  sequences.sort((a, b) => {
    const aNum = Number(a.title);
    const bNum = Number(b.title);
    const aIsNum = Number.isFinite(aNum);
    const bIsNum = Number.isFinite(bNum);
    if (aIsNum && bIsNum && aNum !== bNum) return aNum - bNum;
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;
    return a.title.localeCompare(b.title);
  });

  const sparsest = [...sequences]
    .filter((s) => s.gaps.length > 0)
    .sort((a, b) => b.gaps.length - a.gaps.length || a.title.localeCompare(b.title))[0];

  const bounded = sequences.slice(0, limit);
  return {
    schemaVersion: ORDINAL_REFINEMENT_SCHEMA,
    generatedAt: new Date().toISOString(),
    empty: false,
    summary: {
      sectionsScanned: scanned,
      titles: byTitle.size,
      totalGaps,
      totalUnparseable,
      sparsestTitle: sparsest?.title ?? null,
    },
    sequences: bounded,
    truncated: sequences.length > limit,
  };
}

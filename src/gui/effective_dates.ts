/**
 * Effective-date field (Phase 10 of the deferred GUI/UX set).
 *
 * The roadmap's deferred item is a date field for sections and views. The
 * honest data layer for it already exists: every section carries a `history`
 * line ("Ord. 565 § 2, 1980; Ord. 817 § 2, 2020"), and
 * `legal_parser.extractOrdinanceAmendments` parses those lines into dated
 * actions with a documented no-fabrication rule (an ordinance number is never
 * mistaken for a year). This module derives the field from that parser:
 *
 *  - effective year = the most recent dated action in the section's history
 *    (the date the section last took effect as written);
 *  - `null` when the history carries no parseable year — surfaced as an
 *    explicit "no effective date on record" state by every consumer, never
 *    guessed from the ordinance number, the scrape date, or anything else.
 *
 * The corpus-level report covers the same ground for views: which sections
 * have a derived effective year, which do not, and the year distribution.
 * The year is a YEAR because that is all the corpus's history lines carry;
 * a month/day is never invented.
 *
 * Pure, deterministic, LLM-free. Absent history is an explicit null.
 */
import { extractOrdinanceAmendments } from "../legal_parser.js";

export const EFFECTIVE_DATES_SCHEMA = "crescent-city-effective-dates/v1" as const;

export interface EffectiveDate {
  guid: string;
  sectionNumber: string;
  /** Most recent year in the section's history; null when none is parseable. */
  effectiveYear: number | null;
  /** The ordinance of that most recent action, e.g. "Ord. No. 817". */
  ordinance: string | null;
  /** The action verb of the most recent dated amendment, e.g. "amended". */
  action: string | null;
  /** Raw history line the field was derived from. */
  derivedFrom: string;
}

export interface EffectiveDatesReport {
  schemaVersion: typeof EFFECTIVE_DATES_SCHEMA;
  generatedAt: string;
  /** True when no sections were provided — the explicit empty state. */
  empty: boolean;
  summary: {
    sectionsScanned: number;
    sectionsWithDate: number;
    sectionsWithoutDate: number;
    /** Earliest and latest effective years actually on record. */
    earliestYear: number | null;
    latestYear: number | null;
  };
  /** Per-section rows, sorted by section number, bounded by `limit`. */
  sections: EffectiveDate[];
  truncated: boolean;
}

/**
 * Derive the effective-date field for one section from its real history line.
 * Returns `effectiveYear: null` when no year is parseable — the explicit
 * empty state, never a fabricated date.
 */
export function buildEffectiveDate(section: {
  guid: string;
  number: string;
  history: string;
}): EffectiveDate {
  const amendments = extractOrdinanceAmendments(section.history ?? "");
  const dated = amendments
    .filter((a) => a.year !== null)
    .sort((a, b) => b.year! - a.year!);
  const latest = dated[0];
  return {
    guid: section.guid,
    sectionNumber: section.number,
    effectiveYear: latest?.year ?? null,
    ordinance: latest?.ordinance ?? null,
    action: latest?.action ?? null,
    derivedFrom: section.history ?? "",
  };
}

/**
 * Build the corpus-wide effective-date report.
 *
 * `limit` bounds the per-section rows (sorted by section number, so the bound
 * is deterministic); `truncated` records the bound rather than hiding it.
 */
export function buildEffectiveDatesReport(
  sections: Array<{ guid: string; number: string; history: string }>,
  options: { limit?: number } = {},
): EffectiveDatesReport {
  const limit = Math.max(1, options.limit ?? 500);

  if (!Array.isArray(sections) || sections.length === 0) {
    return {
      schemaVersion: EFFECTIVE_DATES_SCHEMA,
      generatedAt: new Date().toISOString(),
      empty: true,
      summary: { sectionsScanned: 0, sectionsWithDate: 0, sectionsWithoutDate: 0, earliestYear: null, latestYear: null },
      sections: [],
      truncated: false,
    };
  }

  const rows = sections
    .filter((s) => s && typeof s.number === "string")
    .map((s) => buildEffectiveDate({ guid: s.guid, number: s.number, history: s.history ?? "" }));
  rows.sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber, "en", { numeric: true }));

  const years = rows.map((r) => r.effectiveYear).filter((y): y is number => y !== null);

  return {
    schemaVersion: EFFECTIVE_DATES_SCHEMA,
    generatedAt: new Date().toISOString(),
    empty: false,
    summary: {
      sectionsScanned: rows.length,
      sectionsWithDate: years.length,
      sectionsWithoutDate: rows.length - years.length,
      earliestYear: years.length > 0 ? Math.min(...years) : null,
      latestYear: years.length > 0 ? Math.max(...years) : null,
    },
    sections: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

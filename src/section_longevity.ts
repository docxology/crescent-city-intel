#!/usr/bin/env bun
/**
 * Section longevity profile (roadmap Long-term GUI item: "section-longevity
 * views" — the data layer; the panel is GUI work).
 *
 * `ordinance_chronology` answers "what happened to this section, in order".
 * This module answers the complementary temporal question a civic reader has:
 * **how old is the law, and how settled is it?** From the same legislative
 * history lines it derives, per section, the enactment year, the last
 * amendment year, the elapsed years since each, and an amendment rate; then
 * aggregates those into the distributions that make an at-a-glance panel
 * possible — a decade histogram, the oldest untouched sections, the most
 * churned sections, and the sections amended most recently.
 *
 * Honesty rules baked in:
 * - a section whose history line carries no parseable year is `unknown`, never
 *   silently dated to today;
 * - `unknown` sections are excluded from every median and from the histogram,
 *   and counted explicitly in `withoutHistory` so the gap is visible;
 * - `asOfYear` is an input, so the report is reproducible rather than
 *   silently drifting with the wall clock.
 *
 * Deterministic, offline, LLM-free. Bounded output via `limit`.
 */
import { extractOrdinanceAmendments } from "./legal_parser.js";
import { normalizeSectionNumber } from "./utils.js";

/**
 * Dot-boundary title scoping over marker-carrying stored numbers
 * ("§ 8.04.010"); both sides normalised, see `normalizeSectionNumber`.
 */
function matchesTitle(sectionNumber: string, titleFilter: string): boolean {
  const number = normalizeSectionNumber(sectionNumber);
  const title = normalizeSectionNumber(titleFilter);
  return number === title || number.startsWith(title + ".");
}

export const SECTION_LONGEVITY_SCHEMA = "crescent-city-section-longevity/v1" as const;

/** Structural shape this module needs from a scraped section. */
export interface LongevitySectionInput {
  guid: string;
  number: string;
  title: string;
  history: string;
}

export type LongevityStatus = "original" | "amended" | "unknown";

export interface SectionLongevity {
  guid: string;
  number: string;
  title: string;
  /** Earliest parsed year in the history line, or null. */
  enactedYear: number | null;
  /** Latest parsed year in the history line, or null. */
  lastAmendedYear: number | null;
  /** Ordinance actions parsed from the history line. */
  amendmentCount: number;
  /** asOfYear − enactedYear, or null when the year is unknown. */
  ageYears: number | null;
  /** asOfYear − lastAmendedYear, or null when the year is unknown. */
  yearsSinceLastAmendment: number | null;
  /** Amendments after the first, per decade of life; null when undatable. */
  churnPerDecade: number | null;
  /** `original` = one dated action; `amended` = more than one; else `unknown`. */
  status: LongevityStatus;
}

export interface DecadeBucket {
  /** Decade start, e.g. 1990 covers 1990–1999. */
  decade: number;
  /** Sections whose earliest dated action falls in this decade. */
  enacted: number;
  /** Sections whose latest dated action falls in this decade. */
  lastTouched: number;
}

export interface SectionLongevityReport {
  schemaVersion: typeof SECTION_LONGEVITY_SCHEMA;
  generatedAt: string;
  /** The year every elapsed-time figure is measured against. */
  asOfYear: number;
  titleFilter: string | null;
  summary: {
    sectionsScanned: number;
    /** Sections with at least one parseable year. */
    withHistory: number;
    /** Sections with no parseable year — excluded from every statistic below. */
    withoutHistory: number;
    /** Dated sections with exactly one dated action. */
    neverAmended: number;
    oldestYear: number | null;
    newestYear: number | null;
    medianAgeYears: number | null;
    medianYearsSinceLastAmendment: number | null;
    /** Dated sections untouched for 20 years or more. */
    dormantOver20Years: number;
  };
  /** Oldest enactment first. */
  oldest: SectionLongevity[];
  /** Most amendments first. */
  mostAmended: SectionLongevity[];
  /** Longest since any amendment first. */
  stalest: SectionLongevity[];
  /** Most recently amended first. */
  recentlyAmended: SectionLongevity[];
  /**
   * Decade histogram, oldest decade first. Contiguous between the earliest and
   * latest observed decade — a decade with no activity is present with zero
   * counts rather than absent, so a chart drawn from this array cannot
   * silently compress an empty stretch of the code's history.
   */
  byDecade: DecadeBucket[];
  truncated: boolean;
}

export interface BuildSectionLongevityOptions {
  /** Bounds each ranked list (default 25, min 1). */
  limit?: number;
  /** Year every elapsed figure is measured against (default: current year). */
  asOfYear?: number;
  /** Restrict to sections whose number starts with this title, e.g. "17". */
  titleFilter?: string;
}

/** Median of a numeric sample; null for an empty sample. Does not mutate input. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(raw * 100) / 100;
}

function byNumber(a: { number: string }, b: { number: string }): number {
  return a.number.localeCompare(b.number, "en", { numeric: true });
}

/** Sort nulls last regardless of direction, so "unknown" never wins a ranking. */
function nullsLast(value: number | null, descending: boolean): number {
  if (value !== null) return descending ? -value : value;
  return Number.MAX_SAFE_INTEGER;
}

/** Build the longevity profile from scraped sections. */
export function buildSectionLongevity(
  sections: readonly LongevitySectionInput[],
  options: BuildSectionLongevityOptions = {},
): SectionLongevityReport {
  const limit = Math.max(1, options.limit ?? 25);
  const asOfYear = options.asOfYear ?? new Date().getUTCFullYear();
  const titleFilter = options.titleFilter ?? null;

  const scoped = titleFilter
    ? sections.filter((section) => matchesTitle(section.number, titleFilter))
    : sections;

  const profiles: SectionLongevity[] = [];
  const decades = new Map<number, DecadeBucket>();
  const ages: number[] = [];
  const sinceAmendment: number[] = [];
  let withHistory = 0;
  let neverAmended = 0;
  let dormantOver20Years = 0;
  let oldestYear: number | null = null;
  let newestYear: number | null = null;

  const bucket = (decade: number): DecadeBucket => {
    let entry = decades.get(decade);
    if (!entry) {
      entry = { decade, enacted: 0, lastTouched: 0 };
      decades.set(decade, entry);
    }
    return entry;
  };

  for (const section of scoped) {
    const amendments = extractOrdinanceAmendments(section.history ?? "");
    const years = amendments.map((a) => a.year).filter((year): year is number => year !== null);
    const enactedYear = years.length > 0 ? Math.min(...years) : null;
    const lastAmendedYear = years.length > 0 ? Math.max(...years) : null;

    const ageYears = enactedYear === null ? null : asOfYear - enactedYear;
    const yearsSince = lastAmendedYear === null ? null : asOfYear - lastAmendedYear;

    // Amendments beyond the first, normalised over the section's life. A
    // section enacted this year has no elapsed decade to divide by, so its
    // churn is reported against a floor of one year rather than dividing by 0.
    const churnPerDecade =
      ageYears === null || years.length === 0
        ? null
        : Math.round(((years.length - 1) / Math.max(1, ageYears)) * 10 * 100) / 100;

    const status: LongevityStatus = years.length === 0 ? "unknown" : years.length === 1 ? "original" : "amended";

    profiles.push({
      guid: section.guid,
      number: section.number,
      title: section.title,
      enactedYear,
      lastAmendedYear,
      amendmentCount: amendments.length,
      ageYears,
      yearsSinceLastAmendment: yearsSince,
      churnPerDecade,
      status,
    });

    if (years.length === 0) continue;
    withHistory++;
    if (status === "original") neverAmended++;
    if (ageYears !== null) ages.push(ageYears);
    if (yearsSince !== null) {
      sinceAmendment.push(yearsSince);
      if (yearsSince >= 20) dormantOver20Years++;
    }
    if (oldestYear === null || enactedYear! < oldestYear) oldestYear = enactedYear;
    if (newestYear === null || lastAmendedYear! > newestYear) newestYear = lastAmendedYear;
    bucket(Math.floor(enactedYear! / 10) * 10).enacted++;
    bucket(Math.floor(lastAmendedYear! / 10) * 10).lastTouched++;
  }

  const dated = profiles.filter((profile) => profile.status !== "unknown");
  const oldest = [...dated].sort((a, b) => nullsLast(a.enactedYear, false) - nullsLast(b.enactedYear, false) || byNumber(a, b));
  const mostAmended = [...dated].sort((a, b) => b.amendmentCount - a.amendmentCount || byNumber(a, b));
  const stalest = [...dated].sort(
    (a, b) => nullsLast(a.yearsSinceLastAmendment, true) - nullsLast(b.yearsSinceLastAmendment, true) || byNumber(a, b),
  );
  const recentlyAmended = [...dated].sort(
    (a, b) => nullsLast(a.lastAmendedYear, true) - nullsLast(b.lastAmendedYear, true) || byNumber(a, b),
  );
  const observedDecades = [...decades.keys()].sort((a, b) => a - b);
  const byDecade: DecadeBucket[] = [];
  if (observedDecades.length > 0) {
    const first = observedDecades[0];
    const last = observedDecades[observedDecades.length - 1];
    for (let decade = first; decade <= last; decade += 10) {
      byDecade.push(decades.get(decade) ?? { decade, enacted: 0, lastTouched: 0 });
    }
  }

  return {
    schemaVersion: SECTION_LONGEVITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    asOfYear,
    titleFilter,
    summary: {
      sectionsScanned: scoped.length,
      withHistory,
      withoutHistory: scoped.length - withHistory,
      neverAmended,
      oldestYear,
      newestYear,
      medianAgeYears: median(ages),
      medianYearsSinceLastAmendment: median(sinceAmendment),
      dormantOver20Years,
    },
    oldest: oldest.slice(0, limit),
    mostAmended: mostAmended.slice(0, limit),
    stalest: stalest.slice(0, limit),
    recentlyAmended: recentlyAmended.slice(0, limit),
    byDecade,
    truncated: dated.length > limit,
  };
}

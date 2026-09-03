#!/usr/bin/env bun
/**
 * Ordinance chronology & lineage (roadmap Long-term: "ordinance
 * chronology/lineage" — the data layer; visualization remains GUI work).
 *
 * Every municipal-code section carries a `history` line ("Ord. No. 123,
 * enacted 1995; amended 2001; ..."). This module turns those lines, via
 * legal_parser's extractOrdinanceAmendments, into two deterministic views:
 *
 * - per-section chronology: the amendment trail of each section, oldest first;
 * - a city-wide ordinance timeline: each ordinance with every section it
 *   touched, newest action first — the legislative lineage of the code.
 *
 * Deterministic, offline, LLM-free. Bounded output via `limit`.
 */
import { extractOrdinanceAmendments } from "./legal_parser.js";

export const ORDINANCE_CHRONOLOGY_SCHEMA = "crescent-city-ordinance-chronology/v1" as const;

export interface ChronologySection {
  guid: string;
  sectionNumber: string;
  articleTitle: string;
  /** Amendment trail, oldest first; unknown-year entries last. */
  amendments: Array<{ ordinance: string; action: string; year: number | null; raw: string }>;
  firstYear: number | null;
  lastYear: number | null;
}

export interface ChronologyOrdinance {
  ordinance: string;
  /** Earliest non-null year seen for this ordinance across sections. */
  year: number | null;
  actions: string[];
  sectionNumbers: string[];
  sectionCount: number;
}

export interface OrdinanceChronologyReport {
  schemaVersion: typeof ORDINANCE_CHRONOLOGY_SCHEMA;
  generatedAt: string;
  summary: {
    sectionsScanned: number;
    sectionsWithOrdinanceHistory: number;
    totalAmendments: number;
    distinctOrdinances: number;
    earliestYear: number | null;
    latestYear: number | null;
  };
  /** City-wide lineage: which ordinance touched which sections, newest first. */
  cityTimeline: ChronologyOrdinance[];
  /** Per-section amendment trails, sorted by section number. */
  sectionChronologies: ChronologySection[];
  truncated: boolean;
}

/** Number of a section like "8.04.010" -> "8.04"; tolerates odd shapes. */
function titlePrefix(sectionNumber: string): string {
  const parts = sectionNumber.replace(/§\s*/g, "").trim().split(".");
  return parts.slice(0, 2).join(".");
}

/** Sort key that keeps unknown years last without mixing them into the range math. */
function yearSort(year: number | null): number {
  return year === null ? Number.MAX_SAFE_INTEGER : year;
}

/**
 * Build the chronology report from scraped sections. `limit` bounds each of
 * the two lists (deterministically); `truncated` records the bound rather
 * than hiding it. `guidFilter` restricts per-section output to one section.
 */
export function buildOrdinanceChronology(
  sections: Array<{ guid: string; number: string; title: string; history: string; articleTitle?: string }>,
  options: { limit?: number; guidFilter?: string } = {},
): OrdinanceChronologyReport {
  const limit = Math.max(1, options.limit ?? 50);

  const sectionChronologies: ChronologySection[] = [];
  const byOrdinance = new Map<string, ChronologyOrdinance>();
  let totalAmendments = 0;
  let scannedCount = 0;
  const years: number[] = [];

  for (const section of sections) {
    if (options.guidFilter && section.guid !== options.guidFilter) continue;
    scannedCount++;
    const amendments = extractOrdinanceAmendments(section.history ?? "");
    if (amendments.length === 0) continue;

    totalAmendments += amendments.length;
    const knownYears = amendments.map((a) => a.year).filter((y): y is number => y !== null);
    for (const year of knownYears) years.push(year);

    sectionChronologies.push({
      guid: section.guid,
      sectionNumber: section.number,
      articleTitle: section.articleTitle ?? titlePrefix(section.number),
      amendments: [...amendments].sort((a, b) => yearSort(a.year) - yearSort(b.year)),
      firstYear: knownYears.length > 0 ? Math.min(...knownYears) : null,
      lastYear: knownYears.length > 0 ? Math.max(...knownYears) : null,
    });

    for (const amendment of amendments) {
      let entry = byOrdinance.get(amendment.ordinance);
      if (!entry) {
        entry = { ordinance: amendment.ordinance, year: null, actions: [], sectionNumbers: [], sectionCount: 0 };
        byOrdinance.set(amendment.ordinance, entry);
      }
      if (amendment.year !== null && (entry.year === null || amendment.year < entry.year)) {
        entry.year = amendment.year;
      }
      if (!entry.actions.includes(amendment.action)) entry.actions.push(amendment.action);
      if (!entry.sectionNumbers.includes(section.number)) entry.sectionNumbers.push(section.number);
      entry.sectionCount = entry.sectionNumbers.length;
    }
  }

  sectionChronologies.sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber, "en", { numeric: true }));
  const cityTimeline = [...byOrdinance.values()].sort((a, b) => {
    const yearDelta = yearSort(b.year) - yearSort(a.year);
    if (yearDelta !== 0) return yearDelta;
    return a.ordinance.localeCompare(b.ordinance, "en", { numeric: true });
  });

  const boundedSections = sectionChronologies.slice(0, limit);
  const boundedTimeline = cityTimeline.slice(0, limit);
  const truncated = sectionChronologies.length > limit || cityTimeline.length > limit;

  return {
    schemaVersion: ORDINANCE_CHRONOLOGY_SCHEMA,
    generatedAt: new Date().toISOString(),
    summary: {
      sectionsScanned: scannedCount,
      sectionsWithOrdinanceHistory: sectionChronologies.length,
      totalAmendments,
      distinctOrdinances: byOrdinance.size,
      earliestYear: years.length > 0 ? Math.min(...years) : null,
      latestYear: years.length > 0 ? Math.max(...years) : null,
    },
    cityTimeline: boundedTimeline,
    sectionChronologies: boundedSections,
    truncated,
  };
}

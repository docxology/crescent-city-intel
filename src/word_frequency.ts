#!/usr/bin/env bun
/**
 * Corpus word-frequency profile (roadmap Long-term GUI item: "word-frequency
 * ... views" — the data layer; the panel is GUI work).
 *
 * Two questions a municipal-code reader actually asks, answered from the same
 * scan:
 *
 * - **What does this code talk about?** — raw term frequency, stop-word
 *   filtered, with the document frequency that says whether a big count comes
 *   from one verbose section or from the whole corpus.
 * - **What is distinctive about a title?** — the same terms weighted by
 *   inverse document frequency, so boilerplate that appears everywhere sinks
 *   and the vocabulary that actually separates one chapter from the rest rises.
 *
 * Tokenisation deliberately reuses the SEARCH index's contract —
 * `LEGAL_STOP_WORDS`, `STEMMER_EXCEPTIONS`, and the Porter `stem` — so a term
 * a reader sees in this profile is the same term BM25 would have matched.
 * Each stem reports the most common surface form observed for it, because
 * "requir" is not a word anyone wants to read in a UI.
 *
 * Deterministic, offline, LLM-free. Bounded output via `limit`.
 */
import { LEGAL_STOP_WORDS, STEMMER_EXCEPTIONS } from "./gui/search.js";
import { stem } from "./shared/porter_stem.js";
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

export const WORD_FREQUENCY_SCHEMA = "crescent-city-word-frequency/v1" as const;

/** Structural shape this module needs from a scraped section. */
export interface FrequencySectionInput {
  guid: string;
  number: string;
  title: string;
  text: string;
}

export interface TermFrequency {
  /** Porter stem — the index key. */
  term: string;
  /** Most frequent surface form observed for this stem, for display. */
  surface: string;
  /** Total occurrences across the scanned corpus. */
  count: number;
  /** Sections containing the term at least once. */
  documentFrequency: number;
  /** documentFrequency / sectionsScanned, rounded to 4 dp. */
  documentFrequencyRatio: number;
  /** count · ln(N / df) — high for terms that are frequent AND concentrated. */
  salience: number;
}

export interface WordFrequencyReport {
  schemaVersion: typeof WORD_FREQUENCY_SCHEMA;
  generatedAt: string;
  /** The title filter this profile was built under, or null for the whole code. */
  titleFilter: string | null;
  summary: {
    sectionsScanned: number;
    /** Tokens surviving stop-word and length filtering. */
    totalTokens: number;
    distinctTerms: number;
    /** Terms occurring exactly once in the whole corpus. */
    hapaxCount: number;
    /** distinctTerms / totalTokens — lexical variety, 0 when empty. */
    typeTokenRatio: number;
    meanTokensPerSection: number;
  };
  /** Most frequent terms, count descending. */
  topByFrequency: TermFrequency[];
  /** Most distinctive terms, salience descending — boilerplate suppressed. */
  topBySalience: TermFrequency[];
  truncated: boolean;
}

export interface BuildWordFrequencyOptions {
  /** Bounds each ranked list (default 100, min 1). */
  limit?: number;
  /** Restrict to sections whose number starts with this title, e.g. "17". */
  titleFilter?: string;
  /** Drop tokens shorter than this before indexing (default 3, min 1). */
  minLength?: number;
  /** Drop terms occurring in fewer than this many sections (default 1). */
  minDocumentFrequency?: number;
}

/** Stem unless the token is a known over-stemmed exception (mirrors search.ts). */
function stemIfNeeded(token: string): string {
  return STEMMER_EXCEPTIONS.has(token) ? token : stem(token);
}

/**
 * Build the corpus word-frequency profile.
 *
 * `salience` is classic tf·idf with natural log: a term appearing in every
 * section scores 0 no matter how often it occurs, which is exactly the
 * behaviour that makes the second list worth having next to the first.
 */
export function buildWordFrequency(
  sections: readonly FrequencySectionInput[],
  options: BuildWordFrequencyOptions = {},
): WordFrequencyReport {
  // A non-finite limit is coerced to the default rather than propagated:
  // `Math.max(1, NaN)` is NaN, `arr.slice(0, NaN)` is [], and every `>` against
  // NaN is false — so a direct caller passing `limit: NaN` got empty tables with
  // `truncated: false`, claiming nothing was cut when everything was.
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit!)) : 100;
  const minLength = Math.max(1, options.minLength ?? 2);
  const minDocumentFrequency = Math.max(1, options.minDocumentFrequency ?? 1);
  const titleFilter = options.titleFilter ?? null;

  const scoped = titleFilter
    ? sections.filter((section) => matchesTitle(section.number, titleFilter))
    : sections;

  const counts = new Map<string, number>();
  const documentFrequency = new Map<string, number>();
  const surfaceForms = new Map<string, Map<string, number>>();
  let totalTokens = 0;

  for (const section of scoped) {
    const seen = new Set<string>();
    // Tokenise the title as well as the body. The module promises this profile
    // mirrors the BM25 index's own tokenisation, and the index feeds BOTH
    // `section.text` and `section.title` into one term map — so a term appearing
    // only in a heading (very common for "Appeals", "Definitions") has index
    // df > 0 while this module saw df 0. That made documentFrequency, the
    // df-ratio and salience systematically differ from the index they are
    // documented against. The default `minLength` also matches the index's
    // `length > 1` filter rather than admitting 1-char tokens it never indexes.
    const tokens = `${section.title ?? ""} ${section.text ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= minLength && !LEGAL_STOP_WORDS.has(token));

    for (const token of tokens) {
      const term = stemIfNeeded(token);
      totalTokens++;
      counts.set(term, (counts.get(term) ?? 0) + 1);
      let forms = surfaceForms.get(term);
      if (!forms) {
        forms = new Map<string, number>();
        surfaceForms.set(term, forms);
      }
      forms.set(token, (forms.get(token) ?? 0) + 1);
      if (!seen.has(term)) {
        seen.add(term);
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const sectionsScanned = scoped.length;
  const entries: TermFrequency[] = [];
  for (const [term, count] of counts) {
    const df = documentFrequency.get(term) ?? 0;
    if (df < minDocumentFrequency) continue;
    const forms = surfaceForms.get(term)!;
    let surface = term;
    let best = -1;
    for (const [form, formCount] of [...forms].sort((a, b) => a[0].localeCompare(b[0], "en"))) {
      if (formCount > best) {
        best = formCount;
        surface = form;
      }
    }
    // ln(N/df) is 0 for a term in every section — universal boilerplate has no
    // discriminative value however often it occurs.
    const idf = sectionsScanned === 0 || df === 0 ? 0 : Math.log(sectionsScanned / df);
    entries.push({
      term,
      surface,
      count,
      documentFrequency: df,
      documentFrequencyRatio: sectionsScanned === 0 ? 0 : Math.round((df / sectionsScanned) * 10_000) / 10_000,
      salience: Math.round(count * idf * 1000) / 1000,
    });
  }

  const topByFrequency = [...entries].sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, "en"));
  const topBySalience = [...entries].sort((a, b) => b.salience - a.salience || a.term.localeCompare(b.term, "en"));

  // Derive the vocabulary summary from the FILTERED entries, not from the raw
  // counters. `distinctTerms` and `hapaxCount` were computed before the
  // minDocumentFrequency filter, so with `?minDf=2` the summary described a
  // vocabulary the two ranked tables do not contain — a chart built from the
  // summary and a table built from the lists disagreed.
  const distinctTerms = entries.length;
  const hapaxCount = entries.filter((entry) => entry.count === 1).length;

  return {
    schemaVersion: WORD_FREQUENCY_SCHEMA,
    generatedAt: new Date().toISOString(),
    titleFilter,
    summary: {
      sectionsScanned,
      totalTokens,
      distinctTerms,
      hapaxCount,
      typeTokenRatio: totalTokens === 0 ? 0 : Math.round((distinctTerms / totalTokens) * 10_000) / 10_000,
      meanTokensPerSection: sectionsScanned === 0 ? 0 : Math.round((totalTokens / sectionsScanned) * 100) / 100,
    },
    topByFrequency: topByFrequency.slice(0, limit),
    topBySalience: topBySalience.slice(0, limit),
    truncated: entries.length > limit,
  };
}

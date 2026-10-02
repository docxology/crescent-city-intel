/**
 * In-memory BM25 full-text search engine for municipal code sections.
 *
 * Ranking formula: BM25 with field-weighted index.
 * - Section number prefix match: heavy boost (×20)
 * - Title matches: 3× weight boost
 * - Body text: standard BM25 scoring
 *
 * Additional features:
 * - Stop word filtering (42 legal/English stop words removed from index)
 * - Synonym expansion (28 CA municipal law synonym pairs at query time)
 * - Snippet extraction with `<mark>` HTML highlighting
 * - Title filter: ?title=8 scopes to sections starting with "8."
 * - Pagination: offset + limit parameters
 * - Multi-term queries: each whitespace-separated token scored independently
 */
import type { FlatSection, SearchResult } from "../types.js";
import { loadAllSections } from "../shared/data.js";
import { createLogger } from "../logger.js";
import { stem } from "../shared/porter_stem.js";
import { paths, outputRoot } from "../shared/paths.js";
import { civicProfileFingerprint } from "../civic_profile.js";
import { resolve } from "node:path";
import { fuzzyCorrect } from "../shared/fuzzy.js";
import { normalizeSectionNumber } from "../utils.js";
import { privateReceipt } from "../llm/privacy.js";

const logger = createLogger("search");

// ─── Search query logging ──────────────────────────────────────────
/**
 * Record result-count metadata only when private diagnostics are explicitly
 * enabled. HTTP handlers call this compatibility entry point; search() has no
 * persistence side effects, and query text is never retained here.
 */
export function logSearchQuery(_query: string, resultCount: number): void {
  void privateReceipt("search", { resultCount });
}

// ─── BM25 constants ───────────────────────────────────────────────
const K1 = 1.5;  // Term frequency saturation
const B = 0.75;  // Length normalization factor

// ─── Legal stop words ────────────────────────────────────────────
/**
 * High-frequency words that should NOT be indexed — they appear in nearly
 * every section and provide zero discriminative signal in BM25 ranking.
 * Includes both English function words and common legal boilerplate.
 */
export const LEGAL_STOP_WORDS = new Set([
  // English function words
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "this", "that", "these", "those", "it", "its",
  "not", "no", "as", "if", "when", "which", "who", "any", "all", "each",
  // Legal boilerplate (appears in virtually every section)
  "shall", "herein", "thereof", "thereto", "therein", "hereby",
  "pursuant", "notwithstanding", "provided", "section", "code",
  "ordinance", "city", "crescent",
]);

// ─── CA Municipal Law Synonyms ────────────────────────────────────
/**
 * Synonym expansion map for California municipal law terminology.
 * At query time, each term is expanded to include all its synonyms
 * (and vice versa), improving recall across drafting styles.
 *
 * Format: term → canonical form (all synonyms map to the same canonical
 * form so BM25 scoring uses the indexed token variant).
 */
export const SYNONYMS: Map<string, string[]> = new Map([
  // Land use
  ["parcel",    ["lot", "plot", "tract"]],
  ["lot",       ["parcel", "plot", "tract"]],
  ["structure", ["building", "facility"]],
  ["building",  ["structure", "facility"]],
  ["dwelling",  ["residence", "home", "house"]],
  ["residence", ["dwelling", "home", "house"]],
  ["setback",   ["offset", "clearance"]],
  // Coastal & harbor
  ["harbor",    ["port", "marina", "wharf"]],
  ["port",      ["harbor", "marina", "wharf"]],
  ["vessel",    ["boat", "ship", "watercraft"]],
  ["boat",      ["vessel", "ship", "watercraft"]],
  // Legal / administrative
  ["permit",    ["license", "authorization", "approval"]],
  ["license",   ["permit", "authorization", "approval"]],
  ["variance",  ["exception", "waiver", "deviation"]],
  ["appeal",    ["petition", "challenge", "objection"]],
  ["fee",       ["charge", "assessment", "rate"]],
  ["fine",      ["penalty", "forfeiture", "sanction"]],
  ["violation", ["offense", "infraction", "breach"]],
  // Emergency
  ["evacuation", ["withdrawal", "egress", "escape"]],
  ["tsunami",    ["tidal wave", "seismic sea wave"]],
  ["earthquake", ["seismic", "temblor", "tremor"]],
  // Infrastructure
  ["road",      ["street", "avenue", "boulevard", "drive", "way"]],
  ["street",    ["road", "avenue", "boulevard", "lane"]],
  ["utilities", ["services", "water", "sewer", "electric"]],
  ["storm",     ["stormwater", "drainage", "runoff"]],
]);

/** Expand a single raw token using synonym map (returns token + all synonyms) */
function expandSynonyms(token: string): string[] {
  const alts = SYNONYMS.get(token) ?? [];
  return [token, ...alts];
}

// ─── Index state ─────────────────────────────────────────────────
interface SearchIndexState {
  sections: FlatSection[];
  tfIndex: Array<Map<string, { tf: number; titleTf: number }>>;
  bodyLengths: number[];
  idfIndex: Map<string, number>;
  avgBodyLen: number;
}
const indexes = new Map<string, SearchIndexState>();
const indexLoads = new Map<string, Promise<void>>();
const MAX_INDEX_CONTEXTS = 8;
const emptyIndex: SearchIndexState = { sections: [], tfIndex: [], bodyLengths: [], idfIndex: new Map(), avgBodyLen: 1 };
function searchContextKey(): string { return JSON.stringify([resolve(outputRoot()), civicProfileFingerprint()]); }
function selectedIndex(): SearchIndexState {
  const key = searchContextKey(), state = indexes.get(key);
  if (!state) return emptyIndex;
  indexes.delete(key); indexes.set(key, state);
  return state;
}

// ─── Tokenizer ────────────────────────────────────────────────────

// ─── Stemmer exceptions ──────────────────────────────────────────
/**
 * Terms that must NOT be stemmed because they have distinct legal meanings
 * from their morphological root. Porter stemmer would conflate these:
 *
 * - "planning" → "plan"  (Planning Commission ≠ generic plan)
 * - "zoning" → "zone"    (Zoning Code ≠ geographic zone)
 * - "housing" → "hous"   (Housing Authority ≠ to house)
 * - "fishing" → "fish"   (Fishing license ≠ fish species)
 * - "parking" → "park"   (Parking ordinance ≠ park/parks)
 * - "building" → "build" (Building permit ≠ to build)
 * - "hearing" → "hear"   (Public hearing ≠ to hear)
 * - "grading" → "grad"   (Site grading ≠ academic grade)
 * - "banning" → "ban"    (City of Banning ≠ to ban)
 */
export const STEMMER_EXCEPTIONS = new Set([
  "planning", "zoning", "housing", "fishing", "parking",
  "building", "hearing", "grading", "banning", "granting",
  "licensing", "permitting", "appealing", "mapping",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !LEGAL_STOP_WORDS.has(t));
}

/** Tokenize and stem using Porter algorithm (for index building). */
function tokenizeAndStem(text: string): string[] {
  return tokenize(text).map(stemIfNeeded);
}

/** Stem a single token unless it is a STEMMER_EXCEPTION. */
function stemIfNeeded(t: string): string {
  return STEMMER_EXCEPTIONS.has(t) ? t : stem(t);
}

/**
 * Return union of raw, stemmed, and synonym-expanded tokens for query.
 * Stop words are excluded. Synonyms are added for recall.
 * Stemming is exception-aware — it must match the INDEX's stemming exactly,
 * or an exception like "planning" would be indexed as "planning" but queried
 * as "plan", silently under-matching.
 */
function queryTerms(text: string): string[] {
  const raw = tokenize(text);
  const expanded: string[] = [];
  for (const t of raw) {
    expanded.push(...expandSynonyms(t));
  }
  // Filter stop words from expansions too, then stem all
  const filtered = expanded.filter(t => !LEGAL_STOP_WORDS.has(t));
  const stemmed = filtered.map(stemIfNeeded);
  const combined = new Set([...filtered, ...stemmed]);
  return [...combined];
}

// ─── Index building ───────────────────────────────────────────────

function buildIndex(allSections: FlatSection[]): SearchIndexState {
  const N = allSections.length;
  const tfIndex: SearchIndexState["tfIndex"] = [];
  const bodyLengths: number[] = [];
  const idfIndex = new Map<string, number>();
  let totalBodyLen = 0;

  // Build per-doc TF maps using stemmed tokens
  const docFreq = new Map<string, number>(); // term → # docs containing it

  for (const section of allSections) {
    const bodyTokens = tokenizeAndStem(section.text);
    const titleTokens = tokenizeAndStem(section.title);
    totalBodyLen += bodyTokens.length;
    bodyLengths.push(bodyTokens.length);

    const termMap = new Map<string, { tf: number; titleTf: number }>();

    for (const t of bodyTokens) {
      const entry = termMap.get(t) ?? { tf: 0, titleTf: 0 };
      entry.tf++;
      termMap.set(t, entry);
    }

    for (const t of titleTokens) {
      const entry = termMap.get(t) ?? { tf: 0, titleTf: 0 };
      entry.titleTf++;
      termMap.set(t, entry);
    }

    // Count document frequency
    for (const term of termMap.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    tfIndex.push(termMap);
  }

  const avgBodyLen = N > 0 ? totalBodyLen / N : 1;

  // Compute IDF: ln((N - df + 0.5) / (df + 0.5) + 1)
  for (const [term, df] of docFreq) {
    idfIndex.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  logger.info(`Search index built: ${N} sections, ${idfIndex.size} unique terms`);
  return { sections: allSections, tfIndex, bodyLengths, idfIndex, avgBodyLen };
}

// ─── Init ─────────────────────────────────────────────────────────

/** Load + index all sections. Idempotent. */
export async function initSearch(): Promise<void> {
  // Capture before awaiting: interleaved roots never overwrite one shared index.
  const key = searchContextKey();
  if (indexes.has(key)) { selectedIndex(); return; }
  const pending = indexLoads.get(key); if (pending) return pending;
  let loading!: Promise<void>;
  loading = (async () => {
    const state = buildIndex(await loadAllSections());
    // A reload can supersede this load while filesystem reads are outstanding.
    if (indexLoads.get(key) !== loading) return;
    indexes.set(key, state);
    while (indexes.size > MAX_INDEX_CONTEXTS) indexes.delete(indexes.keys().next().value!);
  })();
  indexLoads.set(key, loading);
  try { await loading; } finally { if (indexLoads.get(key) === loading) indexLoads.delete(key); }
}

/** Force a reload of the search index (after a re-scrape). */
export async function reloadSearch(): Promise<void> {
  const key = searchContextKey(); indexes.delete(key); indexLoads.delete(key);
  await initSearch();
}

// ─── Scoring ─────────────────────────────────────────────────────

function bm25Score(
  state: SearchIndexState,
  terms: string[],
  sectionIdx: number,
  bodyLen: number,
  bodyOnly = false,
): number {
  const { tfIndex, idfIndex, avgBodyLen } = state;
  const termMap = tfIndex[sectionIdx];
  let score = 0;

  for (const term of terms) {
    const idf = idfIndex.get(term) ?? 0;
    const entry = termMap.get(term);
    if (!entry) continue;

    // BM25 for body
    const tf = entry.tf;
    const bodyScore =
      idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (bodyLen / avgBodyLen))));

    // Title boost: treat title matches as 3× more relevant (added directly to score)
    const titleScore = idf * entry.titleTf * 3;

    score += bodyScore + (bodyOnly ? 0 : titleScore);
  }

  return score;
}

// ─── Snippet extraction ───────────────────────────────────────────

/**
 * Extract a short snippet around the first term match.
 * If highlight=true, wraps the exact query text with <mark> tags.
 */
function extractSnippet(text: string, query: string, highlight = false): string {
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);

  let snippet: string;
  if (idx === -1) {
    snippet = text.substring(0, 200).trim();
  } else {
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + query.length + 120);
    snippet =
      (start > 0 ? "…" : "") +
      text.slice(start, end).trim() +
      (end < text.length ? "…" : "");
  }

  if (highlight && idx !== -1) {
    // Escape any existing HTML in snippet, then wrap matches with <mark>
    const escaped = snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const re = new RegExp(queryLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return escaped.replace(re, m => `<mark>${m}</mark>`);
  }

  return snippet;
}

// ─── Public API ───────────────────────────────────────────────────

export interface SearchOptions {
  /** Maximum results to return (default 50) */
  limit?: number;
  /** Skip this many results (for pagination) */
  offset?: number;
  /** Filter to sections whose number starts with this title (e.g., "8" for Title 8) */
  titleFilter?: string;
  /** Wrap matched text in <mark> tags in snippets */
  highlight?: boolean;
  /** Filter by node type: 'article' (section is the article container) or 'section' (individual section) */
  typeFilter?: "article" | "section";
  /** Search only section numbers (field-level search) */
  field?: "number" | "text" | "title";
}

export interface PagedSearchResult {
  results: SearchResult[];
  total: number;
  offset: number;
  limit: number;
  /** Fuzzy correction suggestions (populated when BM25 returns 0 results) */
  fuzzyCorrections?: Array<{ original: string; suggestion: string; score: number }>;
}

/**
 * Search sections using BM25 ranking.
 *
 * @param query - User query string (whitespace-separated terms)
 * @param options - Pagination, filters, highlighting
 */
export function search(query: string, options: SearchOptions = {}): PagedSearchResult {
  const state = selectedIndex(), { sections, bodyLengths } = state;
  const { limit = 50, offset = 0, titleFilter, highlight = false, typeFilter, field } = options;

  if (!query.trim()) return { results: [], total: 0, offset, limit };

  const terms = queryTerms(query); // raw + stemmed union
  const rawQuery = query.trim();
  const eligible = (section: FlatSection) => {
    const number = normalizeSectionNumber(section.number);
    if (titleFilter && !number.startsWith(titleFilter + ".") && !number.startsWith(titleFilter + " ")) return false;
    const segments = number.split(".").length;
    return typeFilter === "article" ? segments <= 2 : typeFilter === "section" ? segments >= 3 : true;
  };

  // Field-level search: if field=number, only match section numbers
  if (field === "number") {
    const lowerQuery = rawQuery.toLowerCase();
    const scored: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < sections.length; i++) {
      if (!eligible(sections[i])) continue;
      const num = normalizeSectionNumber(sections[i].number).toLowerCase();
      if (num.includes(lowerQuery) || num.startsWith(lowerQuery)) {
        scored.push({ idx: i, score: 20 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const total = scored.length;
    const page = scored.slice(offset, offset + limit);
    const results: SearchResult[] = page.map(({ idx, score }) => {
      const section = sections[idx];
      return { section, snippet: `§ ${section.number} — ${section.title}`, matchCount: Math.round(score * 100) / 100 };
    });
    return { results, total, offset, limit };
  }

  // Field-level search: if field=title, only match section titles
  if (field === "title") {
    const lowerQuery = rawQuery.toLowerCase();
    const scored: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < sections.length; i++) {
      if (!eligible(sections[i])) continue;
      const title = sections[i].title.toLowerCase();
      if (title.includes(lowerQuery)) {
        scored.push({ idx: i, score: 10 });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const total = scored.length;
    const page = scored.slice(offset, offset + limit);
    const results: SearchResult[] = page.map(({ idx, score }) => {
      const section = sections[idx];
      return { section, snippet: section.title, matchCount: Math.round(score * 100) / 100 };
    });
    return { results, total, offset, limit };
  }

  const scored: Array<{ idx: number; score: number }> = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!eligible(section)) continue;

    // Title filter (e.g., "8" matches sections like "§ 8.04.010")
    if (titleFilter) {
      const num = normalizeSectionNumber(section.number);
      if (!num.startsWith(titleFilter + ".") && !num.startsWith(titleFilter + " ")) continue;
    }

    // Type filter: 'article' = whole-article sections, 'section' = individual sections
    if (typeFilter === "article") {
      // "Article-level" sections are those where number has at most 2 segments (e.g., "8.04")
      const num = normalizeSectionNumber(section.number);
      const segments = num.split(".").length;
      if (segments > 2) continue;
    } else if (typeFilter === "section") {
      // Individual sections have 3+ segments (e.g., "8.04.010")
      const num = normalizeSectionNumber(section.number);
      const segments = num.split(".").length;
      if (segments < 3) continue;
    }

    // Heavy boost for section number prefix match
    const numberClean = normalizeSectionNumber(section.number).toLowerCase();
    let score = bm25Score(state, terms, i, bodyLengths[i] ?? 0, field === "text");

    if (field !== "text" && numberClean.startsWith(rawQuery.toLowerCase())) score += 20;

    if (score > 0) scored.push({ idx: i, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const total = scored.length;
  const page = scored.slice(offset, offset + limit);

  const results: SearchResult[] = page.map(({ idx, score }) => {
    const section = sections[idx];
    const snippet = extractSnippet(section.text || section.title, rawQuery, highlight);
    return { section, snippet, matchCount: Math.round(score * 100) / 100 };
  });

  // ─── Fuzzy fallback: if BM25 returns 0 results, suggest corrections ───
  if (total === 0 && sections.length > 0) {
    try {
      // Build a deterministic vocabulary over the WHOLE corpus, sorted by
      // section number — the prior behavior sampled `sections.slice(0, 500)`
      // in loadAllSections order, so corrections were incomplete and biased
      // by whatever happened to be first. This path only runs when BM25
      // returned nothing, so the one-time vocabulary pass is acceptable.
      const vocab = new Set<string>();
      const sortedSections = [...sections].sort((a, b) => (a.number ?? "").localeCompare(b.number ?? ""));
      for (const s of sortedSections) {
        for (const w of s.text.toLowerCase().split(/\s+/)) {
          if (w.length > 3) vocab.add(w);
        }
      }
      const queryWords = rawQuery.split(/\s+/).filter(Boolean);
      const corrections = fuzzyCorrect(queryWords, vocab, 0.7);
      if (corrections.length > 0) {
        return { results, total, offset, limit, fuzzyCorrections: corrections };
      }
    } catch {
      // fuzzy module not available — return empty results
    }
  }

  return { results, total, offset, limit };
}

/** Total indexed sections */
export function getIndexedCount(): number {
  return selectedIndex().sections.length;
}

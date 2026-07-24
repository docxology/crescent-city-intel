/**
 * Structured query engine for municipal code sections.
 *
 * Provides:
 * - Legislative history extraction (ordinance chain parsing)
 * - Section comparison (word-level diff)
 * - Semantic similarity search (via ChromaDB if available, fallback to BM25)
 * - Cross-reference resolution (internal § references)
 *
 * All functions are pure and return structured data — no side effects.
 */
import type { FlatSection } from "./types.js";
import { loadAllSections } from "./shared/data.js";
import { loadSection } from "./shared/data.js";
import { createLogger } from "./logger.js";

const log = createLogger("structured_queries");

type SimilarityProfile = { frequencies: Map<string, number>; magnitude: number };
let similarityProfileSections: FlatSection[] | null = null;
let similarityProfiles: SimilarityProfile[] = [];

function buildSimilarityProfiles(sections: FlatSection[]): SimilarityProfile[] {
  if (similarityProfileSections === sections) return similarityProfiles;
  similarityProfiles = sections.map(section => {
    const frequencies = new Map<string, number>();
    for (const word of section.text.toLowerCase().split(/\s+/).filter(w => w.length > 3)) {
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
    const magnitude = Math.sqrt([...frequencies.values()].reduce((sum, count) => sum + count * count, 0));
    return { frequencies, magnitude };
  });
  similarityProfileSections = sections;
  return similarityProfiles;
}

// ─── Legislative History ────────────────────────────────────────────

export interface LegislativeHistoryEntry {
  /** Ordinance number, e.g. "Ord. No. 1234" */
  ordinance: string;
  /** Action: "enacted" | "amended" | "repealed" */
  action: string;
  /** Date if parseable */
  date: string | null;
  /** Raw history text */
  raw: string;
}

export interface LegislativeHistoryResult {
  /** Section GUID */
  guid: string;
  /** Section number */
  number: string;
  /** Parsed ordinance chain */
  entries: LegislativeHistoryEntry[];
  /** Raw history field from the section */
  rawHistory: string;
}

/**
 * Parse a section's legislative history field into structured entries.
 *
 * History fields typically look like:
 *   "Ord. No. 942 § 1, 2011; Ord. No. 723 § 1, 2004"
 */
export function parseLegislativeHistory(historyText: string): LegislativeHistoryEntry[] {
  if (!historyText || !historyText.trim()) return [];

  const entries: LegislativeHistoryEntry[] = [];

  // Split by semicolons — each entry is a separate ordinance action
  const parts = historyText.split(";").map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    // Match ordinance numbers: "Ord. No. 1234" or "Ordinance No. 5678"
    const ordMatch = part.match(/(?:Ord\.?\s*(?:inance)?\s*No\.?\s*)(\d+)/i);
    // Match action keywords
    const actionMatch = part.match(/\b(enacted|amended|repealed|adopted|added|deleted|renumbered)\b/i);
    // Match dates: "2021" or "Jan. 2021" or "January 15, 2021"
    const dateMatch = part.match(/(\d{4})/);

    entries.push({
      ordinance: ordMatch ? `Ord. No. ${ordMatch[1]}` : part.substring(0, 50),
      action: actionMatch ? actionMatch[1].toLowerCase() : "amended",
      date: dateMatch ? dateMatch[1] : null,
      raw: part,
    });
  }

  return entries;
}

/**
 * Get legislative history for a specific section by GUID.
 */
export async function getSectionHistory(guid: string): Promise<LegislativeHistoryResult | null> {
  try {
    const sections = await loadAllSections();
    const section = sections.find(s => s.guid === guid);
    if (!section) return null;

    return {
      guid: section.guid,
      number: section.number,
      entries: parseLegislativeHistory(section.history),
      rawHistory: section.history,
    };
  } catch (err: any) {
    log.error(`Failed to get history for ${guid}`, { error: err.message });
    return null;
  }
}

// ─── Section Comparison ─────────────────────────────────────────────

export interface SectionDiff {
  /** GUID of first section */
  guid1: string;
  /** GUID of second section */
  guid2: string;
  /** Section numbers */
  number1: string;
  number2: string;
  /** Word count difference (2 minus 1) */
  wordCountDelta: number;
  /** Lines only in section 1 */
  onlyInFirst: string[];
  /** Lines only in section 2 */
  onlyInSecond: string[];
  /** Lines in both (common) */
  common: string[];
  /** Similarity ratio (0-1) */
  similarity: number;
}

/**
 * Compare two sections using word-level diffing.
 * Returns lines unique to each, common lines, and a similarity score.
 */
export async function compareSections(guid1: string, guid2: string): Promise<SectionDiff | null> {
  try {
    const sections = await loadAllSections();
    const s1 = sections.find(s => s.guid === guid1);
    const s2 = sections.find(s => s.guid === guid2);

    if (!s1 || !s2) {
      log.warn("One or both sections not found", { guid1, guid2 });
      return null;
    }

    const lines1 = s1.text.split("\n").map(l => l.trim()).filter(Boolean);
    const lines2 = s2.text.split("\n").map(l => l.trim()).filter(Boolean);

    const set1 = new Set(lines1);
    const set2 = new Set(lines2);

    const onlyInFirst = lines1.filter(l => !set2.has(l));
    const onlyInSecond = lines2.filter(l => !set1.has(l));
    const common = lines1.filter(l => set2.has(l));

    const totalLines = Math.max(lines1.length, lines2.length);
    const similarity = totalLines > 0 ? common.length / totalLines : 0;

    return {
      guid1,
      guid2,
      number1: s1.number,
      number2: s2.number,
      wordCountDelta: s2.text.split(/\s+/).length - s1.text.split(/\s+/).length,
      onlyInFirst,
      onlyInSecond,
      common,
      similarity,
    };
  } catch (err: any) {
    log.error("Failed to compare sections", { guid1, guid2, error: err.message });
    return null;
  }
}

// ─── Semantic Similarity ────────────────────────────────────────────

export interface SimilarSection {
  section: FlatSection;
  /** BM25-style score (higher = more similar) */
  score: number;
  /** Why this section is considered similar */
  reason: string;
}

/**
 * Find sections similar to a given one using BM25-style term overlap.
 * Falls back gracefully if ChromaDB is unavailable.
 */
export async function findSimilarSections(guid: string, limit: number = 10): Promise<SimilarSection[]> {
  try {
    const sections = await loadAllSections();
    const target = sections.find(s => s.guid === guid);

    if (!target) {
      log.warn("Target section not found", { guid });
      return [];
    }

    const profiles = buildSimilarityProfiles(sections);
    const targetIndex = sections.indexOf(target);
    const targetProfile = profiles[targetIndex];
    if (!targetProfile) return [];

    // Score all other sections by term overlap
    const scored: SimilarSection[] = [];

    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const section = sections[sectionIndex];
      if (section.guid === guid) continue;

      // Same Title prefix → structural similarity boost
      const sameTitle = section.number.split(".")[0] === target.number.split(".")[0];

      const sectionProfile = profiles[sectionIndex];
      if (!sectionProfile) continue;

      // Cosine-like similarity
      let dotProduct = 0;
      for (const [term, freq] of targetProfile.frequencies) {
        if (sectionProfile.frequencies.has(term)) {
          dotProduct += freq * sectionProfile.frequencies.get(term)!;
        }
      }

      const cosineSim = targetProfile.magnitude > 0 && sectionProfile.magnitude > 0
        ? dotProduct / (targetProfile.magnitude * sectionProfile.magnitude)
        : 0;

      const score = cosineSim * (sameTitle ? 1.5 : 1.0); // Boost same-title matches

      if (score > 0.01) {
        scored.push({
          section,
          score,
          reason: sameTitle
            ? `Same Title ${section.number.split(".")[0]} — term similarity ${(cosineSim * 100).toFixed(1)}%`
            : `Term similarity ${(cosineSim * 100).toFixed(1)}%`,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    // Guard against a negative (or non-finite) limit: Array.slice(0, -1) means
    // "all but the last element", not "zero results" — a negative limit would
    // silently return nearly the entire scored list instead of respecting the
    // caller's requested cap. Reachable via the real /api/similar/:guid?limit=
    // route, whose `parseInt(...) || 10` fallback does not catch negative
    // numbers (they're truthy, so the `|| 10` default never kicks in).
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    return scored.slice(0, safeLimit);
  } catch (err: any) {
    log.error("Failed to find similar sections", { guid, error: err.message });
    return [];
  }
}

// ─── Cross-Reference Resolution ─────────────────────────────────────

export interface CrossReference {
  /** The citation as it appears in text, e.g. "§ 8.04.010" */
  citation: string;
  /** Resolved section number */
  sectionNumber: string;
  /** Whether the reference resolves to an actual section */
  resolved: boolean;
  /** GUID if resolved */
  guid: string | null;
  /** Title number if resolved */
  title: string | null;
}

/**
 * Resolve a single citation's section number (e.g. "17.56.040" or "17.5")
 * against a corpus of known section numbers.
 *
 * Tries an exact match first, then a dot-boundary-anchored prefix match.
 * The prefix match is anchored on "." so a short citation like "17.5" can
 * never falsely match an unrelated section such as "17.56.040" — plain
 * `startsWith("17.5")` would incorrectly match since "17.56.040" begins
 * with the digit string "17.5", even though chapter 17.5 and chapter 17.56
 * are different chapters. This mirrors the boundary-anchored prefix logic
 * used in domains/coverage.ts and gui/search.ts.
 *
 * Pure and side-effect free — exported separately so it can be tested
 * directly against literal section-number data without touching disk.
 */
export function resolveSectionNumber<T extends { number: string }>(
  sectionNumber: string,
  sections: readonly T[]
): T | undefined {
  const exact = sections.find(s => s.number === sectionNumber);
  if (exact) return exact;
  return sections.find(s => s.number.startsWith(sectionNumber + "."));
}

/**
 * Find all internal cross-references (§ X.XX.XXX patterns) in a section's text
 * and resolve them to actual sections in the corpus.
 */
export async function resolveCrossReferences(guid: string): Promise<CrossReference[]> {
  try {
    const sections = await loadAllSections();
    const section = sections.find(s => s.guid === guid);
    if (!section) return [];

    // Match patterns like § 8.04.010 or § 8.04 or § 17.56.040(A)
    const refPattern = /§\s*(\d+\.\d+(?:\.\d+)?)(?:\(?[A-Z]\)?)?/g;
    const matches = [...section.text.matchAll(refPattern)];

    const refs: CrossReference[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      const fullCitation = match[0];
      const sectionNumber = match[1];

      if (seen.has(sectionNumber)) continue;
      seen.add(sectionNumber);

      const resolved = resolveSectionNumber(sectionNumber, sections);

      refs.push({
        citation: fullCitation,
        sectionNumber,
        resolved: !!resolved,
        guid: resolved?.guid ?? null,
        title: resolved ? resolved.number.split(".")[0] : null,
      });
    }

    return refs;
  } catch (err: any) {
    log.error("Failed to resolve cross-references", { guid, error: err.message });
    return [];
  }
}

// ─── Corpus-Wide Cross-Reference Validation ──────────────────────────

export interface CrossRefValidationResult {
  /** Total cross-references found across all sections */
  totalReferences: number;
  /** References that resolve to an actual section */
  resolvedCount: number;
  /** References that do NOT resolve to any section */
  unresolvedCount: number;
  /** Unresolved references grouped by section number */
  unresolved: Array<{ sectionNumber: string; citation: string; sectionGuid: string }>;
  /** Resolution rate (0-1) */
  resolutionRate: number;
  /** Sections with the most unresolved references */
  mostUnresolved: Array<{ sectionNumber: string; count: number }>;
}

/**
 * Validate all internal cross-references across the entire code corpus.
 * Checks every § X.XX.XXX pattern in every section against all known sections.
 */
export async function validateAllCrossReferences(): Promise<CrossRefValidationResult> {
  try {
    const sections = await loadAllSections();
    const sectionNumbers = new Set(sections.map(s => s.number));
    const prefixMap = new Map<string, string>(); // prefix → full number
    for (const s of sections) {
      const parts = s.number.split(".");
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join(".");
        if (!prefixMap.has(prefix)) prefixMap.set(prefix, s.number);
      }
    }

    const refPattern = /§\s*(\d+\.\d+(?:\.\d+)?)(?:\(?[A-Z]\)?)?/g;
    const unresolved: Array<{ sectionNumber: string; citation: string; sectionGuid: string }> = [];
    let totalReferences = 0;
    let resolvedCount = 0;
    const unresolvedBySection = new Map<string, number>();

    for (const section of sections) {
      const matches = [...section.text.matchAll(refPattern)];
      const seen = new Set<string>();

      for (const match of matches) {
        const sectionNumber = match[1];
        if (seen.has(sectionNumber)) continue;
        seen.add(sectionNumber);
        totalReferences++;

        const exact = sectionNumbers.has(sectionNumber);
        const prefix = prefixMap.has(sectionNumber);

        if (exact || prefix) {
          resolvedCount++;
        } else {
          unresolved.push({
            sectionNumber,
            citation: match[0],
            sectionGuid: section.guid,
          });
          unresolvedBySection.set(section.number, (unresolvedBySection.get(section.number) ?? 0) + 1);
        }
      }
    }

    const unresolvedCount = totalReferences - resolvedCount;
    const mostUnresolved = [...unresolvedBySection.entries()]
      .map(([sectionNumber, count]) => ({ sectionNumber, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalReferences,
      resolvedCount,
      unresolvedCount,
      unresolved,
      resolutionRate: totalReferences > 0 ? resolvedCount / totalReferences : 1,
      mostUnresolved,
    };
  } catch (err: any) {
    log.error("Failed to validate cross-references", { error: err.message });
    return {
      totalReferences: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      unresolved: [],
      resolutionRate: 1,
      mostUnresolved: [],
    };
  }
}

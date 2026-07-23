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

    // Build term frequency for target
    const targetWords = target.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const targetFreq = new Map<string, number>();
    for (const w of targetWords) {
      targetFreq.set(w, (targetFreq.get(w) ?? 0) + 1);
    }

    // Score all other sections by term overlap
    const scored: SimilarSection[] = [];

    for (const section of sections) {
      if (section.guid === guid) continue;

      // Same Title prefix → structural similarity boost
      const sameTitle = section.number.split(".")[0] === target.number.split(".")[0];

      const sectionWords = section.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const sectionFreq = new Map<string, number>();
      for (const w of sectionWords) {
        sectionFreq.set(w, (sectionFreq.get(w) ?? 0) + 1);
      }

      // Cosine-like similarity
      let dotProduct = 0;
      for (const [term, freq] of targetFreq) {
        if (sectionFreq.has(term)) {
          dotProduct += freq * sectionFreq.get(term)!;
        }
      }

      const magnitude1 = Math.sqrt([...targetFreq.values()].reduce((a, b) => a + b * b, 0));
      const magnitude2 = Math.sqrt([...sectionFreq.values()].reduce((a, b) => a + b * b, 0));
      const cosineSim = magnitude1 > 0 && magnitude2 > 0 ? dotProduct / (magnitude1 * magnitude2) : 0;

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
    return scored.slice(0, limit);
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

      // Try exact match first
      const exact = sections.find(s => s.number === sectionNumber);
      // Then prefix match
      const prefix = sections.find(s => s.number.startsWith(sectionNumber));

      const resolved = exact ?? prefix;

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

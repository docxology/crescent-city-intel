/**
 * Readability utilities for municipal code sections.
 *
 * Implements:
 * - Flesch-Kincaid Grade Level (standard legal readability metric)
 * - Flesch Reading Ease score
 * - Gunning Fog Index (based on complex word percentage)
 * - Simple word-count statistics
 *
 * No external dependencies — pure TypeScript/arithmetic.
 *
 * Grade level interpretation:
 *   < 8: Plain language (ideal for public notices)
 *   8-12: High school level
 *   12-16: College level (typical for legal text)
 *   > 16: Professional/legal (often impenetrable to average reader)
 */

/** Count syllables in an English word using vowel-run heuristic */
function syllableCount(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 2) return 1;

  // Remove silent trailing 'e'
  const stripped = word.replace(/e$/, '');

  // Count vowel runs
  const runs = stripped.match(/[aeiouy]+/g);
  const count = runs ? runs.length : 1;

  return Math.max(1, count);
}

/**
 * Returns true if the word is "complex" for Gunning Fog:
 * 3+ syllables, not a common suffix form (-ing, -es, -ed with 3+ syllables after stripping).
 * Also excludes proper nouns (words starting with uppercase in the original).
 */
function isComplexWord(word: string, isSentenceInitial = false): boolean {
  if (word.length === 0) return false;
  const isCapitalized = word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
  // Proper-noun heuristic: a capitalized word is usually a proper noun (not a
  // complex word). BUT a sentence-initial word is capitalized for grammatical
  // reasons — dropping it here under-reports complexity for polysyllabic
  // content words like "Notwithstanding"/"Municipal" that legitimately start a
  // sentence (TODO flagged this; see computeReadability for the caller that
  // supplies sentence-initial context).
  if (isCapitalized && !isSentenceInitial) return false;
  const syls = syllableCount(word);
  if (syls < 3) return false;
  // Exclude common suffix forms that inflate complexity
  const low = word.toLowerCase();
  if (low.endsWith('ing') || low.endsWith('ed') || low.endsWith('es') || low.endsWith('er')) {
    // Only exclude if dropping suffix gives 2-syllable root
    const root = low.replace(/(?:ing|ed|es|er)$/, '');
    if (syllableCount(root) <= 2) return false;
  }
  return true;
}

/**
 * Split text into sentences (handles periods, !, ?).
 *
 * Legal text is saturated with period-bearing tokens that are NOT sentence
 * boundaries — decimal section numbers (`§ 8.04.010`), statutory citations
 * (`U.S.C.`), and common abbreviations (`No.`, `Cal.`, `Ave.`). Naively
 * splitting on every `.` fragments one sentence into dozens and collapses the
 * words-per-sentence metric that drives Flesch-Kincaid, Reading Ease and
 * Gunning Fog. We shield those tokens before splitting, then restore them.
 */
function splitSentences(text: string): string[] {
  const protectedTokens: string[] = [];
  const shield = (token: string): string => {
    protectedTokens.push(token);
    return `\u0000${protectedTokens.length - 1}\u0000`;
  };
  const shielded = text
    // Decimal section/ordinance numbers (8.04.010) and numeric decimals (7.5)
    .replace(/\b\d+(?:\.\d+)+\b/g, shield)
    // Multi-letter dotted abbreviations (U.S.C., e.g., i.e., a.k.a.)
    .replace(/\b(?:[A-Za-z]\.){2,}\b/g, shield)
    // Common single abbreviations followed by a period
    .replace(/\b(?:No|Nos|Cal|Ave|St|Mr|Mrs|Ms|Dr|Prof|Sect|Sec|Fig|etc|vs)\.\b/gi, shield);

  const parts = shielded.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
  return parts.map(p => p.replace(/\u0000(\d+)\u0000/g, (_, idx) => protectedTokens[Number(idx)]));
}

/** Split text into words (alphabetic only) */
function splitWords(text: string): string[] {
  return (text.match(/\b[a-zA-Z]+\b/g) ?? []).filter(w => w.length > 0);
}

export interface ReadabilityScore {
  /** Flesch-Kincaid Grade Level (US school grade equivalent) */
  gradeLevel: number;
  /** Flesch Reading Ease (0-100, higher = easier) */
  readingEase: number;
  /** Gunning Fog Index (grade level based on complex word %) */
  gunningFog: number;
  /** Percentage of complex words (3+ syllables) */
  complexWordPct: number;
  /** Average syllables per word */
  avgSyllablesPerWord: number;
  /** Average words per sentence */
  avgWordsPerSentence: number;
  /** Total word count */
  wordCount: number;
  /** Total sentence count */
  sentenceCount: number;
  /** Plain-English label */
  difficulty: "plain" | "standard" | "complex" | "legal";
}

/**
 * Compute Flesch-Kincaid readability scores for a text.
 * Returns null for text that is too short to score meaningfully (< 10 words).
 */
export function computeReadability(text: string): ReadabilityScore | null {
  const words = splitWords(text);
  const sentences = splitSentences(text);

  if (words.length < 10 || sentences.length < 1) return null;

  const totalSyllables = words.reduce((n, w) => n + syllableCount(w), 0);
  const ASL = words.length / sentences.length;          // average sentence length
  const ASW = totalSyllables / words.length;             // average syllables per word

  const gradeLevel = Math.round((0.39 * ASL + 11.8 * ASW - 15.59) * 10) / 10;
  const readingEase = Math.round((206.835 - 1.015 * ASL - 84.6 * ASW) * 10) / 10;

  // The first alphabetic token of every sentence is sentence-initial — its
  // capitalization is grammatical, so it must not be treated as a proper noun.
  const sentenceInitialWords = new Set<string>();
  for (const sentence of sentences) {
    const first = (sentence.match(/\b[a-zA-Z]+\b/) ?? [])[0];
    if (first) sentenceInitialWords.add(first.toLowerCase());
  }

  // Gunning Fog Index: 0.4 * (ASL + %complex_words)
  const complexCount = words.filter((w) => isComplexWord(w, sentenceInitialWords.has(w.toLowerCase()))).length;
  const complexWordPct = (complexCount / words.length) * 100;
  const gunningFog = Math.round((0.4 * (ASL + complexWordPct)) * 10) / 10;

  let difficulty: ReadabilityScore['difficulty'];
  if (gradeLevel < 8) difficulty = 'plain';
  else if (gradeLevel < 12) difficulty = 'standard';
  else if (gradeLevel < 16) difficulty = 'complex';
  else difficulty = 'legal';

  return {
    gradeLevel,
    readingEase,
    gunningFog,
    complexWordPct: Math.round(complexWordPct * 10) / 10,
    avgSyllablesPerWord: Math.round(ASW * 100) / 100,
    avgWordsPerSentence: Math.round(ASL * 10) / 10,
    wordCount: words.length,
    sentenceCount: sentences.length,
    difficulty,
  };
}

/**
 * Score all sections and summarize readability for the entire code.
 * Returns a sorted list (hardest → easiest) with per-section scores.
 */
export function scoreCorpusReadability(
  sections: Array<{ number: string; title: string; text: string }>
): Array<{ number: string; title: string; score: ReadabilityScore }> {
  const results: Array<{ number: string; title: string; score: ReadabilityScore }> = [];
  for (const s of sections) {
    const score = computeReadability(s.text);
    if (score) results.push({ number: s.number, title: s.title, score });
  }
  results.sort((a, b) => b.score.gradeLevel - a.score.gradeLevel);
  return results;
}

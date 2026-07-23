/**
 * Fuzzy matching engine for typo-tolerant search.
 *
 * Implements Levenshtein edit distance for typo-tolerant queries.
 * Integrates with the existing BM25 search engine as a fallback:
 * if a BM25 search returns 0 results, fuzzy matching kicks in to
 * find the closest matches by edit distance.
 */

/**
 * Compute Levenshtein edit distance between two strings.
 * Uses the classic dynamic programming algorithm with O(m*n) time and space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two rows to save memory
  let prevRow = new Array(b.length + 1);
  let currRow = new Array(b.length + 1);

  // Initialize first row
  for (let j = 0; j <= b.length; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,        // deletion
        currRow[j - 1] + 1,     // insertion
        prevRow[j - 1] + cost   // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length];
}

/**
 * Compute a normalized similarity ratio (0-1) between two strings.
 * 1 = identical, 0 = completely different.
 */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Find the closest match for a word from a list of candidates.
 * Returns the best match and its similarity score, or null if no match
 * exceeds the threshold.
 */
export function closestMatch(
  query: string,
  candidates: string[],
  threshold: number = 0.6
): { word: string; score: number } | null {
  let best: { word: string; score: number } | null = null;

  for (const candidate of candidates) {
    const score = similarity(query.toLowerCase(), candidate.toLowerCase());
    if (score >= threshold) {
      if (!best || score > best.score) {
        best = { word: candidate, score };
      }
    }
  }

  return best;
}

/**
 * Find fuzzy matches for each word in the query against a vocabulary.
 * Returns a list of corrections for words that had no exact match
 * but found a close fuzzy match.
 */
export interface FuzzyCorrection {
  /** Original word from the query */
  original: string;
  /** Suggested correction */
  suggestion: string;
  /** Similarity score (0-1) */
  score: number;
}

export function fuzzyCorrect(
  queryWords: string[],
  vocabulary: Set<string>,
  threshold: number = 0.7
): FuzzyCorrection[] {
  const corrections: FuzzyCorrection[] = [];
  const vocabArray = [...vocabulary];

  for (const word of queryWords) {
    // Skip if exact match exists (case-insensitive)
    if (vocabulary.has(word.toLowerCase())) continue;

    // Skip very short words
    if (word.length < 3) continue;

    const match = closestMatch(word, vocabArray, threshold);
    if (match) {
      corrections.push({
        original: word,
        suggestion: match.word,
        score: match.score,
      });
    }
  }

  return corrections;
}

/**
 * Expand a query string with fuzzy corrections.
 * Returns the original query plus any corrections found.
 */
export function expandQueryFuzzy(
  query: string,
  vocabulary: Set<string>,
  threshold: number = 0.7
): { query: string; corrections: FuzzyCorrection[] } {
  const words = query.split(/\s+/).filter(Boolean);
  const corrections = fuzzyCorrect(words, vocabulary, threshold);

  // Build expanded query with corrections
  const expandedWords = words.map(word => {
    const correction = corrections.find(c => c.original === word);
    return correction ? `${word} ${correction.suggestion}` : word;
  });

  return {
    query: expandedWords.join(" "),
    corrections,
  };
}

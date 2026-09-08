/**
 * Readability run history — bounded JSONL persistence + trend analytics.
 *
 * One entry per readability scoring run (every run is recorded; there is no
 * corpus-unchanged skip — the file is bounded, not deduplicated). Storage
 * mirrors the alert-history precedent: `shared/source_health.ts`
 * appendBoundedJsonl with the shared 10,000-line cap, so the file can never
 * grow without bound.
 *
 * Pure builders first (deterministic, no Date.now inside them), thin
 * orchestrators second: `scripts/run-readability.ts` only aggregates through
 * `buildReadabilityHistoryEntry` and appends via `appendReadabilityHistory`.
 */
import { readFileSync } from "fs";
import type { ReadabilityScore } from "./shared/readability.js";
import { appendBoundedJsonl, JSONL_HISTORY_MAX_LINES } from "./shared/source_health.js";
import { paths } from "./shared/paths.js";

/** On-disk history filename, relative to the output root. */
export const HISTORY_FILENAME = "readability/history.jsonl";

/** One readability run in the bounded history file. */
export interface ReadabilityHistoryEntry {
  /** ISO timestamp of the scoring run (same instant as the snapshot's computedAt). */
  runAt: string;
  /** ISO timestamp the corpus data is stated as of, when the caller knows it; null otherwise. */
  asOf: string | null;
  /** Corpus-average Flesch Reading Ease (higher = easier). */
  fleschKincaidEase: number;
  /** Corpus-average Flesch-Kincaid Grade Level. */
  fleschKincaidGrade: number;
  /** Corpus-average Gunning Fog Index. */
  gunningFog: number;
  /** Total sentences across all scored sections. */
  sentenceCount: number;
  /** Total words across all scored sections. */
  wordCount: number;
  /** Total complex words (3+ syllables) across all scored sections. */
  complexWordCount: number;
  /** Number of sections scored in the run. */
  sectionCount: number;
}

/** The `scoreCorpusReadability` output shape (hardest → easiest, order-insensitive here). */
export type ScoredSection = { number: string; title: string; score: ReadabilityScore };

/** Wave-2 route envelope for GET /api/readability/history. */
export interface ReadabilityTrendBucket {
  windowStart: string;
  windowEnd: string;
  /** Average Flesch Reading Ease across the bucket's runs; null when the bucket has no runs. */
  avgEase: number | null;
  runs: number;
}

/** Wave-2 route envelope for GET /api/readability/history. */
export interface ReadabilityTrend {
  count: number;
  latest: ReadabilityHistoryEntry | null;
  previous: ReadabilityHistoryEntry | null;
  /** latest − previous per headline metric; null until two runs exist. */
  delta: { ease: number; grade: number; fog: number } | null;
  buckets: ReadabilityTrendBucket[];
  earliestRunAt: string | null;
  latestRunAt: string | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

const NUMERIC_FIELDS = [
  "fleschKincaidEase",
  "fleschKincaidGrade",
  "gunningFog",
  "sentenceCount",
  "wordCount",
  "complexWordCount",
  "sectionCount",
] as const;

/** Runtime guard used to skip malformed history lines. */
export function isReadabilityHistoryEntry(value: unknown): value is ReadabilityHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.runAt !== "string" || !Number.isFinite(Date.parse(e.runAt))) return false;
  if (e.asOf !== null && typeof e.asOf !== "string") return false;
  return NUMERIC_FIELDS.every((f) => typeof e[f] === "number" && Number.isFinite(e[f]));
}

/** The bounded history file path (follows the CC_OUTPUT_DIR test seam). */
export function readabilityHistoryPath(): string {
  return paths.readabilityHistory;
}

/**
 * Aggregate one scoring run's per-section scores into a single history entry.
 * Pure: same input → same entry. Empty input yields an honest zero run.
 */
export function buildReadabilityHistoryEntry(
  scored: readonly ScoredSection[],
  runAt: string,
  asOf: string | null = null,
): ReadabilityHistoryEntry {
  const n = scored.length;
  const sum = (pick: (s: ScoredSection) => number): number =>
    scored.reduce((acc, s) => acc + pick(s), 0);
  return {
    runAt,
    asOf,
    fleschKincaidEase: n > 0 ? round1(sum((s) => s.score.readingEase) / n) : 0,
    fleschKincaidGrade: n > 0 ? round1(sum((s) => s.score.gradeLevel) / n) : 0,
    gunningFog: n > 0 ? round1(sum((s) => s.score.gunningFog) / n) : 0,
    sentenceCount: sum((s) => s.score.sentenceCount),
    wordCount: sum((s) => s.score.wordCount),
    // Complex-word counts are recovered from the per-section percentage (the
    // scorer stores complexWordPct, not the raw count) — rounded, not recomputed.
    complexWordCount: Math.round(sum((s) => (s.score.wordCount * s.score.complexWordPct) / 100)),
    sectionCount: n,
  };
}

/**
 * Append one run to the bounded history file (10,000-line cap by default).
 * The appender creates parent directories and trims to the most-recent tail
 * when the cap is exceeded; a failed trim never breaks the append.
 */
export async function appendReadabilityHistory(
  entry: ReadabilityHistoryEntry,
  path: string = readabilityHistoryPath(),
  maxLines: number = JSONL_HISTORY_MAX_LINES,
): Promise<void> {
  await appendBoundedJsonl(path, entry, maxLines);
}

/**
 * Read the history file, skipping malformed lines (bad JSON, wrong shape).
 * Returns entries in chronological order (oldest → newest); with `limit`,
 * returns the most-recent `limit` entries in the same order. Missing file → [].
 */
export function readReadabilityHistory(
  limit?: number,
  path: string = readabilityHistoryPath(),
): ReadabilityHistoryEntry[] {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const entries: ReadabilityHistoryEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip corrupt row
    }
    if (isReadabilityHistoryEntry(parsed)) entries.push(parsed);
  }
  return typeof limit === "number" && limit >= 0 ? entries.slice(-limit) : entries;
}

/**
 * Build the readability trend envelope from history entries.
 *
 * Pure and deterministic: nothing reads the clock — pass `opts.now` (ISO) to
 * anchor the bucket windows; when omitted the newest entry's runAt anchors.
 * Entries are sorted by runAt internally, so input order does not matter.
 * Empty input yields the honest empty state ({count: 0, latest: null, buckets: []}).
 *
 * Buckets are consecutive `windowDays` (default 30) windows walking backward
 * from the end instant, oldest-first, spanning back to the earliest run.
 */
export function buildReadabilityTrend(
  entries: readonly ReadabilityHistoryEntry[],
  opts: { windowDays?: number; now?: string } = {},
): ReadabilityTrend {
  const empty: ReadabilityTrend = {
    count: 0,
    latest: null,
    previous: null,
    delta: null,
    buckets: [],
    earliestRunAt: null,
    latestRunAt: null,
  };
  if (entries.length === 0) return empty;

  const sorted = [...entries].sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  const latest = sorted[sorted.length - 1];
  const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
  const delta = previous
    ? {
        ease: round1(latest.fleschKincaidEase - previous.fleschKincaidEase),
        grade: round1(latest.fleschKincaidGrade - previous.fleschKincaidGrade),
        fog: round1(latest.gunningFog - previous.gunningFog),
      }
    : null;

  const latestTime = Date.parse(latest.runAt);
  const startTime = Date.parse(sorted[0].runAt);
  const requestedEnd = opts.now !== undefined ? Date.parse(opts.now) : latestTime;
  if (!Number.isFinite(latestTime) || !Number.isFinite(startTime) || !Number.isFinite(requestedEnd)) {
    return { ...empty, count: sorted.length };
  }

  const windowMs = (opts.windowDays ?? 30) * 86_400_000;
  const end = Math.max(requestedEnd, latestTime);
  const buckets: ReadabilityTrendBucket[] = [];
  let bucketEnd = end;
  // Walk windows backward until the window start reaches the earliest run, so
  // every entry lands in exactly one bucket (half-open windows; the newest
  // window is closed at `end`).
  while (true) {
    const bucketStart = bucketEnd - windowMs;
    const isNewest = buckets.length === 0;
    const inBucket = sorted.filter((e) => {
      const t = Date.parse(e.runAt);
      return t >= bucketStart && (isNewest ? t <= bucketEnd : t < bucketEnd);
    });
    buckets.push({
      windowStart: new Date(bucketStart).toISOString(),
      windowEnd: new Date(bucketEnd).toISOString(),
      avgEase: inBucket.length > 0
        ? round1(inBucket.reduce((s, e) => s + e.fleschKincaidEase, 0) / inBucket.length)
        : null,
      runs: inBucket.length,
    });
    if (!(bucketStart > startTime)) break;
    bucketEnd = bucketStart;
  }
  buckets.reverse();

  return {
    count: sorted.length,
    latest,
    previous,
    delta,
    buckets,
    earliestRunAt: sorted[0].runAt,
    latestRunAt: latest.runAt,
  };
}

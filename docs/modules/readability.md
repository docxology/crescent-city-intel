# Readability Module

## `src/readability_history.ts` — bounded per-run readability history + trend

Persists one entry per readability scoring run and turns the accumulated
history into a trend envelope. Storage follows the **alert-history precedent**
(docs/modules/alerts.md): bounded JSONL through `shared/source_health.ts`
`appendBoundedJsonl`, capped at the shared **10,000-line** limit
(`JSONL_HISTORY_MAX_LINES`), so the file can never grow without bound. There is
**one entry per run and no corpus-unchanged skip** — runs are recorded, not
deduplicated; the bound is the cap, and idempotency stores are a different
mechanism (`shared/idempotency.ts`, content-hash keyed, not applicable to
whole-corpus scoring).

The scorer itself is untouched (`src/shared/readability.ts`, documented in
`docs/modules/shared.md`); this module only aggregates the scores that
`scoreCorpusReadability` already computed. All math lives here — the CLI is a
thin orchestrator.

## History entry envelope

One JSON object per line in `output/readability/history.jsonl`:

```typescript
interface ReadabilityHistoryEntry {
  runAt: string;                 // ISO timestamp of the scoring run (= snapshot computedAt)
  asOf: string | null;           // corpus as-of stamp when the caller knows it; null otherwise
  fleschKincaidEase: number;     // corpus-average Flesch Reading Ease
  fleschKincaidGrade: number;    // corpus-average Flesch-Kincaid Grade Level
  gunningFog: number;            // corpus-average Gunning Fog Index
  sentenceCount: number;         // total sentences across scored sections
  wordCount: number;             // total words across scored sections
  complexWordCount: number;      // total complex words (recovered from per-section complexWordPct)
  sectionCount: number;          // sections scored in the run
}
```

A run with zero scoreable sections is recorded honestly as zeros
(`sectionCount: 0`), not skipped.

## Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `HISTORY_FILENAME` | `"readability/history.jsonl"` | On-disk name, relative to the output root |
| `ReadabilityHistoryEntry` | interface | One run in the history file |
| `buildReadabilityHistoryEntry(scored, runAt, asOf?)` | `(ScoredSection[], string, string?) → ReadabilityHistoryEntry` | Pure aggregate of one run's per-section scores |
| `readabilityHistoryPath()` | `() → string` | `paths.readabilityHistory` (follows the `CC_OUTPUT_DIR` test seam) |
| `appendReadabilityHistory(entry, path?, maxLines?)` | `(ReadabilityHistoryEntry, string?, number?) → Promise<void>` | Bounded append; creates parent dirs, trims to the most-recent tail over the cap |
| `readReadabilityHistory(limit?, path?)` | `(number?, string?) → ReadabilityHistoryEntry[]` | Tail reader; skips malformed lines (bad JSON, wrong shape, invalid runAt); chronological order; missing file → `[]` |
| `buildReadabilityTrend(entries, opts?)` | `(ReadabilityHistoryEntry[], {windowDays?, now?}?) → ReadabilityTrend` | Pure trend builder; sorts by runAt internally |
| `isReadabilityHistoryEntry(value)` | `(unknown) → boolean` | Runtime guard used to skip corrupt history lines |

## Trend envelope

`buildReadabilityTrend` is **pure and deterministic**: nothing reads the clock —
pass `opts.now` (ISO) to anchor the windows; when omitted, the newest entry's
`runAt` anchors. `opts.windowDays` (default 30) sizes consecutive half-open
windows walking backward from the end instant, oldest-first, spanning back to
the earliest run so every entry lands in exactly one bucket.

```typescript
interface ReadabilityTrend {
  count: number;               // entries considered
  latest: ReadabilityHistoryEntry | null;
  previous: ReadabilityHistoryEntry | null;
  delta: { ease: number; grade: number; fog: number } | null;  // latest − previous; null until two runs
  buckets: Array<{
    windowStart: string; windowEnd: string;
    avgEase: number | null;    // null when the bucket has no runs
    runs: number;
  }>;
  earliestRunAt: string | null;
  latestRunAt: string | null;
}
```

Empty input yields the honest empty state
(`{count: 0, latest: null, previous: null, delta: null, buckets: [], earliestRunAt: null, latestRunAt: null}`).

## CLI

`scripts/run-readability.ts` (unchanged invocation: `bun run readability`) now
appends one history entry per run after its existing snapshot write, using the
same `computedAt` instant for both artifacts; a failed append is logged as a
warning and never fails the scoring run.

Writes:

- `output/readability.json` — per-run snapshot report (unchanged shape)
- `output/readability/history.jsonl` — bounded per-run history

## Wave-2 API contract

`GET /api/readability/history?limit=&offset=` (registered by the routes agent
this wave) serves the shared envelope:

```json
{
  "total": 123,        // valid entries in the whole history
  "count": 20,         // entries on this page
  "offset": 0,
  "limit": 20,
  "entries": [ ... ],  // page slice, chronological (oldest → newest), via readReadabilityHistory
  "trend": { ... }     // buildReadabilityTrend output over the full history
}
```

The route must call the exported pure builders (`readReadabilityHistory`,
`buildReadabilityTrend`) rather than re-parsing the file, so API/Pages shapes
cannot drift.

## Tests

`tests/readability-history.test.ts` (11) — append + chronological tail read +
`limit`, bounded cap retaining the most-recent tail, malformed-line skip
(unparseable, missing fields, invalid `runAt`), missing-file empty read,
output-root seam resolution, aggregate math (averages, sums, complex-word
recovery, empty-run zeros), and trend math with a fixed `now`: empty-state
envelope, single-run `delta: null`, delta signs + bucket averages, and
order-insensitive latest/previous selection.

Run with: `bun test tests/readability-history.test.ts`.

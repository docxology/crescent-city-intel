# Shared Module

## `src/shared/paths.ts` — Path Resolution

Centralized getters resolve the captured `withOutputRoot(root, task)` context first,
then `CC_OUTPUT_DIR`, then the declared default. The asynchronous context keeps
overlapping producers isolated without changing process-wide environment state.
Child entry points receive the declared root explicitly; readers and writers
capture it before awaiting work.

### `paths` Object

| Key | Value | Description |
| :--- | :--- | :--- |
| `output` | `output` | Root output directory |
| `articles` | `output/articles` | Per-article JSON directory |
| `toc` | `output/toc.json` | TOC tree file |
| `manifest` | `output/manifest.json` | Scrape manifest |
| `verificationReport` | `output/verification-report.json` | Verification results |
| `consolidatedJson` | `output/crescent-city-code.json` | Consolidated JSON export |
| `plainText` | `output/crescent-city-code.txt` | Plain text export |
| `sectionIndex` | `output/section-index.csv` | CSV section index |
| `markdown` | `output/markdown` | Markdown export directory |
| `article(guid)` | `output/articles/{guid}.json` | Per-article path function |

---

## `src/shared/data.ts` — Data Loading Layer

Reads scraped output from disk. All loaders provide **actionable error messages** including the `bun run scrape` instruction when data is absent. Articles are loaded in **parallel** via `Promise.allSettled` for speed.

### Core Loaders

| Function | Signature | Description |
| :--- | :--- | :--- |
| `loadToc` | `() → Promise<TocNode>` | Parse `output/toc.json`; throws with actionable message if absent |
| `loadManifest` | `() → Promise<ScrapeManifest>` | Parse `output/manifest.json`; throws with actionable message if absent |
| `loadArticle` | `(guid) → Promise<ArticlePage>` | Load single article JSON by GUID |
| `loadAllArticles` | `(root?) → Promise<ArticlePage[]>` | Load declared articles; truly absent/empty corpus → `[]`; partial/corrupt/linked editions reject |
| `loadAllSections` | `() → Promise<FlatSection[]>` | Flatten all articles into section array with article context |
| `loadSection` | `(guid) → Promise<FlatSection \| undefined>` | Find a single section by GUID across all articles |

### Monitoring

| Function | Signature | Description |
| :--- | :--- | :--- |
| `loadMonitorReport` | `() → Promise<MonitorReport \| undefined>` | Load latest monitor report; `undefined` if never run |

### Existence Checks

| Function | Signature | Description |
| :--- | :--- | :--- |
| `hasScrapedData` | `() → boolean` | True if `toc.json` + `manifest.json` both exist (synchronous) |
| `hasArticles` | `() → Promise<boolean>` | True if articles directory is non-empty |

### `FlatSection` Fields

```typescript
interface FlatSection {
  guid: string;
  number: string;
  title: string;
  text: string;
  history: string;      // legislative history line
  articleGuid: string;
  articleTitle: string;
  articleNumber: string;
}
```

### Usage Pattern

Municipal GUI, LLM, export and monitor consumers use these shared loaders.
Source/report producers have their own bounded readers and shared family
validators. Article loading checks current manifest membership and raw/parsed
custody; section caches and in-flight loads are keyed by the captured root, so
one root cannot satisfy another root's load.

```typescript
import { loadAllSections, hasScrapedData, loadSection } from "../shared/data.js";

if (!hasScrapedData()) {
  console.error("Run bun run scrape first");
  process.exit(1);
}

const sections = await loadAllSections();
const single = await loadSection("some-guid");
```

---

## `src/shared/idempotency.ts` — Shared Idempotency Store

A single `(id, contentHash)`-keyed, JSON-persisted, atomic-write dedup store
used by the news, government-meeting, and curation monitors (and extensible to
any source) instead of each source reinventing its own persistence shape.

### Key points

- **Presence-only or change-aware dedup**: `seen(id)` with no hash records
  "have we seen this" (news-style URL dedup); pass a content hash to get real
  change detection (`changed: true` when the hash differs from the last
  observation).
- **Legacy migration**: `load()` transparently recognizes the old
  `news_monitor.ts` bare `string[]` seen-ids shape and migrates it to
  presence-only records within the declared retention cap. Original observation
  dates remain empty with `dateEvidence: legacy-unknown`; migration never makes
  old IDs freshly observed.
- **Owned merge/publication**: `save()` merges under a token-owned lease;
  `publish(root, artifacts, options)` commits the merged seen records and source
  artifacts through a recoverable exact-byte transaction. A published identity
  cannot advance ahead of its committed batch.
- **Failed input**: bounded 8 MB regular-file reads and fatal UTF-8 decoding
  distinguish missing state from corrupt/linked/oversized evidence. Failed state
  may yield an empty in-memory classification, but save/publish refuse replacing
  the retained input. Recovery requires explicit review of original bytes.
- **Bounded**: retains at most `cap` entries (default 10 000), dropping the
  oldest-`firstSeen` first.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `IdempotencyStore` | `class` | `new IdempotencyStore(path, cap?)`; `load()`, `has(id)`, `get(id)`, `seen(id, hash?, meta?)`, `record(id, hash?, meta?)`, `save()`, `publish(root, artifacts, options?)`, `size` |
| `hashContent` | `(string) → string` | SHA-256 (re-export of `computeSha256`) so callers import from one place |
| `IdempotencyRecord` | `type` | `{ hash, firstSeen, lastSeen, meta? }` |
| `SeenResult` | `type` | `{ isNew, changed }` |

Tests: `tests/idempotency.test.ts`.

### Tests

```bash
bun test tests/shared-paths.test.ts
bun test tests/shared-data.test.ts
bun test tests/idempotency.test.ts
```

## `src/shared/orchestration.ts` — Durable Run Envelopes

Shared orchestration and build metadata helpers: `executePipelineStep()` and `buildPipelineRun()` wrap pipeline steps in durable step/run envelopes over the source-health primitives. Tests: `tests/orchestration.test.ts`.

`packageVersion()` reads the application package version without running Git;
an unreadable manifest yields `unknown`. GUI metadata uses it with the explicit
`APP_VERSION` override. `runtimeMetadata()` adds commit/runtime/CI diagnostics
for pipeline receipts.

## `src/shared/output_fence.ts` — The Output Fence

Proof that running the test suite did not modify the real `output/` corpus: the gate snapshots every regular file's size and hash before and after the suite and fails on any drift. `output/` is gitignored, so nothing else would catch a test writing into the artifact tree.

## Owned execution and transactions

`shared/run_scope.ts` carries the selected root, parent cancellation signal and
remaining deadline through asynchronous work. `shared/artifact_transaction.ts`
stages bounded exact-byte replacements, retains originals and journals progress
before activation. Restart recovery or explicit rollback restores a complete
prior set; directory/receipt membership and symlink admission fail closed.
`shared/storage.ts` publishes private lease ownership with an exclusive prepared
file/hardlink, validates ancestor namespaces before writing and only releases or
recovers the observed owner token. An unrelated directory, file or live owner is
not cleanup authority.

`shared/process_ownership.ts` and `shared/subprocess.ts` stop owned process groups,
cap captured output and retain kill/reap receipts. Browser acquisition uses its
own authenticated private launcher identity, including before protocol setup;
a dead controller does not authorize deleting a launcher-named directory whose
private identity is absent. Weekly attempt archives preserve interruption and
previous completion rather than turning an interrupted run into success.

Source batch/health/seen transactions do not claim an atomic update across every
historical JSONL append or external consumer location. History follows committed
source publication. Hashes and recovery fixtures establish the exact tested
filesystem/process boundary, not arbitrary hardware or power-loss durability.

# Shared Module

## `src/shared/paths.ts` — Path Resolution

Centralized path constants for all output files. Imports `OUTPUT_DIR` and `ARTICLES_DIR` from `constants.ts`.

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
| `loadAllArticles` | `() → Promise<ArticlePage[]>` | Load all articles in parallel (returns `[]` if dir absent) |
| `loadAllSections` | `() → Promise<FlatSection[]>` | Flatten all articles into section array with article context |
| `loadSection` | `(guid) → Promise<FlatSection \| undefined>` | Find a single section by GUID across all articles |

### Search and Monitoring

| Function | Signature | Description |
| :--- | :--- | :--- |
| `searchSections` | `(query, sections?) → Promise<FlatSection[]>` | Substring search across section number, title, text |
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

All consumer modules (GUI, LLM, Export, Monitor) read through this layer. No module accesses `output/` files directly.

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
  presence-only records — no history is lost, nothing is reprocessed as new.
- **Durability**: `save()` writes a temp file, `fsync`s it, then renames — a
  power loss between write and rename can no longer leave a partially-written
  file that would be silently discarded as "start empty".
- **Bounded**: retains at most `cap` entries (default 10 000), dropping the
  oldest-`firstSeen` first.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `IdempotencyStore` | `class` | `new IdempotencyStore(path, cap?)`; `load()`, `has(id)`, `get(id)`, `seen(id, hash?, meta?)`, `record(id, hash?, meta?)`, `save()`, `size` |
| `hashContent` | `(string) → string` | SHA-256 (re-export of `computeSha256`) so callers import from one place |
| `IdempotencyRecord` | `type` | `{ hash, firstSeen, lastSeen, meta? }` |
| `SeenResult` | `type` | `{ isNew, changed }` |

Tests: `tests/idempotency.test.ts`.

### Tests

```bash
bun test tests/shared-paths.test.ts   # 10 tests
bun test tests/shared-data.test.ts    # 20 tests
bun test tests/idempotency.test.ts
```

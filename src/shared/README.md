# Shared Utilities — `src/shared/`

Centralized path resolution and data loading layer for all `src/` modules.

## Modules

### `paths.ts` — Output file paths

```typescript
import { paths } from "../shared/paths.js";

paths.output          // "output/"
paths.articles        // "output/articles/"
paths.toc             // "output/toc.json"
paths.manifest        // "output/manifest.json"
paths.verificationReport // "output/verification-report.json"
paths.consolidatedJson   // "output/crescent-city-code.json"
paths.plainText          // "output/crescent-city-code.txt"
paths.sectionIndex       // "output/section-index.csv"
paths.markdown           // "output/markdown/"
paths.article(guid)      // "output/articles/<guid>.json"
paths.pipelineRun        // "output/state/latest-pipeline-run.json"
paths.curationReport     // "output/state/curation-report.json"
paths.latestReportMetadata // "output/reports/latest-metadata.json"
```

### `data.ts` — Data loaders

```typescript
import { loadToc, loadManifest, loadArticle, loadAllArticles, loadAllSections } from "../shared/data.js";

const toc = await loadToc();               // TocNode
const manifest = await loadManifest();     // ScrapeManifest
const article = await loadArticle(guid);   // ArticlePage
const articles = await loadAllArticles();  // ArticlePage[]
const sections = await loadAllSections();  // SectionContent[]
```

All loaders throw if files are absent — callers should handle errors or use `try/catch`.

### `source_health.ts` — truthful source state

`sourceHealth()` creates the common `ok`, `empty`, `unavailable`, or `stale`
envelope and derives `freshness`, `ageMs`, and the configured freshness window
when a fetch timestamp exists. `summarizeSourceHealth()` provides aggregate
counts for reports, APIs, and dashboards without collapsing unavailable feeds
into empty or calm results. JSON and text artifacts use atomic temp-file then
rename writes.

### `orchestration.ts` — durable run state

`executePipelineStep()` turns each stage into an observable result with
duration, item count, output paths, and errors. `buildPipelineRun()` and
`writePipelineRun()` produce the versioned operational envelope consumed by
the weekly checker, API metadata, and public snapshot. It records no secrets
or request contents.

## Tests

```bash
bun test tests/shared-paths.test.ts
bun test tests/shared-data.test.ts
```

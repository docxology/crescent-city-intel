# Agents Guide — `src/shared/`

## Overview

Data access layer and shared utilities for all `src/` modules. Centralizes
output file paths, data loading, text processing, search primitives, and
readability scoring.

## Convention

- **Never hardcode paths** — always import from `paths.ts`.
- **Never read files directly** — use `data.ts` loader functions.
- These modules have **no side effects** on import (no global state, no startup I/O).

## Modules

| File | Purpose | Tests |
| :--- | :--- | :--- |
| `paths.ts` | Centralized `paths` object with all output file/dir paths | `tests/shared-paths.test.ts` |
| `data.ts` | Async data loaders: `loadToc()`, `loadManifest()`, `loadArticle()`, `loadAllArticles()`, `loadAllSections()`, `loadSection()`, `loadMonitorReport()`, `hasScrapedData()` | `tests/shared-data.test.ts` |
| `porter_stem.ts` | Zero-dep Porter stemmer (Steps 1a-5b) for BM25 indexing | (tested via `tests/search.test.ts`) |
| `readability.ts` | Flesch-Kincaid Grade Level + Reading Ease + Gunning Fog Index | `tests/readability-gunning-fog.test.ts`, `tests/content.test.ts` |
| `fuzzy.ts` | Levenshtein edit distance, similarity ratio, typo correction, query expansion | `tests/fuzzy.test.ts` |

## Public API

```typescript
import { paths } from "../shared/paths.js";
import { loadToc, loadManifest, loadAllSections } from "../shared/data.js";
import { computeReadability } from "../shared/readability.js";
import { levenshtein, similarity, fuzzyCorrect } from "../shared/fuzzy.js";

const toc = await loadToc();           // TocNode
const manifest = await loadManifest(); // ScrapeManifest
const sections = await loadAllSections(); // FlatSection[]
const score = computeReadability(text); // ReadabilityScore | null
const dist = levenshtein("harbr", "harbor"); // 1

paths.toc          // → "output/toc.json"
paths.manifest     // → "output/manifest.json"
paths.output       // → "output/"
paths.articles     // → "output/articles/"
paths.article(guid) // → "output/articles/<guid>.json"
```

## Data Dependencies

All loaders require the `output/` directory to be populated by `bun run scrape`.
Tests that depend on real data gracefully return empty/default results when
output data is absent.

## v2.0+ New Modules

### `fuzzy.ts` (v2.0)
- `levenshtein(a, b)` — edit distance (O(m*n) DP, two-row memory)
- `similarity(a, b)` — normalized 0-1 ratio
- `closestMatch(query, candidates, threshold)` — best match from vocabulary
- `fuzzyCorrect(queryWords, vocabulary, threshold)` — corrections for unknown words
- `expandQueryFuzzy(query, vocabulary)` — expand query with corrections
- Integrated into `gui/search.ts` as BM25 fallback

### `readability.ts` (enhanced v2.0)
- Added Gunning Fog Index: `0.4 * (ASL + %complex_words)`
- `isComplexWord()` — 3+ syllables, excluding common suffix forms
- `scoreCorpusReadability(sections)` — sorted hardest → easiest

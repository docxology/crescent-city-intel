# Agents Guide — `tests/`

## Overview

Bun-native unit tests (`bun:test`) covering all pure-logic functions. **Zero-mock policy**: all tests use real methods, real data, and real modules — no `vi.mock()`, no stubs, no fakes.

## Running

```bash
bun test              # Run all 489 tests across 38 files
bun test tests/utils  # Run a specific file
bun test --watch      # Watch mode
```

## Test Files

| File | Module | Tests |
| :--- | :--- | :--- |
| `utils.test.ts` | `src/utils.ts` — hash, flatten, shuffle, HTML→text, CSV escape, filename | 62 |
| `utils_normalization.test.ts` | `src/utils.ts` — Unicode normalization, section length outliers | 17 |
| `toc.test.ts` | `src/toc.ts` — TOC pure functions | 10 |
| `shared-paths.test.ts` | `src/shared/paths.ts` — all path constants | 10 |
| `shared-data.test.ts` | `src/shared/data.ts` — data loader contracts | 14 |
| `constants.test.ts` | `src/constants.ts` — base constants | 5 |
| `constants-extended.test.ts` | `src/constants.ts` — all env-overridable constants | 10 |
| `logger.test.ts` | `src/logger.ts` — log levels, output suppression | 6 |
| `llm-config.test.ts` | `src/llm/config.ts` — LLM parameter values | 8 |
| `search.test.ts` | `src/gui/search.ts` — in-memory BM25 search engine | 12 |
| `search_enhancements.test.ts` | `src/gui/search.ts` — stop words, synonyms, severity | 25 |
| `analytics.test.ts` | `src/gui/analytics.ts` — PCA, K-means | 6 |
| `routes.test.ts` | `src/gui/routes.ts` — API route contracts | 7 |
| `routes.integration.test.ts` | `src/gui/routes.ts` — real server integration | 15 |
| `embeddings.test.ts` | `src/llm/embeddings.ts` — text chunking | 7 |
| `export.test.ts` | `src/export.ts` — CSV, Markdown, sanitize | 10 |
| `content.test.ts` | `src/content.ts` — HTML extraction, readability, stemming | 14 |
| `content-fixture.test.ts` | `src/content.ts` — HTML parsing, section structure, SHA-256 determinism | 8 |
| `domains.test.ts` | `src/domains.ts` — domain data + search | 15 |
| `domains-extended.test.ts` | `src/domains.ts` — new domains, search edge cases | 13 |
| `monitor.test.ts` | `src/monitor.ts` — monitor report shape | 3 |
| `news_monitor.test.ts` | `src/news_monitor.ts` — error handling, types | 3 |
| `gov_meeting_monitor.test.ts` | `src/gov_meeting_monitor.ts` — error handling | 3 |
| `alerts.test.ts` | `src/alerts/*` — tides, fishing, module imports | 9 |
| `new_alerts.test.ts` | `src/alerts/*` — AQI, wildfire, marine severity | 22 |
| `ndbc-parser.test.ts` | `src/alerts/ndbc_marine.ts` — line parsing, unit conversions, severity | 9 |
| `comprehensive-edges.test.ts` | All v2 modules — boundary + edge cases | 48 |
| `scraper_utils.test.ts` | `src/scrape.ts` / `src/browser.ts` — resume + manifest utilities | 18 |
| `fuzzy.test.ts` | `src/shared/fuzzy.ts` — Levenshtein, fuzzy correct | 18 |
| `legal_parser.test.ts` | `src/legal_parser.ts` — citations, definitions | 15 |
| `structured_queries.test.ts` | `src/structured_queries.ts` — legislative history | 12 |
| `readability-gunning-fog.test.ts` | `src/shared/readability.ts` — Gunning Fog | 6 |
| `alert_analytics.test.ts` | `src/alert_analytics.ts` — timeline, type stats | 8 |
| `v2-endpoints.test.ts` | v2.2 API endpoints — health, report, search analytics, domain coverage | 9 |
| `v2-endpoints-extended.test.ts` | v2.3+ API endpoints — additional edge cases | 6 |
| `middleware.test.ts` | `src/api/middleware.ts` — rate limit, auth | 8 |
| `middleware_sliding_window.test.ts` | `src/api/middleware.ts` — sliding window | 5 |
| `verify.test.ts` | `src/verify.ts` + `src/shared/data.ts` + coverage | 13 |
| `test_chroma.ts` | ChromaDB manual integration (not run in suite) | 0 |

**Total: 489 pass · 0 fail · 38 files**

## Conventions

- **File naming**: `<module>.test.ts` maps to `src/<module>.ts`.
- **No mocks**: Test real behavior — if a module requires external services (Ollama, ChromaDB, network), test its error-handling / graceful-degradation path instead.
- **Data-dependent tests** (`shared-data`, `search`, `analytics`): designed to work with both empty `output/` and populated `output/`. Tests check shape contracts, not specific values.

## Adding Tests

1. Create `tests/<module>.test.ts`
2. Import functions directly: `import { fn } from "../src/<module>.ts"`
3. Use `describe` + `test` + `expect`
4. Document in this AGENTS.md and in the table above

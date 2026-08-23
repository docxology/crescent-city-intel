# Agents Guide — `tests/`

## Overview

Bun-native unit tests (`bun:test`) covering all pure-logic functions. **Zero-mock policy**: all tests use real methods, real data, and real modules — no `vi.mock()`, no stubs, no fakes.

## Running

```bash
bun test              # Run the deterministic suite
bun run validate      # Run the authoritative release gate
bun test tests/utils  # Run a specific file
bun test --watch      # Watch mode
```

## Test Files

| File | Module / coverage |
| :--- | :--- |
| `utils.test.ts` | `src/utils.ts` — hash, flatten, shuffle, HTML→text, CSV escape, filename |
| `utils_normalization.test.ts` | `src/utils.ts` — Unicode normalization, section length outliers |
| `toc.test.ts` | `src/toc.ts` — TOC pure functions |
| `shared-paths.test.ts` | `src/shared/paths.ts` — path constants |
| `shared-data.test.ts` | `src/shared/data.ts` — data loader contracts |
| `constants*.test.ts` | `src/constants.ts` — base and env-overridable constants |
| `logger.test.ts` | `src/logger.ts` — log levels and output suppression |
| `llm-config.test.ts` | `src/llm/config.ts` — provider/model parameters |
| `llm-openrouter.test.ts` | `src/llm/openrouter.ts` — local chat, SSE, cap, and preflight fixtures |
| `search*.test.ts` | `src/gui/search.ts` — BM25, stop words, synonyms, and severity |
| `analytics.test.ts` | `src/gui/analytics.ts` — PCA and K-means |
| `analytics-backend.test.ts` | `src/analytics_backend.ts` — shared overview stability, signals, and small-index analytics |
| `manuscript.test.ts` | `src/manuscript_variables.ts` — publication values derive from the analytics envelope |
| `routes*.test.ts` | `src/gui/routes.ts` — route contracts and real server integration |
| `gui-server.test.ts` | `src/gui/server.ts` — trusted local API-key injection boundary |
| `embeddings.test.ts` | `src/llm/embeddings.ts` — deterministic chunking |
| `export.test.ts` | `src/export.ts` — CSV, Markdown, and filename safety |
| `content*.test.ts` | `src/content.ts` — HTML extraction, readability, fixtures, and SHA-256 |
| `domains*.test.ts` | `src/domains.ts` — domain data and search |
| `monitor.test.ts` | `src/monitor.ts` — monitor report shape |
| `news_monitor.test.ts` | `src/news_monitor.ts` — RSS/Atom parsing, local feed failures, dedup |
| `gov_meeting_monitor.test.ts` | `src/gov_meeting_monitor.ts` — local endpoint failures and persistence |
| `youtube_monitor.test.ts` | `src/youtube_monitor.ts` — VTT parsing and bounded listing failures |
| `triplicate_monitor.test.ts` | `src/triplicate_monitor.ts` — extraction, retry, policy, and idempotency |
| `curation.test.ts` | `src/curation.ts` — grounding, provider degradation, and domain tags |
| `alerts*.test.ts` | `src/alerts/*` — monitor contracts, severity, AQI, wildfire, marine |
| `ndbc-parser.test.ts` | `src/alerts/ndbc_marine.ts` — line parsing, units, and severity |
| `run-alerts.test.ts` | `scripts/run-alerts.ts` — real report-to-severity mappings |
| `comprehensive-edges.test.ts` | Cross-module boundary and edge cases |
| `scraper_utils.test.ts` | `src/scraper_utils.ts` — TOC/artifact validation, retry, and manifest utilities |
| `fuzzy.test.ts` | `src/shared/fuzzy.ts` — Levenshtein and typo correction |
| `legal_parser.test.ts` | `src/legal_parser.ts` — citations, definitions, and ordinances |
| `structured_queries.test.ts` | `src/structured_queries.ts` — legislative history and similarity |
| `geo-view.test.ts` | `src/geo_view.ts` — tiles-free map feature view (bounds/points/sections) from the geo-intel contract |
| `readability-gunning-fog.test.ts` | `src/shared/readability.ts` — Gunning Fog |
| `alert_analytics.test.ts` | `src/alert_analytics.ts` — timeline and type statistics |
| `v2-endpoints*.test.ts` | API endpoint contracts and edge cases |
| `pages_snapshot.test.ts` | Static export schema, atomic artifact boundaries, and source-health truthfulness |
| `middleware*.test.ts` | `src/api/middleware.ts` — authentication and sliding-window limits |
| `idempotency.test.ts` | `src/shared/idempotency.ts` — atomic persistence and migration |
| `verify.test.ts` | `src/verify.ts` + `src/shared/data.ts` + coverage |
| `test_chroma.ts` | ChromaDB manual integration (not run in deterministic suite) |

Test counts are intentionally not hard-coded here; Bun reports current totals
and `bun run validate` is authoritative.

## Conventions

- **File naming**: `<module>.test.ts` maps to `src/<module>.ts`.
- **No mocks**: Test real behavior — if a module requires external services (Ollama, ChromaDB, network), test its error-handling / graceful-degradation path instead.
- **Data-dependent tests** (`shared-data`, `search`, `analytics`): designed to work with both empty `output/` and populated `output/`. Tests check shape contracts, not specific values.

## Adding Tests

1. Create `tests/<module>.test.ts`
2. Import functions directly: `import { fn } from "../src/<module>.ts"`
3. Use `describe` + `test` + `expect`
4. Document in this AGENTS.md and in the table above

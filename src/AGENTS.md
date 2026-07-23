# Agents Guide — `src/`

## Overview

This directory contains all TypeScript source modules. Every file is a standalone Bun script or shared import. 45 source files across 7 subdirectories.

## Key Conventions

- **No build step** — all files run directly via `bun run src/<file>.ts`.
- **Types**: All shared interfaces live in `types.ts`. Import from there.
- **Constants**: `constants.ts` holds `BASE_URL`, `MUNICIPALITY_CODE`, `OUTPUT_DIR`, `ARTICLES_DIR`, `RATE_LIMIT_MS`, and all tunable constants (env-overridable).
- **Paths**: Use `shared/paths.ts` for all file I/O paths (never hardcode paths).
- **Data loading**: Use `shared/data.ts` for loading TOC, manifest, articles, and sections.
- **Pure utilities**: `utils.ts` exports `computeSha256`, `flattenToc`, `shuffle`, `htmlToText`, `csvEscape`, `sanitizeFilename`.
- **Logger**: Always use `createLogger(module)` from `logger.ts`. Use `log.warn()` — no `log.warning()`.

## Module Overview

| Module | Integration? | Tests |
|---|---|---|
| `browser.ts` | Yes (Playwright) | No (requires browser) |
| `constants.ts` | No | `tests/constants.test.ts`, `tests/constants-extended.test.ts` |
| `content.ts` | Yes (network) | `tests/content.test.ts` |
| `domains.ts` | No | `tests/domains.test.ts`, `tests/domains-extended.test.ts` |
| `export.ts` | Yes (filesystem) | `tests/export.test.ts` |
| `gov_meeting_monitor.ts` | Yes (network + filesystem) | `tests/gov_meeting_monitor.test.ts` |
| `logger.ts` | No | `tests/logger.test.ts` |
| `monitor.ts` | Yes (filesystem) | `tests/monitor.test.ts` |
| `news_monitor.ts` | Yes (network + filesystem) | `tests/news_monitor.test.ts` |
| `scrape.ts` | Yes (Playwright + network) | No (full integration) |
| `toc.ts` | Partial | `tests/toc.test.ts` (pure functions) |
| `types.ts` | No (types only) | N/A |
| `utils.ts` | No | `tests/utils.test.ts`, `tests/utils_normalization.test.ts` |
| `verify.ts` | Yes (filesystem + network) | `tests/verify.test.ts` |
| `structured_queries.ts` | Yes (filesystem) | `tests/structured_queries.test.ts` |
| `legal_parser.ts` | No (pure logic) | `tests/legal_parser.test.ts` |
| `alert_analytics.ts` | Yes (filesystem) | `tests/alert_analytics.test.ts` |
| `monthly_report.ts` | Yes (filesystem) | No (integration) |
| `alerts/*` | Yes (various APIs) | `tests/alerts.test.ts`, `tests/new_alerts.test.ts` |
| `api/middleware.ts` | No (pure logic) | `tests/middleware.test.ts`, `tests/middleware_sliding_window.test.ts` |
| `gui/*` | Partial | `tests/routes.test.ts`, `tests/routes.integration.test.ts`, `tests/search.test.ts`, `tests/search_enhancements.test.ts`, `tests/analytics.test.ts` |
| `llm/*` | Yes (Ollama/ChromaDB) | `tests/llm-config.test.ts`, `tests/embeddings.test.ts` |
| `shared/*` | Yes (filesystem) | `tests/shared-paths.test.ts`, `tests/shared-data.test.ts`, `tests/fuzzy.test.ts`, `tests/readability-gunning-fog.test.ts` |

## Testing Strategy

Unit tests cover all **pure-logic** functions. Integration modules (browser, content, scrape, verify, export, alert monitors) require external services and are tested manually via `bun run`.

Run the full test suite: `bun test` (or `bun test tests/`). 404 tests across 38 files.

## v2.0+ New Modules

| Module | Purpose | Key Exports |
|---|---|---|
| `structured_queries.ts` | Legislative history, section diff, semantic similarity, cross-ref validation | `parseLegislativeHistory()`, `compareSections()`, `findSimilarSections()`, `validateAllCrossReferences()` |
| `legal_parser.ts` | Citation extraction, definition glossary, ordinance parsing | `extractCitations()`, `extractDefinitions()`, `buildGlossary()`, `extractEffectiveDate()` |
| `alert_analytics.ts` | Unified alert timeline + per-type statistics | `buildAlertAnalytics()`, `getRecentAlerts()`, `getAlertsByType()` |
| `alerts/epa_airnow.ts` | EPA AirNow AQI monitoring | `classifyAqi()`, `getAdvisory()`, `runAirQualityMonitor()` |
| `alerts/calfire_wildfire.ts` | CAL FIRE wildfire incident monitoring | `classifyWildfireSeverity()`, `runWildfireMonitor()` |
| `alerts/ndbc_marine.ts` | NDBC buoy marine weather monitoring | `classifyMarineSeverity()`, `runMarineMonitor()` |
| `alerts/severity.ts` | 8-monitor composite severity | `computeAlertSeverity()` (expanded from 5 to 8 monitors) |
| `shared/fuzzy.ts` | Levenshtein fuzzy matching + typo correction | `levenshtein()`, `similarity()`, `fuzzyCorrect()`, `expandQueryFuzzy()` |
| `llm/streaming_rag.ts` | SSE streaming RAG | `createStreamingRagResponse()` |

# Agents Guide — `src/`

## Overview

This directory contains all TypeScript source modules. Every file is a standalone Bun script or shared import. The current module/file inventory is the source tree itself; use `rg --files src` rather than maintaining a hard-coded count.

## Key Conventions

- **No build step** — all files run directly via `bun run src/<file>.ts`.
- **Types**: All shared interfaces live in `types.ts`. Import from there.
- **Constants**: `constants.ts` holds `BASE_URL`, `MUNICIPALITY_CODE`, `OUTPUT_DIR`, `ARTICLES_DIR`, `RATE_LIMIT_MS`, and all tunable constants (env-overridable).
- **Paths**: Use `shared/paths.ts` for all file I/O paths (never hardcode paths).
- **Data loading**: Use `shared/data.ts` for loading TOC, manifest, articles, and sections.
- **Pure utilities**: `utils.ts` exports `computeSha256`, `flattenToc`, `shuffle`, `htmlToText`, `csvEscape`, `sanitizeFilename`.
- **Logger**: Always use `createLogger(module)` from `logger.ts`. Use `log.warn()` — no `log.warning()`.
- **Source registry**: Add or modify external sources only in `source_registry.ts`; use canonical normalized URLs, discovery citations, explicit automation state, and provenance. A discovery-only source must remain visibly `not-checked` until a connector emits source health.

## Module Overview

| Module | Integration? | Tests |
|---|---|---|
| `browser.ts` | Yes (Playwright) | No (requires browser) |
| `constants.ts` | No | `tests/constants.test.ts`, `tests/constants-extended.test.ts` |
| `content.ts` | Yes (network) | `tests/content-fixture.test.ts` |
| `directory.ts` | No (seed-validated, offline) | `tests/directory.test.ts` |
| `domains.ts` | No | `tests/domains.test.ts`, `tests/domains-extended.test.ts` |
| `export.ts` | Yes (filesystem) | `tests/export.test.ts` |
| `pages_snapshot.ts` | Yes (filesystem; static public export) | `tests/pages_snapshot.test.ts` |
| `gov_meeting_monitor.ts` | Yes (network + filesystem) | `tests/gov_meeting_monitor.test.ts` |
| `logger.ts` | No | `tests/logger.test.ts` |
| `monitor.ts` | Yes (filesystem) | `tests/monitor.test.ts` |
| `news_monitor.ts` | Yes (network + filesystem) | `tests/news_monitor.test.ts` |
| `youtube_monitor.ts` | Yes (yt-dlp + filesystem) | `tests/youtube_monitor.test.ts` |
| `triplicate_monitor.ts` | Yes (Playwright + filesystem; reference-only) | `tests/triplicate_monitor.test.ts` |
| `curation.ts` | Yes (filesystem + configured chat provider) | `tests/curation.test.ts` |
| `scrape.ts` | Yes (Playwright + network) | No (full integration) |
| `scraper_utils.ts` | No (pure validation/retry utilities) | `tests/scraper_utils.test.ts` |
| `toc.ts` | Partial | `tests/toc.test.ts` (pure functions) |
| `types.ts` | No (types only) | N/A |
| `utils.ts` | No | `tests/utils.test.ts`, `tests/utils_normalization.test.ts` |
| `verify.ts` | Yes (filesystem + network) | `tests/verify.test.ts` |
| `structured_queries.ts` | Yes (filesystem) | `tests/structured_queries.test.ts` |
| `legal_parser.ts` | No (pure logic) | `tests/legal_parser.test.ts` |
| `alert_analytics.ts` | Yes (filesystem) | `tests/alert_analytics.test.ts` |
| `analytics_backend.ts` | Yes (filesystem; shared GUI/Pages evidence envelope) | `tests/analytics-backend.test.ts` |
| `manuscript_variables.ts` | No (pure analytics-to-publication adapter) | `tests/manuscript.test.ts` |
| `geo.ts` | No (pure municipality geo-intel contract builders) | `tests/geo-intel.test.ts` |
| `geo_view.ts` | No (pure map-ready feature-view builder) | `tests/geo-view.test.ts` |
| `monthly_report.ts` | Yes (filesystem) | No (integration) |
| `shared/orchestration.ts` | Yes (filesystem; run metadata) | `tests/orchestration.test.ts` |
| `source_registry.ts` | Yes (filesystem; optional bounded probes) | `tests/source-registry.test.ts` |
| `alerts/*` | Yes (various APIs) | `tests/alerts.test.ts`, `tests/new_alerts.test.ts` |
| `api/middleware.ts` | No (pure logic) | `tests/middleware.test.ts`, `tests/middleware_sliding_window.test.ts` |
| `gui/*` | Partial | `tests/routes.test.ts`, `tests/routes.integration.test.ts`, `tests/search.test.ts`, `tests/search_enhancements.test.ts`, `tests/analytics.test.ts` |
| `llm/*` | Yes (Ollama/OpenRouter/ChromaDB) | `tests/llm-config.test.ts`, `tests/llm-openrouter.test.ts`, `tests/embeddings.test.ts` |
| `shared/*` | Yes (filesystem) | `tests/shared-paths.test.ts`, `tests/shared-data.test.ts`, `tests/fuzzy.test.ts`, `tests/readability-gunning-fog.test.ts`, `tests/idempotency.test.ts` |

## Testing Strategy

Unit tests cover all **pure-logic** functions. Integration modules (browser, content, scrape, verify, export, alert monitors) require external services and are tested manually via `bun run`.

Run the full test suite with `bun test tests/`; use `bun run validate` for the
authoritative strict TypeScript, test, contract, and generated-output gate.

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
| `alerts/composite.ts` | Pure composite-input shaping + source-health classification (thin-script enabler for `scripts/run-alerts.ts`) | `buildCompositeInput()`, `classifySourceHealth()`, `isFreshReport()` |
| `shared/fuzzy.ts` | Levenshtein fuzzy matching + typo correction | `levenshtein()`, `similarity()`, `fuzzyCorrect()`, `expandQueryFuzzy()` |
| `llm/streaming_rag.ts` | SSE streaming RAG | `createStreamingRagResponse()` |
| `llm/provider.ts` | Selected-provider routing and bounded preflight | `chatWithProvider()`, `checkChatProvider()` |
| `shared/source_health.ts` | Typed source-health records and atomic artifact writes | `sourceHealth()`, `writeJsonAtomic()` |
| `shared/orchestration.ts` | Durable step/run envelopes and runtime metadata | `executePipelineStep()`, `buildPipelineRun()` |
| `shared/idempotency.ts` | Shared (id, contentHash)-keyed persisted dedup store used by news/meetings/curation (replaces bespoke per-source shapes) | `IdempotencyStore`, `hashContent` |
| `alerts/notify.ts` | Config-driven high-severity composite webhook notifier | `maybeSendSeverityWebhook()`, `webhookUrl()`, `sendWebhook()` |
| `gui/semantic_search.ts` | Ollama-embed + ChromaDB semantic search with BM25 fallback | `semanticSearch()` |
| `llm/openrouter.ts` | OpenRouter chat provider wrapper | `chat()`, `streamChat()`, `checkOpenRouterHealth()` |
| `domains/coverage.ts` | Domain coverage % with prefix matching | `computeDomainCoverage()` |
| `geo.ts` | Transferable municipality geo-intel contract (Crescent default civic + hazard) | `buildGeoIntel()`, `buildMunicipalityContract()`, `hazardRelevantDomains()`, `CRESCENT_CITY_ANCHOR` |
| `geo_view.ts` | Tiles-free map-ready Crescent City feature view (Del Norte bounds polygon + anchor + hazard-domain points + section refs) from the geo-intel contract | `buildGeoView()` |

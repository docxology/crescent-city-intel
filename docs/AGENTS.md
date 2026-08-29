# Agents Guide — `docs/`

## Overview

Comprehensive project documentation covering architecture, all src/ modules, API reference, and configuration.

## Structure

| File | Content |
| :--- | :--- |
| `README.md` | Documentation index with links to all sections |
| `architecture.md` | System architecture, data flow diagram, module dependency graph |
| `api-reference.md` | Complete table of all exported functions, interfaces, and constants |
| `configuration.md` | All environment variables, constants, and tuning parameters |
| `modules/` | Per-module detailed documentation (one file per logical component) |

## Module Docs (`docs/modules/`)

| File | Covers |
| :--- | :--- |
| `scraping.md` | `browser.ts`, `toc.ts`, `content.ts`, `scrape.ts`, `scraper_utils.ts` |
| `verification.md` | `verify.ts` |
| `export.md` | `export.ts` |
| `pages.md` | `pages_snapshot.ts`, `scripts/export-pages.ts`, `scripts/validate-pages.ts` |
| `gui.md` | `gui/server.ts`, `gui/routes.ts`, `gui/search.ts`, `gui/semantic_search.ts`, `gui/alert_trends.ts`, `gui/analytics.ts`, `gui/static/` |
| `llm.md` | `llm/config.ts`, `llm/provider.ts`, `llm/ollama.ts`, `llm/openrouter.ts`, `llm/chroma.ts`, `llm/embeddings.ts`, `llm/rag.ts`, `llm/streaming_rag.ts`, `llm/index.ts` |
| `shared.md` | `shared/paths.ts`, `shared/source_health.ts`, `shared/data.ts`, `shared/idempotency.ts`, `shared/porter_stem.ts`, `shared/readability.ts`, `shared/fuzzy.ts` |
| `logger.md` | `logger.ts` |
| `domains.md` | `domains.ts` (12 domains) |
| `monitoring.md` | `monitor.ts`, `news_monitor.ts`, `gov_meeting_monitor.ts`, `youtube_monitor.ts`, `triplicate_monitor.ts`, `curation.ts`, `monthly_report.ts` |
| `alerts.md` | All 8 `alerts/` monitors + `alerts/severity.ts`, `alerts/composite.ts`, `alerts/notify.ts`, `alert_analytics.ts` |
| `geo-intel.md` | `geo.ts`, `geo_view.ts` |
| `v2-intelligence.md` | `structured_queries.ts`, `legal_parser.ts`, `alert_analytics.ts`, `analytics_backend.ts` |
| `api.md` | `api/middleware.ts` |

## Updating Docs

When modifying source code:

1. Update `docs/modules/<module>.md` for the affected component.
2. Update `docs/api-reference.md` if adding new exports.
3. Update `docs/configuration.md` if adding new env vars or constants.
4. Update `docs/architecture.md` if module relationships change.

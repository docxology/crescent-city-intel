# Agents Guide — `docs/modules/`

## Overview

Per-module documentation. Each file covers one logical component of the system.

## Files

| File | Source modules |
| :--- | :--- |
| `scraping.md` | `browser.ts`, `toc.ts`, `content.ts`, `scrape.ts`, `scraper_utils.ts` |
| `verification.md` | `verify.ts` |
| `export.md` | `export.ts` |
| `pages.md` | `pages_snapshot.ts`, `pages_css.ts`, `pages_scan.ts`, `pages_validation.ts`, `pages_seed.ts`, `scripts/export-pages.ts`, `scripts/validate-pages.ts` |
| `gui.md` | `gui/server.ts`, `gui/routes.ts`, `gui/docs_dashboard.ts`, `gui/annotations.ts`, `gui/search.ts`, `gui/semantic_search.ts`, `gui/analytics.ts`, `gui/browser_smoke.ts`, `gui/static/index.html` |
| `llm.md` | `llm/config.ts`, `llm/provider.ts`, `llm/ollama.ts`, `llm/openrouter.ts`, `llm/chroma.ts`, `llm/embeddings.ts`, `llm/index_plan.ts`, `llm/rag.ts`, `llm/streaming_rag.ts`, `llm/index.ts` |
| `shared.md` | `shared/paths.ts`, `shared/source_health.ts`, `shared/data.ts`, `shared/idempotency.ts`, `shared/orchestration.ts`, `shared/output_fence.ts`, `shared/porter_stem.ts`, `shared/readability.ts`, `shared/fuzzy.ts` |
| `logger.md` | `logger.ts` |
| `domains.md` | `domains.ts` (12 domains) |
| `monitoring.md` | `monitor.ts`, `news_monitor.ts`, `gov_meeting_monitor.ts`, `youtube_monitor.ts`, `triplicate_monitor.ts`, `curation.ts`, `monthly_report.ts`, `insights.ts` |
| `alerts.md` | All 20 monitors in `alerts/` (`noaa_tsunami`, `usgs_earthquake`, `nws_weather`, `noaa_tides`, `cdfw_fishing`, `epa_airnow`, `calfire_wildfire`, `ndbc_marine`, `nws_marine`, `usdm_drought`, `pge_psps`, `hrrr_smoke`, `caltrans_roads`, `dusd_schools`, `uscg_broadcasts`, `permits`, `dredging`, `fuel`, `pacfin`, `ais`) plus `alerts/severity.ts`, `alerts/composite.ts`, `alerts/healer.ts`, `alerts/notify.ts`, `alert_analytics.ts`, `alert_correlation.ts` |
| `expansion-monitors.md` | `alerts/permits.ts`, `alerts/dredging.ts`, `alerts/fuel.ts`, `alerts/pacfin.ts`, `alerts/ais.ts` (monitors #16–#20, shipped 2026-09-28) |
| `v2-intelligence.md` | `structured_queries.ts`, `legal_parser.ts`, `alert_analytics.ts`, `analytics_backend.ts`, `manuscript_variables.ts` |
| `geo-intel.md` | `geo.ts`, `geo_view.ts`, `domains/scholarly_context.ts` |
| `geo-observations.md` | `geo_observations.ts`, `scripts/run-geo-observations.ts`, `scripts/check-geo-sync.ts` |
| `api.md` | `api/middleware.ts`, `notifications/push.ts` |
| `readability.md` | `readability_history.ts` (scorer `shared/readability.ts` documented in `shared.md`), `lifeos_bridge.ts` |

## Convention

Each module doc includes: purpose, exported functions with signatures, key patterns, data flow, and dependencies.

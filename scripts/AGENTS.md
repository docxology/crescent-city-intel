# Agents Guide — `scripts/`

## Overview

**All files in `scripts/` are thin TypeScript orchestrators.** They contain no
business logic — they import from `src/` and call the appropriate functions.
Every script is runnable directly via `bun run <script-name>`.

## Convention

- **No inline logic** — all computation lives in `src/`.
- **Single responsibility** — one script per functional area.
- **CI-friendly exit codes** — non-zero on failure or detected changes.
- **Real imports, not shell glue** — TypeScript `import` instead of `bun run` subprocess calls.

## Scripts

| Script | npm alias | What it orchestrates (delegates to) |
| :--- | :--- | :--- |
| `weekly-check.ts` | `bun run weekly-check` | Full weekly health check: monitor + all 14 alerts (8 core + 6 extended) + news + meetings + analytics (`src/monitor.ts`, `scripts/run-alerts.ts`, `src/events.ts`, `src/curation.ts`, `src/monthly_report.ts`, `src/analytics_backend.ts`, `src/source_registry.ts`) |
| `run-monitor.ts` | `bun run monitor` | Municipal code change detection (`src/monitor.ts`) |
| `run-alerts.ts` | `bun run alerts` / `bun run alerts:all` | All 14 alert monitors concurrently (8 core + 6 extended) + composite severity computation (`src/alerts/*`) |
| `run-news.ts` | `bun run news` | RSS news aggregation (`src/news_monitor.ts`) |
| `run-source-discovery.ts` | `bun run source-discovery [-- --check]` | Canonical source registry and optional bounded reachability probes (`src/source_registry.ts`) |
| `run-meetings.ts` | `bun run gov-meetings` | Government meeting scraper (`src/gov_meeting_monitor.ts`) |
| `run-insights.ts` | `bun run insights` | Cross-artifact civic trend brief (`src/insights.ts`) |
| `run-coverage.ts` | `bun run coverage` | Domain coverage analysis (`src/domains/coverage.ts`) |
| `run-readability.ts` | `bun run readability` | Flesch-Kincaid + Gunning Fog scoring (`src/shared/readability.ts`) |
| `run-analytics.ts` | `bun run analytics` | Durable cross-surface analytics overview with optional LLM executive summary (`src/analytics_backend.ts`) |
| `run-youtube.ts` | `bun run youtube` | YouTube listing + auto-caption transcript pipeline with retryable source health (`src/youtube_monitor.ts`) |
| `run-curation.ts` | `bun run curate` | Provider-aware grounded curation with provenance and idempotency (`src/curation.ts`) |
| `export-pages.ts` | `bun run pages:export` | Build the bounded `.pages` public snapshot (`src/pages_snapshot.ts`) |
| `refresh-pages-data.ts` | `bun run pages:seed` | Refresh the verified tracked municipal-code seed (`src/pages_seed.ts`) |
| `validate-pages.ts` | `bun run pages:validate` | Validate the generated Pages artifact (`src/pages_validation.ts`) |
| `validate.ts` | `bun run validate` | Authoritative deterministic release gate (`src/release_gate.ts`) |
| `repair-output.ts` | `bun run repair-output` | Historical output repair/quarantine utility (`src/shared/orchestration.ts`) |
| `browser-smoke.ts` | `bun run test:browser` | Real Playwright/Chromium smoke test of the running GUI (render + API-key trust boundary + api auth + semantic-search fallback) (`src/browser_smoke.ts`) |
| `lifeos-bridge.ts` | `bun run lifeos:bridge` | Writes the LifeOS/Pulse LocalIntelligence digest (North Coast: Del Norte + Humboldt) from this platform's outputs (`src/lifeos_bridge.ts`) |
| `lifeos-daily.sh` | `bun run lifeos:daily` | Refresh news/meetings/alerts then write the LifeOS digest; non-zero exit if any step fails (cron-driven) |
| `validate-manuscript.ts` | `bun run manuscript:check` | Validate the source-controlled IMRAD manuscript and claim ledger (`src/manuscript_variables.ts`) |
| `hydrate-manuscript.ts` | `bun run manuscript:hydrate` | Hydrate manuscript tokens from the canonical analytics envelope (`src/manuscript_variables.ts`) |
| `z_generate_manuscript_variables.py` | template renderer hook | Thin Python adapter that delegates to the Bun hydrator |
| `cron-setup.sh` | `bun run cron-setup` | macOS Launchd / Linux cron installer |

## v2.0 Changes

- `run-alerts.ts` now runs all 14 monitors (8 core + 6 extended, including the NWS marine forecast) and computes composite 14-monitor severity, persisting to `output/alerts/composite/current.json`
- `weekly-check.ts` now runs all 14 alert monitors + alert analytics in its weekly cycle

## Adding New Scripts

1. Create `scripts/<name>.ts`
2. Import the relevant function(s) from `src/`
3. Call with minimal argument processing (flags only, no business logic)
4. Add an npm alias in `package.json`
5. Document here and in the root `README.md`

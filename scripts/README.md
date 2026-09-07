# Scripts

Thin TypeScript orchestrators for the Crescent City pipeline. Every script does
arg parsing, path bootstrap, logging, and a single delegated call; all business
logic lives in `src/` (importable and tested).

## Quick Reference

| Script | Purpose | Delegates to | Command |
| :--- | :--- | :--- | :--- |
| `weekly-check.ts` | Full weekly health check (all monitors) | `src/monitor.ts`, `scripts/run-alerts.ts`, `src/events.ts`, `src/news_monitor.ts`, `src/gov_meeting_monitor.ts`, `src/youtube_monitor.ts`, `src/triplicate_monitor.ts`, `src/curation.ts`, `src/source_registry.ts`, `src/monthly_report.ts`, `src/analytics_backend.ts`, `src/shared/orchestration.ts` | `bun run weekly-check` |
| `run-monitor.ts` | Municipal code change detection | `src/monitor.ts` | `bun run monitor` |
| `run-alerts.ts` | All 14 alert monitors (8 core + 6 extended) plus availability-aware composite | `src/alerts/*` | `bun run alerts` / `bun run alerts:all` |
| `run-news.ts` | RSS/Atom local news aggregation with source health | `src/news_monitor.ts` | `bun run news` |
| `run-meetings.ts` | City meeting agenda scraper | `src/gov_meeting_monitor.ts` | `bun run gov-meetings` |
| `run-youtube.ts` | YouTube transcript extraction/indexing with retryable failures | `src/youtube_monitor.ts` | `bun run youtube` |
| `run-curation.ts` | Provider-aware grounded curation with provenance | `src/curation.ts` | `bun run curate` |
| `run-analytics.ts` | Durable cross-surface metrics and optional LLM executive summary | `src/analytics_backend.ts` | `bun run analytics` |
| `run-insights.ts` | Cross-artifact civic trend brief → `output/state/civic-insights.json` | `src/insights.ts` | `bun run insights` |
| `run-coverage.ts` | Domain coverage % across the current manifest | `src/domains/coverage.ts` | `bun run coverage` |
| `run-readability.ts` | Flesch-Kincaid + Gunning Fog scoring | `src/shared/readability.ts`, `src/shared/data.ts` | `bun run readability` |
| `run-source-discovery.ts` | Canonical source inventory, fingerprint, and optional bounded probes | `src/source_registry.ts` | `bun run source-discovery [-- --check]` |
| `validate-manuscript.ts` | IMRAD, citations, labels, claim ledger, and token contract | `src/manuscript_variables.ts` | `bun run manuscript:check` |
| `hydrate-manuscript.ts` | Resolve source manuscript tokens from the analytics overview | `src/manuscript_variables.ts`, `src/analytics_backend.ts` | `bun run manuscript:hydrate` |
| `z_generate_manuscript_variables.py` | Template renderer hook | `scripts/hydrate-manuscript.ts` (via Bun) | (template renderer) |
| `export-pages.ts` | Build a bounded static GitHub Pages snapshot | `src/pages_snapshot.ts` | `bun run pages:export` |
| `refresh-pages-data.ts` | Refresh the tracked verified municipal-code seed | `src/pages_seed.ts` | `bun run pages:seed` |
| `validate-pages.ts` | Validate the static snapshot and publication boundaries | `src/pages_validation.ts` | `bun run pages:validate` |
| `validate.ts` | Strict TypeScript, deterministic tests, and output checks | `src/release_gate.ts` | `bun run validate` |
| `repair-output.ts` | Quarantine malformed history and migrate legacy runtime envelopes | `src/shared/orchestration.ts`, `src/shared/source_health.ts` | `bun run repair-output` |
| `browser-smoke.ts` | Playwright/Chromium smoke test of the running GUI | `src/browser_smoke.ts` | `bun run test:browser` |
| `lifeos-bridge.ts` | Write the LifeOS/Pulse LocalIntelligence digest from platform outputs | `src/lifeos_bridge.ts` | `bun run lifeos:bridge` |
| `lifeos-daily.sh` | Refresh news/meetings/alerts then write the LifeOS digest; non-zero exit if any step fails | `scripts/run-news.ts`, `scripts/run-meetings.ts`, `scripts/run-alerts.ts`, `scripts/lifeos-bridge.ts` | `bun run lifeos:daily` |
| `cron-setup.sh` | macOS Launchd / Linux cron installer | — (shell installer) | `bun run cron-setup` |

## Data Flow

```text
scripts/weekly-check.ts
    ├── src/monitor.ts           → output/monitor-report.json
    ├── src/alerts/*             → output/alerts/<type>/ + composite/
    ├── src/alerts/usgs_earthquake.ts → output/alerts/earthquake/
    ├── src/alerts/nws_weather.ts → output/alerts/weather/
    ├── src/news_monitor.ts      → output/news/ + source-health.json
    ├── src/gov_meeting_monitor.ts → output/gov_meetings/ + source-health.json
    ├── src/youtube_monitor.ts   → output/youtube/ + source-health.json
    ├── src/triplicate_monitor.ts → output/triplicate/ + source-health.json (reference-only)
    ├── src/curation.ts          → output/curated/ + output/state/
    ├── src/source_registry.ts   → output/source-registry.json + source-discovery.json
    ├── src/monthly_report.ts    → output/reports/monthly-YYYY-MM.md + .json
    ├── src/analytics_backend.ts → output/state/analytics-overview.json
    ├── scripts/hydrate-manuscript.ts → output/manuscript/ + output/data/manuscript_variables.json
    └── shared orchestration     → output/state/latest-pipeline-run.json
```

The Pages workflow (`.github/workflows/pages.yml`) runs the release gate,
collects live sources, preserves unavailable/stale health states, builds the
static export, validates it, and deploys the artifact. It does not publish the
runtime `output/` directory wholesale.

## Cron Setup

```bash
# Weekly check every Sunday at 2 AM (append to existing log)
0 2 * * 0 cd /path/to/crescent-city && bun run weekly-check >> output/weekly-check.log 2>&1

# Hourly alert polling
0 * * * * cd /path/to/crescent-city && bun run alerts >> output/alerts.log 2>&1
```

## Exit Codes

| Code | Meaning |
| :--- | :--- |
| `0` | Monitoring completed; source coverage is reported in the run envelope |
| `1` | Code changes or another explicit review condition |
| `2` | Error (missing data, network failure) |

## Durable run metadata

Every scheduled run is observable after the process exits:

- `output/weekly-check-summary.json` — compact operator summary.
- `output/state/latest-pipeline-run.json` — versioned stage-by-stage run
  envelope with duration, commit, runtime, exit status, output paths, and
  source-health counts.
- `output/state/curation-report.json` — selected provider/model, attempted and
  successful item counts, retryable failures, and output path.
- `output/state/analytics-overview.json` — canonical local/Pages reading order,
  deterministic metrics, warning signals, source fingerprint, and optional
  provider-labeled executive summary.
- `output/reports/monthly-YYYY-MM.json` — machine-readable report metadata
  paired with the Markdown report.
- `output/source-registry.json` — normalized source definitions and registry
  fingerprint input.
- `output/source-discovery.json` — coverage counts, explicit gaps, and the
  latest known operational state for every registry entry.
- `output/state/source-discovery-seen.json` — persistent registry fingerprint
  observation used for idempotent change detection.

These artifacts contain operational metadata only. They do not contain API
keys, chat history, prompts, request logs, or Triplicate article content.

If validation finds a pre-1.0.0 weekly summary, run `bun run repair-output`.
The original JSON is copied to `output/state/quarantine/` before the upgraded
envelope is written.

## Adding Scripts

See [AGENTS.md](AGENTS.md) for conventions.

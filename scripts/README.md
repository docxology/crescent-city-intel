# Scripts

Thin TypeScript orchestrators for the Crescent City pipeline. All business logic lives in `src/`.

## Quick Reference

| Script | Command | Description |
| :--- | :--- | :--- |
| `weekly-check.ts` | `bun run weekly-check` | Full weekly health check (all monitors) |
| `run-monitor.ts` | `bun run monitor` | Municipal code change detection |
| `run-alerts.ts` | `bun run alerts` | All 8 alert monitors plus availability-aware composite |
| `run-news.ts` | `bun run news` | RSS/Atom local news aggregation with source health |
| `run-meetings.ts` | `bun run gov-meetings` | City meeting agenda scraper |
| `run-youtube.ts` | `bun run youtube` | YouTube transcript extraction/indexing with retryable failures |
| `run-curation.ts` | `bun run curate` | Provider-aware grounded curation with provenance |
| `run-source-discovery.ts` | `bun run source-discovery [-- --check]` | Canonical source inventory, fingerprint, and optional bounded probes |
| `export-pages.ts` | `bun run pages:export` | Build a bounded static GitHub Pages snapshot |
| `refresh-pages-data.ts` | `bun run pages:seed` | Refresh the tracked verified municipal-code seed |
| `validate-pages.ts` | `bun run pages:validate` | Validate the static snapshot and publication boundaries |
| `validate.ts` | `bun run validate` | Strict TypeScript, deterministic tests, and output checks |
| `repair-output.ts` | `bun run repair-output` | Quarantine malformed history and migrate legacy runtime envelopes |

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
| `0` | All monitored sources healthy and no code changes |
| `1` | Code changes or one or more feeds are unavailable/stale |
| `2` | Error (missing data, network failure) |

## Durable run metadata

Every scheduled run is observable after the process exits:

- `output/weekly-check-summary.json` — compact operator summary.
- `output/state/latest-pipeline-run.json` — versioned stage-by-stage run
  envelope with duration, commit, runtime, exit status, output paths, and
  source-health counts.
- `output/state/curation-report.json` — selected provider/model, attempted and
  successful item counts, retryable failures, and output path.
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

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
| `export-pages.ts` | `bun run pages:export` | Build a bounded static GitHub Pages snapshot |
| `validate-pages.ts` | `bun run pages:validate` | Validate the static snapshot and publication boundaries |
| `validate.ts` | `bun run validate` | Strict TypeScript, deterministic tests, and output checks |

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
    └── src/monthly_report.ts    → output/reports/monthly-YYYY-MM.md
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

## Adding Scripts

See [AGENTS.md](AGENTS.md) for conventions.

# Scripts

Bun/TypeScript entry points for the Crescent City pipeline delegate project
logic to importable modules in `src/`. Shell wrappers handle setup and scheduling;
the thin Python manuscript adapter delegates to the Bun hydrator for the external
template renderer.

## Quick Reference

| Script | Purpose | Delegates to | Command |
| :--- | :--- | :--- | :--- |
| `generate-docs.ts` | Generate/check configuration, exports and structural HTTP inventories | `src/doc_inventory.ts` | `bun run scripts/generate-docs.ts --write` / `--check` |
| `source-coverage.ts` | Read-only retained catalog/geography/access and primary evidence limits | `src/source_coverage.ts` | `bun run scripts/source-coverage.ts` |
| `weekly-check.ts` | Full weekly health check (all monitors) | `src/weekly_pipeline.ts` | `bun run weekly-check` |
| `run-monitor.ts` | Municipal code change detection | `src/monitor.ts` | `bun run monitor` |
| `run-alerts.ts` | All 20 alert monitors (8 core + 12 extended) plus availability-aware composite | `src/alerts/batch.ts` | `bun run alerts` / `bun run alerts:all` |
| `run-news.ts` | RSS/Atom local news aggregation with source health | `src/news_monitor.ts` | `bun run news` |
| `run-meetings.ts` | City meeting agenda scraper | `src/gov_meeting_monitor.ts` | `bun run gov-meetings` |
| `run-youtube.ts` | YouTube transcript extraction/indexing with retryable failures | `src/youtube_monitor.ts` | `bun run youtube` |
| `run-curation.ts` | Provider-aware grounded curation with provenance | `src/curation.ts` | `bun run curate` |
| `run-analytics.ts` | Durable cross-surface metrics and optional LLM executive summary | `src/analytics_backend.ts` | `bun run analytics` |
| `run-insights.ts` | Cross-artifact civic trend brief → `output/state/civic-insights.json` | `src/insights.ts` | `bun run insights` |
| `run-coverage.ts` | Domain coverage % across the current manifest | `src/domains/coverage.ts` | `bun run coverage` |
| `run-readability.ts` | Flesch-Kincaid + Gunning Fog scoring | `src/shared/readability.ts`, `src/shared/data.ts` | `bun run readability` |
| `run-source-discovery.ts` | Canonical source inventory, fingerprint, and optional bounded probes | `src/source_registry.ts` | `bun run source-discovery [-- --check]` |
| `run-geo-observations.ts` | GEO-INFER hazard-observation envelope (`crescent-city-geo-observations/v1`) from composite + source-health artifacts | `src/geo_observations.ts` | `bun run geo:observations` |
| `check-geo-sync.ts` | Deterministic geo-intel contract drift guard (rebuild + bundled sha256 compare) | `src/geo_sync.ts` | `bun run geo:sync-check` |
| `validate-manuscript.ts` | IMRAD, citations, labels, claim ledger, and token contract | `src/manuscript_document.ts` | `bun run manuscript:check` |
| `hydrate-manuscript.ts` | Resolve source manuscript tokens from the analytics overview | `src/manuscript_hydration.ts` | `bun run manuscript:hydrate` |
| `z_generate_manuscript_variables.py` | Template renderer hook | `scripts/hydrate-manuscript.ts` (via Bun) | (template renderer) |
| `export-pages.ts` | Build a bounded static GitHub Pages snapshot | `src/pages_snapshot.ts` | `bun run pages:export` |
| `refresh-pages-data.ts` | Refresh the tracked verified municipal-code seed | `src/pages_seed.ts` | `bun run pages:seed` |
| `validate-pages.ts` | Validate the static snapshot and publication boundaries | `src/pages_validation.ts` | `bun run pages:validate` |
| `validate.ts` | Strict TypeScript, deterministic tests, and output checks | `src/release_gate.ts` | `bun run validate` |
| `repair-output.ts` | Quarantine malformed history, migrate runtime envelopes, or restore a recorded repair | `src/output_migrations.ts` | `bun run repair-output` |
| `browser-smoke.ts` | Playwright/Chromium smoke test of the running GUI | `src/browser_smoke.ts` | `bun run test:browser` |
| `lifeos-bridge.ts` | Write the LifeOS/Pulse LocalIntelligence digest from platform outputs | `src/lifeos_bridge.ts` | `bun run lifeos:bridge` |
| `lifeos-daily.sh` | Refresh news/meetings/alerts then write the LifeOS digest; non-zero exit if any step fails | `scripts/run-news.ts`, `scripts/run-meetings.ts`, `scripts/run-alerts.ts`, `scripts/lifeos-bridge.ts` | `bun run lifeos:daily` |
| `cron-setup.sh` / `scheduler-plan.ts` | Review a scheduler plan, manage an explicit owned target, or rotate its idle log | `src/scheduler.ts` | `bun run cron-setup -- --dry-run` |
| `stack-readiness.ts` | Bounded real-service/model readiness receipt | `src/stack_readiness.ts` | `bun run scripts/stack-readiness.ts` |
| `ci-affected-tests.ts` | Conservative recursive dependency selection; uncertain changes run the full suite | `src/ci_support.ts` | CI internal |
| `ci-monitor-smoke.ts` | Validate the child exit and exact current-cycle roster; emit public health receipt | `src/ci_support.ts`, `src/pages_public.ts` | CI internal |

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

## Scheduling and run ownership

`bun run cron-setup -- --dry-run` prints a Sunday 07:00 Pacific launchd/cron
plan and installs nothing. The renderer uses escaped argument arrays and XML on
macOS, POSIX quoting and cron percent escaping on Linux. Confirm the macOS host
timezone and review project/log paths before installing the reviewed file:

```bash
bun run cron-setup -- --install --target=/absolute/reviewed-target --state=/absolute/scheduler-state
bun run cron-setup -- --remove --target=/absolute/reviewed-target --state=/absolute/scheduler-state
```

These commands write only the named file and ownership journal. Linux updates
preserve unrelated entries and restore their preceding `CRON_TZ`; macOS refuses
an existing unowned plist. Native installation additionally requires `--activate`,
and native removal requires `--deactivate`. Linux activation requires an exact
snapshot of the current host crontab in the target file. An uncertain activation
is retained for explicit review. Isolated file tests do not prove an installed
or running host scheduler.

`--rotate-log=/absolute/log --producer-lease=/absolute/output/state/weekly-check.lock
--max-bytes=5000000 --keep=3` rotates exact bytes only while the weekly writer is
idle. Archives and the current log use a recoverable transaction. Rotation refuses
oversized aggregate inputs; it does not interrupt a producer's open log stream.

`WEEKLY_DEADLINE_MS` sets the total weekly budget (100 ms through 24 hours; default
one hour). SIGTERM/SIGINT cancel inherited HTTP, browser and child work. The latest
attempt and per-step receipts remain separate from the last completed envelope;
restart retains the interrupted attempt and rolls back incomplete publications.
Each producer captures its output root and owns a per-producer lease. News,
meetings and Triplicate publish source batches, health and new seen identities
together; bounded health history follows that commit. Browser recovery uses
private root/token/process receipts and refuses substituted process identities.

## Verification

`bun run test:typecheck` checks tests under `tsconfig.tests.json`; production
`tsconfig.json` remains scoped to source and scripts. The full gate runs both
strict checks, manuscript/source contracts, and plain plus covered test runs.
Each child uses a total process-group deadline/output cap and checks both the
real checkout output and any selected `CC_OUTPUT_DIR` in `finally`. Coverage
reads the named `% Lines` column; absent branch coverage is not reported as a
measurement. Contract-only mode is `bun run validate -- --only=contracts` and
explicitly reports the skipped runtime/type/coverage work.

The Pages exporter stages and validates the entire tree before promotion. Its
core municipal bundle is selected as one edition; `--municipal-source` can
separate a verified municipal candidate from the live-feed `--source` directory.
Fresh candidates require current-source verification binding the exact TOC,
manifest, and canonical exported article text. Reviewed seed fallback is visible
and does not establish current live source acceptance. Family DTOs omit operator
fields, and full-tree hash/privacy checks bind the public publication receipt.

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


`bun run meeting-documents -- --limit=10 --deadline-ms=300000` collects bounded
public meeting-document links into `output/meeting_documents/` with raw PDF hashes,
HTTP/source receipts, and optional native `pdftotext` page spans. Limits are capped
at 50 documents and 15 minutes. Missing extraction tooling is explicit; no OCR,
legal interpretation, field verification, or comprehensive archive coverage is
implied. Raw/operator custody artifacts are not transferred wholesale to Pages.

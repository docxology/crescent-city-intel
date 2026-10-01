# Agents Guide — `scripts/`

## Overview

TypeScript entry points in `scripts/` delegate project logic to `src/` and run
through Bun. The directory also contains shell setup/scheduling wrappers and a
thin Python adapter for the external manuscript renderer.

## Convention

- **No inline logic** — all computation lives in `src/`.
- **Single responsibility** — one script per functional area.
- **CI-friendly exit codes** — non-zero on failure or detected changes.
- **Real imports, not shell glue** — TypeScript `import` instead of `bun run` subprocess calls.

## Scripts

| Script | npm alias | What it orchestrates (delegates to) |
| :--- | :--- | :--- |
| `generate-docs.ts` | `bun run scripts/generate-docs.ts --write` / `--check` | TypeScript AST configuration/exports and structural OpenAPI inventories (`src/doc_inventory.ts`) |
| `source-coverage.ts` | `bun run scripts/source-coverage.ts` | Read-only registry-grounded retained evidence; prints a bounded public assessment, writes nothing (`src/source_coverage.ts`) |
| `weekly-check.ts` | `bun run weekly-check` | Full weekly health check: monitor + all 20 alerts (8 core + 12 extended) + news + meetings + analytics (`src/weekly_pipeline.ts`) |
| `run-monitor.ts` | `bun run monitor` | Municipal code change detection (`src/monitor.ts`) |
| `run-alerts.ts` | `bun run alerts` / `bun run alerts:all` | All 20 alert monitors concurrently (8 core + 12 extended) + composite severity computation (`src/alerts/batch.ts`) |
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
| `validate.ts` | `bun run validate` / `bun run validate -- --only=contracts` | Authoritative deterministic release gate (`src/release_gate.ts`). `--only=contracts` is a MODE of the gate, not a second implementation: the checks before the early return run in both, and it prints what it skipped and says it is not a full pass. Used by the pull-request CI job |
| `ci-affected-tests.ts` | (CI-internal) | Choose and run the tests a change could plausibly affect, by the module each test imports. Falls back to the full suite whenever the answer is not bounded, including when it would select zero tests (`bun run scripts/ci-affected-tests.ts`; reads `$CHANGED` or stdin) |
| `ci-monitor-smoke.ts` | (CI-internal) | Run the alert batch and report each monitor's own verdict from `output/alerts/source-health.json`. Rejects a failed child, missing/duplicate roster entries, invalid status/counts, or old-cycle timestamps. Genuine source outages remain explicit coverage facts; uploads contain a public DTO |
| `run-geo-observations.ts` | `bun run geo:observations` | Build the live geo-observations companion envelope (`src/geo_observations.ts`) |
| `check-geo-sync.ts` | `bun run geo:sync-check` | Rebuild-compare drift guard over the tracked `pages-data/geo-intel.json` seed (enforced by `src/release_gate.ts`) |
| `repair-output.ts` | `bun run repair-output` | Recoverable historical output repair/quarantine and explicit receipt rollback (`src/output_migrations.ts`) |
| `browser-smoke.ts` | `bun run test:browser` | Real Playwright/Chromium smoke test of the running GUI (render + API-key trust boundary + api auth + semantic-search fallback) (`src/browser_smoke.ts`) |
| `lifeos-bridge.ts` | `bun run lifeos:bridge` | Writes the LifeOS/Pulse LocalIntelligence digest (North Coast: Del Norte + Humboldt) from this platform's outputs (`src/lifeos_bridge.ts`) |
| `lifeos-daily.sh` | `bun run lifeos:daily` | Refresh news/meetings/alerts then write the LifeOS digest; non-zero exit if any step fails (cron-driven) |
| `validate-manuscript.ts` | `bun run manuscript:check` | Validate the source-controlled IMRAD manuscript and claim ledger (`src/manuscript_variables.ts`) |
| `hydrate-manuscript.ts` | `bun run manuscript:hydrate` | Hydrate manuscript tokens from the canonical analytics envelope (`src/manuscript_variables.ts`) |
| `z_generate_manuscript_variables.py` | template renderer hook | Thin Python adapter that delegates to the Bun hydrator |
| `cron-setup.sh` / `scheduler-plan.ts` | `bun run cron-setup -- --dry-run` | Scheduler plan plus explicit owned target install/remove/log rotation (`src/scheduler.ts`) |

## Adding New Scripts

1. Create `scripts/<name>.ts`
2. Import the relevant function(s) from `src/`
3. Call with minimal argument processing (flags only, no business logic)
4. Add an npm alias in `package.json`
5. Document here and in the root `README.md`


Release checks live in `src/release_checks.ts`; conservative CI selection and
current-cycle completeness live in `src/ci_support.ts`. The manuscript source
validator and staged hydrator are `src/manuscript_document.ts` and
`src/manuscript_hydration.ts`. Pages edition custody and recoverable directory
promotion live in `src/publication_bundle.ts`; public DTOs live in
`src/pages_public.ts`. New script logic belongs in an importable source module.

`scheduler-plan.ts` and `cron-setup.sh` default to no action: choose `--dry-run`
or explicit `--install`/`--remove` with `--target=` and `--state=`. Native activation
requires `--activate`/`--deactivate`; it is separate from isolated file acceptance.
Rotation requires `--rotate-log=` and `--producer-lease=` and refuses a live writer.
`stack-readiness.ts` checks real HTTP responses and required
models with finite time/byte limits; a container build is a separate evidence
plane. Strict tests use `bun run test:typecheck` without widening production
`tsconfig.json`.


`bun run meeting-documents -- --limit=10 --deadline-ms=300000` collects bounded
public meeting-document links into `output/meeting_documents/` with raw PDF hashes,
HTTP/source receipts, and optional native `pdftotext` page spans. Limits are capped
at 50 documents and 15 minutes. Missing extraction tooling is explicit; no OCR,
legal interpretation, field verification, or comprehensive archive coverage is
implied. Raw/operator custody artifacts are not transferred wholesale to Pages.

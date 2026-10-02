# AGENTS.md — The Quadruplicate

## What this is

A Bun/TypeScript civic-intelligence platform for Crescent City, CA. It scrapes,
verifies, exports, and queries the municipal code from ecode360.com, monitors
20 real-time alert streams (8 core + 12 extended incl. USCG broadcasts), provides
RAG chat via Ollama/OpenRouter + Chroma, and publishes a bounded snapshot to
GitHub Pages at quadruplicate.org. See [README.md](README.md) for the full
feature map. The application and checks use Bun/TypeScript. A thin Python
adapter invokes Bun for the external manuscript renderer; it is not an
application runtime or test runner.

## Architecture

```
ecode360.com/CR4919
        |
    [Scraper] --- Playwright + Cloudflare bypass
        |
   output/articles/*.json (counts reported by output/manifest.json)
        |
   [Verifier] --- SHA-256 + TOC cross-reference + live re-fetch
        |
   [Exporter] --- JSON, Markdown, plain text, CSV
        |
   +----+----+----+----+
   |         |        |
 [GUI]    [LLM]   [Structured Queries]
 Bun.serve  Ollama   History/Compare/Similar
 port 3000  + Chroma  Citations/Glossary
 RAG+SSE    RAG       Cross-refs
        |
[Intelligence Layer — 20 monitors]
   8 core: NOAA Tsunami · USGS Earthquake · NWS Weather · NOAA Tides ·
   CDFW Fishing · EPA AirNow · CAL FIRE Wildfire · NDBC Marine
  7 base extended: USDM Drought · PG&E PSPS · HRRR Smoke · Caltrans Roads ·
  DUSD Closures · NWS Marine Forecast (CWF PZZ450) · USCG Broadcasts (BNM District 11)
  5 expansion: Permits (MyGov portal) · Harbor Dredging · EIA CA Fuel ·
  PacFIN Reports · AIS Vessel Traffic
        |
 [Alert Analytics — unified timeline + per-type stats]
```

## Directory map

```
src/                            # Municipal-code pipeline + intelligence layer
types.ts                        # All TypeScript interfaces
civic_profile.ts                # Validated jurisdiction configuration, fingerprints and output ownership
constants.ts                    # Centralized constants (env-overridable)
utils.ts                        # Shared utilities (SHA-256, flatten, chunk, etc.)
logger.ts                       # Structured logger
browser.ts                      # Playwright lifecycle + Cloudflare bypass
browser_launcher.ts             # Private launcher ownership and dead-controller browser recovery
toc.ts                          # TOC fetcher + tree utilities
content.ts                      # Page scraper + section extraction
scrape.ts                       # Scraper orchestrator with resume
verify.ts                       # Verification engine
export.ts                       # Multi-format exporter (JSON, MD, TXT, CSV)
domains.ts                      # 12 civic intelligence domains with code cross-refs
monitor.ts                      # Municipal code change detection
news_monitor.ts                 # RSS/Atom news aggregator
gov_meeting_monitor.ts          # City Council/Planning/Harbor meeting tracker
youtube_monitor.ts              # YouTube listing/transcript monitor
triplicate_monitor.ts           # Reference/citation-only Triplicate monitor
source_registry.ts              # Canonical source inventory + bounded discovery probes
curation.ts                     # Provider-aware, source-grounded curation
monthly_report.ts               # Monthly civic health report generator
structured_queries.ts           # Legislative history, section compare, similarity
legal_parser.ts                 # Citation extractor, glossary builder, ordinance parser
ordinance_chronology.ts         # Per-section amendment trails + ordinance lineage
section_graph.ts                # Section dependency graph (citation network)
section_longevity.ts            # Section age, dormancy, churn, decade histogram
word_frequency.ts               # Corpus term frequency + tf-idf salience
minutes_extraction.ts           # Meeting-minutes depth: vote tallies + hashing
agenda_crossref.ts              # Agenda items -> code sections via the BM25 index
calendar_recurrence.ts          # Bounded recurrence, cancellation, timezone and unsupported-rule evidence
source_clocks.ts                # Source-specific observation/product/retrieval validity policies
trend_sampling.ts               # Recorded sampling denominators and explicit trend comparability
derived_publication.ts          # Captured-input replay and recoverable derived output custody
insights.ts                     # Cross-artifact civic trend brief
directory.ts                    # Provenance-checked civic directory builder
directory_review.ts             # Local field evidence, role-owned corrections and changed-source review
artifact_contracts.ts           # Shared versioned family schemas and semantic/count invariants
artifact_custody.ts              # Bounded exact input/transform/output custody and deterministic replay
schema_validation.ts            # Shared noncoercing bounded JSON/OpenAPI schema engine
corpus_lineage.ts               # Retained source-bound edition comparison and primary-document review queue
source_coverage.ts              # Read-only registry-grounded catalog, geography and legal-evidence assessment
events.ts                       # Community event aggregation and normalization
event_discovery.ts              # Bounded discovery probes for new event sources
analytics_backend.ts            # Analytics overview envelope (deterministic + LLM provenance)
scraper_utils.ts                # Shared scraping helpers (bounded fetch, retry, parsing)
manuscript_variables.ts         # Manuscript evidence variables from real artifacts
alert_analytics.ts              # Unified alert timeline + per-type statistics
alert_correlation.ts            # Directional cross-monitor co-occurrence (lift, lag)
release_gate.ts                 # Deterministic release-gate checks (scripts/validate.ts)
geo.ts                          # Geo-intel contract builder (civic + hazard)
geo_view.ts                     # Tiles-free map-ready geo feature view
geo_observations.ts             # GEO-INFER hazard-observation envelope
readability_history.ts          # Bounded readability run history (JSONL, 10k cap)
lifeos_bridge.ts                # LifeOS/Pulse LocalIntelligence digest logic
browser_smoke.ts                # Real-browser GUI smoke flow (scripts/browser-smoke.ts)
pages_snapshot.ts               # Bounded public GitHub Pages snapshot exporter
pages_publication_inputs.ts     # Exact Pages producer/seed/source capture, private replay, public hash commitments
pages_scan.ts                   # Pages artifact scanner (links, assets, SEO)
pages_css.ts                    # Generated Pages stylesheet builder
pages_validation.ts             # Pages artifact validator (release-gate checks)
pages_bundle_validation.ts      # Owned, bounded evaluation of shipped Pages helper behavior
pages_seed.ts                   # Verified municipal-code seed refresh for Pages
ci_support.ts                   # Dependency closure and current-cycle monitor acceptance
corpus_editions.ts              # Source-bound extraction receipts and retained corpus lineage
doc_inventory.ts                # Source/HTTP inventories and checked full GitHub README projection
geo_sync.ts                     # Module contract and implementation
manuscript_document.ts          # Manuscript evidence hydration and validation
manuscript_hydration.ts         # Module contract and implementation
pages_public.ts                 # Public artifact projections and privacy boundary
publication_bundle.ts           # Coherent corpus selection, custody receipts and recoverable promotion
release_checks.ts               # Actual line coverage and failure-safe output fences
interactive_menu.ts             # Module contract and implementation
official_meetings.ts            # Bounded official archives and County CivicClerk published documents
scheduler.ts                    # Reviewed scheduler plans, owned file installation/removal and idle log rotation
stack_readiness.ts              # Module contract and implementation
weekly_pipeline.ts              # Module contract and implementation
meeting_documents.ts            # Bounded PDF capture, page spans and exact source/text receipts
readability_report.ts           # Root-scoped readability scoring and bounded history publication
output_migrations.ts            # Module contract and implementation
alerts/                         # 20 monitors + composite severity; docs/modules/alerts.md
  connector.ts                  # Bounded live-fetch layer for the expansion monitors:
                                #   timeout, streaming size cap, per-host rate limit,
                                #   robots.txt gate (deny-on-disallow and on 401/403)
  severity.ts                   # Composite alert severity over all 20 monitor inputs
  noaa_tsunami.ts               # NOAA CAP tsunami warning monitor
  noaa_tides.ts                 # NOAA CO-OPS tides (station 9419750)
  usgs_earthquake.ts            # USGS earthquake monitor (M4.0+, 200 km)
  nws_weather.ts                # NWS Del Norte coastal zone CAZ101 alerts
  cdfw_fishing.ts               # CDFW Dungeness crab season monitor
  epa_airnow.ts                 # EPA AirNow air quality (PM2.5, ozone, PM10)
  calfire_wildfire.ts           # CAL FIRE wildfire incident monitor
  ndbc_marine.ts                # NDBC buoy marine weather (wave, wind, temp)
  nws_marine.ts                 # NWS CWF coastal waters forecast (PZZ450)
  uscg_broadcasts.ts            # USCG District 11 broadcast notices to mariners
  usdm_drought.ts               # US Drought Monitor categorical area percentages for Del Norte
  pge_psps.ts                   # PG&E public safety power shutoff monitor
  hrrr_smoke.ts                 # NOAA HMS / HRRR smoke plume monitor
  caltrans_roads.ts             # Caltrans road closure and incident monitor
  dusd_schools.ts               # Del Norte USD school closure monitor
  permits.ts                    # City MyGov public permit-catalog monitor
  dredging.ts                   # Harbor District dredging/marine-construction monitor
  fuel.ts                       # EIA weekly California retail gasoline monitor
  pacfin.ts                     # PacFIN public report-catalog monitor
  ais.ts                        # Open-AIS vessel-traffic monitor (watch-box filter)
  composite.ts                  # Freshness-gated composite availability across monitors
  healer.ts                     # Per-monitor staleness detection and re-run roster
  notify.ts                     # ALERT_WEBHOOK_URL fire-and-forget severity webhook
  batch.ts                      # Module contract and implementation
api/                            # Runtime API contract, admission and middleware
  middleware.ts                 # Sliding-window rate limiter + API key auth
  admission.ts                  # Finite expensive-operation admission and streaming cancellation
  contracts.ts                  # Runtime method, authentication, input and response contracts from OpenAPI
domains/                        # Civic domain coverage and references
  coverage.ts                   # Domain coverage % with prefix matching
  scholarly_context.ts          # Scholarly/reference context per civic domain
notifications/                  # Notification delivery and receipts
  push.ts                       # Push notification delivery
shared/                         # Shared artifact, transport and storage contracts
  artifact_transaction.ts       # Recoverable bounded exact-byte multi-artifact replacement and rollback
  process_ownership.ts          # Owned child process-group shutdown and direct-child reaping receipts
  run_scope.ts                  # Captured producer roots, leases and parent cancellation budgets
  paths.ts                      # Centralized output path constants
  source_health.ts              # Typed source-health contract + atomic artifact writes
  orchestration.ts              # Durable step/run envelopes and build metadata
  data.ts                       # Data loading layer (60s TTL cache)
  porter_stem.ts                # Zero-dep Porter stemmer for BM25
  readability.ts                # Flesch-Kincaid + Gunning Fog scoring
  fuzzy.ts                      # Levenshtein fuzzy matching + typo correction
  idempotency.ts                # Durable idempotency store for repeated runs
  output_fence.ts               # Output-corpus snapshots and drift checks
  storage.ts                    # Cross-process writer leases and owned recovery
  transport.ts                  # Bounded DNS-pinned outbound transport and URL redaction
  subprocess.ts                 # Module contract and implementation
gui/                            # Local server, API and browser surfaces
  server.ts                     # Bun.serve() HTTP server (port 3000)
  routes.ts                     # API route handlers (contract in openapi.yaml)
  docs_dashboard.ts             # Docs/modules dashboard derivation (pure; sync status from the tree)
  search.ts                     # In-memory BM25 full-text search
  semantic_search.ts            # Chroma vector search with BM25 fallback
  analytics.ts                  # PCA, K-Means, word loadings
  alert_trends.ts               # Per-type trend bars + all-monitor heatmap
  annotations.ts                # Bounded JSON wildfire-map annotation store (GET/POST/DELETE /api/annotations)
  ordinal_refinement.ts         # Ordinal-sequence refinement report (GET /api/ordinals)
  legal_crosslinks.ts           # CA/US legal-citation cross-link builder (GET /api/citations/index)
  effective_dates.ts            # Latest recorded amendment year (GET /api/effective-dates)
  static/index.html             # Single-page app (no framework)
  static/docs-dashboard.html    # Docs/modules dashboard page
  static/structured-queries.html # Dedicated structured-query page (history/compare/similar)
  static/phase10-legal.html     # Legal-analysis page (ordinals / citation cross-links / recorded amendment years)
llm/                            # Ollama/OpenRouter chat + Chroma RAG stack
  config.ts                     # LLM configuration
  provider.ts                   # Explicit Ollama/OpenRouter chat-provider selection
  ollama.ts                     # Ollama API wrapper
  chroma.ts                     # ChromaDB client
  embeddings.ts                 # Chunking + per-article incremental indexing into ChromaDB
  index_plan.ts                 # Pure per-article index planner: what to re-embed, what to delete,
                                #   and when a full re-embed is mandatory (model/chunking change)
  rag.ts                        # RAG pipeline (embed -> retrieve -> generate)
  streaming_rag.ts              # Provider-native SSE streaming RAG
  openrouter.ts                 # OpenRouter chat/stream client with per-run request cap
  structured.ts                 # Schema-constrained structured generation
  dedupe.ts                     # Near-duplicate suppression for generated text
  usage.ts                      # Token/request usage accounting
  validate.ts                   # Generated-output validation guards
  semantic_review.ts            # Bound claim/source spans and supplied review annotations without factuality certification
  index.ts                      # CLI entry point
  evidence.ts                   # Citation policy, abstention and reproducible support evaluation
  privacy.ts                    # Bounded private query retention and opt-in diagnostics
  runtime.ts                    # Model/vector admission, deadlines and byte limits
  benchmark.ts                  # Module contract and implementation
scripts/                        # Thin CLI orchestrators — full list in scripts/README.md
                                #   and package.json "scripts"; business logic in src/
tests/                          # Deterministic zero-mock suite; run `bun run validate`
docs/                           # Full module documentation suite
output/                         # Scraped data + reports (gitignored)
pages-data/                     # Reviewed public seed artifacts for static Pages (tracked)
openapi.yaml                    # OpenAPI 3.0.3 spec
```

## Verify

```bash
bun install --frozen-lockfile # Install locked dependencies
bunx playwright install chromium # Install the browser separately
bun run source-discovery    # Refresh optional generated registry/health evidence;
                            #   present artifacts must match the canonical fingerprint
bun run validate            # Authoritative gate: contracts + source/test strict types +
                            #   manuscript + fenced plain/coverage suites + line floor
bun test                    # Deterministic zero-mock suite (offline; no mocks)
```

For GitHub Pages work: `bun run pages:export` -> `bun run pages:validate -- .pages`.

Other commands: `bun run gui` (web viewer on :3000), `bun run weekly-check`
(writes `output/state/latest-pipeline-run.json` — absent until the first run),
`bun run geo:observations`, `bun run geo:sync-check`. See `package.json`
"scripts" and `scripts/README.md` for the rest.

Prerequisites: Bun 1.4.2 (the CI pin); `bun install` installs the Playwright
package, and `bunx playwright install chromium` installs its browser. The
optional LLM stack is Ollama with `nomic-embed-text` + `gemma3:4b`, Chroma on
port 8001. Air quality uses public AirNow PM2.5 observations; `AIRNOW_API_KEY`
enables the optional keyed ZIP endpoint.

## Critical boundaries

- **scripts/ are thin orchestrators** — business logic lives in `src/`
  (see `scripts/AGENTS.md`).
- **Zero-mock tests**: real data, real modules, all offline. Tests must not
  persist changes to the real output corpus. `src/shared/output_fence.ts`
  detects drift in `finally` after successful, failed, and timed-out plain and
  coverage runs, for both the checkout corpus and any selected `CC_OUTPUT_DIR`.
- **openapi.yaml <-> src/gui/routes.ts route-table parity** is enforced by the
  release gate; update both together.
- **tsconfig `include` is `src/` + `scripts/` only.** Do not widen the production
  include. Tests use a separate strict `tsconfig.tests.json` lane
  (`bun run test:typecheck`).
- Generated source-discovery artifacts are optional. When present, the release
  gate requires their counts and fingerprints to match the canonical registry.
- `tests/doc-inventory.test.ts` enforces that every `src/**/*.ts` appears in
  the tree above on its own `name.ts # ...` line — new modules need an entry.

## Where deeper guidance lives

- `docs/` — module docs (`docs/modules/`), architecture, setup, configuration,
  api-reference. Repo conventions live there too.
- [TODO.md](TODO.md) — the single item-level backlog.
- `docs/roadmap.md` — strategy.
- `docs/project-review.md` — current-state audit, cleanup decisions, and verification receipts.
- [CHANGELOG.md](CHANGELOG.md) — the ONLY version history.
- [ISA.md](ISA.md) — frozen 2026-07 build archive, not current guidance.

## Known limitations

- Cloudflare Turnstile timing varies; the scraper may need retries.
- ecode360 content changes are not auto-detected — re-scrape to update.
- Source gaps are coverage metadata, not pipeline failure: `ok` and `empty`
  count as present; `unavailable` and `stale` count as missing.
- NDBC buoy data may have gaps (stations go offline for maintenance).
- The keyed AirNow ZIP endpoint requires `AIRNOW_API_KEY`; the public PM2.5
  fallback requires no key and cannot establish current air quality without a
  fresh nearby observation.

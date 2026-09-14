# AGENTS.md — The Quadruplicate

## What this is

A Bun/TypeScript civic-intelligence platform for Crescent City, CA. It scrapes,
verifies, exports, and queries the municipal code from ecode360.com, monitors
15 real-time alert streams (8 core + 7 extended incl. USCG broadcasts), provides
RAG chat via Ollama/OpenRouter + Chroma, and publishes a bounded snapshot to
GitHub Pages at quadruplicate.org. See [README.md](README.md) for the full
feature map. There is no Python here — the watchdog is `bun`, never `uv`/`pytest`.

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
[Intelligence Layer — 15 monitors]
   8 core: NOAA Tsunami · USGS Earthquake · NWS Weather · NOAA Tides ·
   CDFW Fishing · EPA AirNow · CAL FIRE Wildfire · NDBC Marine
  7 extended: USDM Drought · PG&E PSPS · HRRR Smoke · Caltrans Roads ·
  DUSD Closures · NWS Marine Forecast (CWF PZZ450) · USCG Broadcasts (BNM District 11)
        |
 [Alert Analytics — unified timeline + per-type stats]
```

## Directory map

```
src/                            # Municipal-code pipeline + intelligence layer
types.ts                        # All TypeScript interfaces
constants.ts                    # Centralized constants (env-overridable)
utils.ts                        # Shared utilities (SHA-256, flatten, chunk, etc.)
logger.ts                       # Structured logger
browser.ts                      # Playwright lifecycle + Cloudflare bypass
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
insights.ts                     # Cross-artifact civic trend brief
directory.ts                    # Provenance-checked civic directory builder
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
pages_scan.ts                   # Pages artifact scanner (links, assets, SEO)
pages_css.ts                    # Generated Pages stylesheet builder
pages_validation.ts             # Pages artifact validator (release-gate checks)
pages_seed.ts                   # Verified municipal-code seed refresh for Pages
alerts/                         # 15 monitors + composite severity; docs/modules/alerts.md
  severity.ts                   # Composite alert severity over all 15 monitor inputs
  noaa_tsunami.ts               # NOAA CAP tsunami warning monitor
  noaa_tides.ts                 # NOAA CO-OPS tides (station 9419750)
  usgs_earthquake.ts            # USGS earthquake monitor (M4.0+, 200 km)
  nws_weather.ts                # NWS Del Norte coastal zone CAZ006 alerts
  cdfw_fishing.ts               # CDFW Dungeness crab season monitor
  epa_airnow.ts                 # EPA AirNow air quality (PM2.5, ozone, PM10)
  calfire_wildfire.ts           # CAL FIRE wildfire incident monitor
  ndbc_marine.ts                # NDBC buoy marine weather (wave, wind, temp)
  nws_marine.ts                 # NWS CWF coastal waters forecast (PZZ450)
  uscg_broadcasts.ts            # USCG District 11 broadcast notices to mariners
  usdm_drought.ts               # US Drought Monitor DSCI for Del Norte
  pge_psps.ts                   # PG&E public safety power shutoff monitor
  hrrr_smoke.ts                 # NOAA HMS / HRRR smoke plume monitor
  caltrans_roads.ts             # Caltrans road closure and incident monitor
  dusd_schools.ts               # Del Norte USD school closure monitor
  composite.ts                  # Freshness-gated composite availability across monitors
  healer.ts                     # Per-monitor staleness detection and re-run roster
  notify.ts                     # ALERT_WEBHOOK_URL fire-and-forget severity webhook
api/
  middleware.ts                 # Sliding-window rate limiter + API key auth
domains/
  coverage.ts                   # Domain coverage % with prefix matching
  scholarly_context.ts          # Scholarly/reference context per civic domain
notifications/
  push.ts                       # Push notification delivery
shared/
  paths.ts                      # Centralized output path constants
  source_health.ts              # Typed source-health contract + atomic artifact writes
  orchestration.ts              # Durable step/run envelopes and build metadata
  data.ts                       # Data loading layer (60s TTL cache)
  porter_stem.ts                # Zero-dep Porter stemmer for BM25
  readability.ts                # Flesch-Kincaid + Gunning Fog scoring
  fuzzy.ts                      # Levenshtein fuzzy matching + typo correction
  idempotency.ts                # Durable idempotency store for repeated runs
  output_fence.ts               # Output-corpus fence: proves the suite mutates nothing
gui/                            # Bun.serve HTTP server (port 3000)
  server.ts                     # Bun.serve() HTTP server (port 3000)
  routes.ts                     # API route handlers (contract in openapi.yaml)
  search.ts                     # In-memory BM25 full-text search
  semantic_search.ts            # Chroma vector search with BM25 fallback
  analytics.ts                  # PCA, K-Means, word loadings
  alert_trends.ts               # Per-type trend bars + all-monitor heatmap
  static/index.html             # Single-page app (no framework)
llm/                            # Ollama/OpenRouter chat + Chroma RAG stack
  config.ts                     # LLM configuration
  provider.ts                   # Explicit Ollama/OpenRouter chat-provider selection
  ollama.ts                     # Ollama API wrapper
  chroma.ts                     # ChromaDB client
  embeddings.ts                 # Chunking + indexing pipeline
  rag.ts                        # RAG pipeline (embed -> retrieve -> generate)
  streaming_rag.ts              # Provider-native SSE streaming RAG
  openrouter.ts                 # OpenRouter chat/stream client with per-run request cap
  structured.ts                 # Schema-constrained structured generation
  dedupe.ts                     # Near-duplicate suppression for generated text
  usage.ts                      # Token/request usage accounting
  validate.ts                   # Generated-output validation guards
  index.ts                      # CLI entry point
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
bun install                 # Install dependencies
bun run source-discovery    # REQUIRED ONCE on a fresh clone: writes
                            #   output/source-registry.json, which the release
                            #   gate requires in fingerprint sync (src/release_gate.ts)
bun run validate            # Authoritative gate: in-process contracts + tsc +
                            #   manuscript + fenced bun test + coverage floor
bun test                    # Deterministic zero-mock suite (offline; no mocks)
```

For GitHub Pages work: `bun run pages:export` -> `bun run pages:validate -- .pages`.

Other commands: `bun run gui` (web viewer on :3000), `bun run weekly-check`
(writes `output/state/latest-pipeline-run.json` — absent until the first run),
`bun run geo:observations`, `bun run geo:sync-check`. See `package.json`
"scripts" and `scripts/README.md` for the rest.

Prerequisites: Bun 1.0+; Playwright auto-installs via `bun install`; the
optional LLM stack is Ollama with `nomic-embed-text` + `gemma3:4b`, Chroma on
port 8001, and `AIRNOW_API_KEY` for air quality.

## Critical boundaries

- **scripts/ are thin orchestrators** — business logic lives in `src/`
  (see `scripts/AGENTS.md`).
- **Zero-mock tests**: real data, real modules, all offline. The suite mutates
  nothing — enforced by the output-corpus fence in `src/shared/output_fence.ts`.
- **openapi.yaml <-> src/gui/routes.ts route-table parity** is enforced by the
  release gate; update both together.
- **tsconfig `include` is `src/` + `scripts/` only.** Tests are not typechecked
  (24 known `tsc` errors if included) — do not widen the include.
- The release gate requires `bun run source-discovery` once on a fresh clone.
- `tests/doc-inventory.test.ts` enforces that every `src/**/*.ts` appears in
  the tree above on its own `name.ts # ...` line — new modules need an entry.

## Where deeper guidance lives

- `docs/` — module docs (`docs/modules/`), architecture, setup, configuration,
  api-reference. Repo conventions live there too.
- [TODO.md](TODO.md) — the single item-level backlog.
- `docs/roadmap.md` — strategy.
- [CHANGELOG.md](CHANGELOG.md) — the ONLY version history.
- [ISA.md](ISA.md) — frozen 2026-07 build archive, not current guidance.

## Known limitations

- Cloudflare Turnstile timing varies; the scraper may need retries.
- ecode360 content changes are not auto-detected — re-scrape to update.
- Source gaps are coverage metadata, not pipeline failure: `ok` and `empty`
  count as present; `unavailable` and `stale` count as missing.
- NDBC buoy data may have gaps (stations go offline for maintenance).
- AirNow API requires a free API key (`AIRNOW_API_KEY`).

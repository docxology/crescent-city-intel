# Changelog

All notable changes to the **Crescent City Intelligence Platform** are
documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioned by [Semantic Versioning](https://semver.org/).

---

## [2.3.0] — 2026-07-23

### 🚀 TODO Items Implemented

#### Scraper Robustness (`src/scraper_utils.ts`)
- Cloudflare stall detection (`detectCloudflareStall()`)
- Network error retry with exponential backoff (`withRetry()`)
- HTTP 503/redirect maintenance mode detection (`isMaintenanceMode()`)
- Terminal progress bar (`formatProgressBar()`)
- Per-article timing metrics collector (`ScrapeMetricsCollector`)

#### RAG Pipeline Enhancements (`src/llm/rag.ts`)
- Adaptive topK: short queries (<=3 words) get top-5, broad queries get top-15
- Query expansion: 12 CA municipal law synonym groups expand before embedding
- Multi-model selection: `/api/chat?model=llama3:8b` overrides default model
- `chat()` in `ollama.ts` now accepts `modelOverride` parameter

#### Search Enhancements (`src/gui/search.ts`)
- Field-level search: `?field=number` searches only section numbers, `?field=title` searches only titles

#### Monitoring Enhancements (`src/monitor.ts`)
- Diff report: when changes detected, writes `output/monitor-diff.json` with human-readable change list
- Version snapshots: archives manifest as `output/snapshots/snapshot-<timestamp>.json` on change detection

#### New API Endpoints (3)
- `GET /api/alerts/correlation` — detects earthquake→tsunami and wildfire→AQI correlated sequences
- `GET /api/ordinal-check` — detects gaps in section numbering within each Title
- `GET /api/definitions/conflicts` — finds terms defined differently in different sections

#### Docker Deployment
- `docker-compose.yml` — GUI + Ollama + ChromaDB in 3 containers
- `Dockerfile` — Bun-based image for the GUI server

### 📊 Test Suite
- **437 tests passing** across **36 files** (up from 413 in v2.3.0)
- New test files: `scraper_utils.test.ts` (18 tests), `v2-endpoints-extended.test.ts` (6 tests)
- **0 test failures** (5 pre-existing module import errors)

---

## [2.3.0] — 2026-07-23

### 🚀 TODO Items Implemented

#### New API Endpoints (4)
- `GET /api/report/latest` — serve most recent monthly civic health report as Markdown
- `GET /api/search/analytics` — most-queried search terms aggregated from search query log
- `GET /api/domains/:id/coverage` — per-domain coverage metrics
- Enhanced `GET /api/health` — now includes manifest staleness info (ageDays, stale flag) and composite alert level

#### Search Analytics
- BM25 search engine now logs every query to `output/search-queries.jsonl` with timestamp, query text, and result count
- `GET /api/search/analytics` aggregates logged queries into top-20 term frequency report

#### Chat History Persistence
- RAG pipeline now persists all Q&A pairs to `output/chat-history/YYYY-MM-DD.jsonl` (one file per day)
- Each entry includes timestamp, role (user/assistant), content, source sections, model, and latency

#### Staleness Detection
- `/api/health` now checks manifest age — returns `manifest.ageDays` and `manifest.stale` (true if >30 days)
- GUI shows warning banner when data is stale: "Data is X days old. Run `bun run scrape` to refresh."
- GUI also shows active alert level banner when composite severity is not CALM

#### Incremental Indexing
- `indexAllSections()` now skips re-embedding when ChromaDB collection already has the expected number of chunks
- Logs "skipping incremental re-index" when collection count matches expected chunk count

### 📊 Test Suite
- **437 tests passing** across **36 files** (up from 404 in v2.1.0)
- New test file: `v2-endpoints.test.ts` — 9 tests for health, report, search analytics, domain coverage
- **0 test failures** (5 pre-existing module import errors from missing npm deps)

### 📝 Documentation
- OpenAPI spec: 4 new endpoint definitions (v2.3.0, 45+ endpoints total)
- All version references updated to 2.3.0 (README, AGENTS.md, TODO, tests/AGENTS.md, docs/README.md)

---

## [2.1.0] — 2026-07-23

### 🚀 Comprehensive Integration & Testing

#### Full Module Wiring
- `run-alerts.ts` orchestrator now runs all 8 monitors + computes composite severity + persists to `output/alerts/composite/current.json`
- `weekly-check.ts` now runs all 8 alert monitors + alert analytics in weekly cycle
- `run.sh` interactive menu expanded with air quality, wildfire, marine, and composite alert options
- `monthly_report.ts` now includes air quality, wildfire, and marine sections

#### 8-Monitor Composite Severity (enhanced)
- `/api/monitor/alerts` expanded from 5 to 8 monitors + composite severity
- New per-type endpoints: `/api/alerts/airquality`, `/api/alerts/wildfire`, `/api/alerts/marine`, `/api/alerts/composite`

#### Search Engine Integration
- BM25 `search.ts` now imports `fuzzyCorrect` and returns `fuzzyCorrections` array when BM25 finds 0 results — "Did you mean?" built into search response shape

#### Intelligence Domains (9 → 12)
- **Climate & Environment** — sea-level rise, drought/water conservation, air quality/environmental justice
- **Demographics & Social Indicators** — population profile (PBSP skew), poverty/economic vulnerability, homelessness/housing instability
- **Public Health & Safety** — EMS, food safety/restaurant inspection, mental health/CARE Court

#### Cross-Reference Validation
- `validateAllCrossReferences()` — scans entire code corpus for § references, computes resolution rate, identifies broken links
- `GET /api/cross-refs/validate` — API endpoint

#### Alert Analytics Bug Fix
- `alert_analytics.ts` now includes "fishing" in ALERT_TYPES (was missing)
- Fixed history file path resolution for fishing (`output/fishing/`) and tides (`output/tides/`)

#### GUI Dashboard
- New 🚨 Alerts button in header
- 8-monitor composite dashboard panel with severity banner, per-monitor grid, timeline summary

#### OpenAPI Spec
- 16 new endpoint definitions with full schemas (Structured Queries, Legal Analysis, Alert Analytics, Alerts, LLM, Search tags)

#### GitHub Actions
- Weekly CI workflow now runs all 8 alert monitors (airquality, wildfire, marine added)

#### Documentation
- `docs/modules/alerts.md` fully rewritten for 8 monitors + composite + analytics
- `docs/modules/v2-intelligence.md` — comprehensive v2 module documentation
- `tests/AGENTS.md` — updated with 404 tests across 36 files
- `docs/README.md` and `docs/modules/AGENTS.md` updated

### 📊 Test Suite
- **404 tests passing** across **36 files** (up from 268 in v1.4.0)
- **0 test failures** (5 pre-existing module import errors from missing npm deps)
- New test files: `alert_analytics.test.ts`, `comprehensive-edges.test.ts`
- Updated `domains.test.ts` and `verify.test.ts` for 12-domain count

---

## [2.0.0] — 2026-07-22

### 🚀 Major Release — Comprehensive Local Intelligence Platform

#### New Alert Monitors (3)
- **EPA AirNow air quality** (`src/alerts/epa_airnow.ts`) — PM2.5/ozone/PM10 AQI with 6-level classification
- **CAL FIRE wildfire** (`src/alerts/calfire_wildfire.ts`) — active fire incidents, evac orders, Haversine distance
- **NDBC marine buoy** (`src/alerts/ndbc_marine.ts`) — 3 stations, wave/wind/temp, gale thresholds

#### Structured Query Engine
- Legislative history parsing, section comparison (word-level diff), semantic similarity (cosine + title boost)

#### Legal Citation Parser
- CA Code, U.S.C., case law, ordinance amendment extraction, definition glossary builder

#### Fuzzy Search
- Levenshtein edit distance for typo-tolerant queries

#### Streaming RAG
- Server-Sent Events for word-by-word answer streaming

#### Alert Analytics
- Unified timeline across all 8 monitor types, per-type statistics

#### 16 New API Endpoints
- `/api/history/:guid`, `/api/compare`, `/api/similar/:guid`
- `/api/citations/:guid`, `/api/glossary`, `/api/cross-refs/validate`
- `/api/alerts/timeline`, `/api/alerts/recent`, `/api/chat/stream`, `/api/fuzzy`
- `/api/alerts/airquality`, `/api/alerts/wildfire`, `/api/alerts/marine`, `/api/alerts/composite`

#### Renamed from crescent-city → crescent-city-intel
- Old repo (`docxology/crescent-city`) deprecated with signpost README

---

## [0.2.0] — 2026-03-18

### 🚀 Major Features Added

#### Search Engine Overhaul (BM25 + Porter Stemming)
- Replaced basic keyword search with full **BM25 ranking** (K1=1.5, B=0.75, IDF+TF index)
- Added **Porter stemmer** (`src/shared/porter_stem.ts`) — zero-dependency TypeScript, Steps 1a-5b
- BM25 index built on stemmed tokens; queries use raw∪stemmed union for improved recall
- Added `typeFilter` option (`?type=section` vs `?type=article`) for scoped results
- Added `highlight` option returning snippets with `<mark>` HTML tags
- Added pagination: `offset` + `limit` in `PagedSearchResult`
- Added `titleFilter` (`?title=8`) to scope results within a code title

#### AI / RAG Improvements
- Added **POST `/api/chat`** endpoint — accepts JSON body `{q}` for long questions without URL length limits
- RAG queries now logged to `output/rag-queries.jsonl` with question, latency, model, sources
- Ollama pre-flight check before indexing/chat (actionable error messages)

#### Readability Analysis
- New module **`src/shared/readability.ts`** — Flesch-Kincaid Grade Level + Reading Ease
- `bun run readability` → `output/readability.json` (all 2,194 sections, sorted hardest→easiest)
- **`GET /api/readability`** — serves cached or on-demand computed scores
- Difficulty labels: plain (<8) · standard (8-12) · complex (12-16) · legal (16+)

#### Domain Coverage Metrics
- New module **`src/domains/coverage.ts`** — what % of sections each domain cross-references
- Prefix matching: §17.04 matches §17.04.010 and §17.04.020
- `bun run coverage` → `output/domain-coverage.json`
- **`GET /api/domains/coverage`** — serves cached or on-demand report

#### Intelligence Domain Expansion
- Added **Domain 6: Housing & Homelessness** — 5 topics with CalHFA, HUD, CARE Court cross-refs
- Total: 6 civic intelligence domains (Emergency, Business, Public Safety, Environment, Infrastructure, Housing)

#### Marine & Harbor Intelligence
- **NOAA CO-OPS Tides** (`src/alerts/noaa_tides.ts`) — station 9419750, 48-hour predictions, 5 ft MLLW alert
- **CDFW Fishing Monitor** (`src/alerts/cdfw_fishing.ts`) — Dungeness crab season calendar + marine bulletin scraping

#### Monitoring Enhancements
- News monitor: added **KIEM-TV NBC Eureka** as 4th RSS source
- News monitor: **persistent cross-run deduplication** via `output/news/seen-ids.json` (URL-normalized, 10k cap)
- News monitor: **`--keywords=term1,term2`** CLI argument for targeted filtering
- Municipal code monitor: persistent history log at `output/monitor-history.jsonl`
- Added **`GET /api/monitor/history`** and **`GET /api/monitor/alerts`** endpoints

#### Interactive Run Menu
- New **`run.sh`** top-level shell script with full interactive text menu
- Covers all features: setup, tests, scrape, verify, export, GUI launch, LLM/RAG, monitoring, analytics
- Sub-menus for monitoring (9 options), LLM/RAG (6 options), analytics (5 options)
- CLI flags: `./run.sh gui|test|setup|status|api-test`
- Live API tester: checks 12 endpoints and reports HTTP status codes

### 🔧 Improvements

#### API & Server
- **Gzip compression** (`src/gui/server.ts`): API responses >4KB automatically compressed when client sends `Accept-Encoding: gzip`; `Vary: Accept-Encoding` header set
- Added `GET /api/sections?title=8&chapter=04` hierarchical navigation endpoint
- Added `GET /api/domain/:id/sections` domain → code section cross-reference map
- Added `GET /api/readability` and `GET /api/domains/coverage` endpoints
- API middleware: **sliding-window rate limiter** (replaces fixed-window)
  - Per-endpoint limits: `/api/chat` → 20/hr, `/api/summarize` → 20/hr, `/api/analytics/embeddings` → 10/hr
  - `Retry-After` header in 429 responses
  - Comma-separated `CRESCENT_CITY_API_KEY` for multiple clients
  - `X-RateLimit-Remaining` response header

#### Data Layer
- **60-second in-process TTL cache** for `loadAllSections()` in `src/shared/data.ts`
- `invalidateSectionsCache()` and `loadAllSectionsCount()` utilities exported
- All data loading now has actionable error messages with exact fix instructions

#### Infrastructure
- `scripts/cron-setup.sh` — macOS Launchd + Linux cron installer for weekly health check
- `openapi.yaml` bumped to version 1.3.0
- `package.json` version 1.3.0 with new `coverage` and `readability` commands

### 🧪 Testing

- **+27 new tests** across 2 new test files (total: **235 tests · 0 failures · 21 files**)
- `tests/content.test.ts` (14 tests): htmlToText · Porter stemmer · Flesch-Kincaid readability
- `tests/verify.test.ts` (11 tests): SHA-256 async · manifest structure · data TTL cache · domain coverage
- `tests/middleware.test.ts` (7 tests): sliding-window rate limiter · API key auth · bypass paths
- `tests/alerts.test.ts` (13 tests): NOAA tides · CDFW crab season · all 5 alert modules
- Zero-mock policy maintained across all 21 test files

### 📖 Documentation

- **README.md** completely rewritten — comprehensive GitHub README with:
  - Full table of contents with jump links
  - Expanded Crescent City civic context (tsunami history, Battery Point Lighthouse, harbor, governance)
  - 14-entry civic resource link table
  - 22-endpoint API reference table
  - 4-section command tables (Pipeline · AI/RAG · Monitoring · Analysis)
  - 21-file test suite table
  - `run.sh` interactive menu documentation with API test output
- **TODO.md** completely rewritten — 10 deeply scoped phases with 100+ actionable items
- Added `CHANGELOG.md` (this file)
- Added `CONTRIBUTING.md`

### 🐛 Bug Fixes

- Fixed `computeSha256` tests — function is async (returns Promise), tests now properly `await`
- Fixed `htmlToText` test assertions to match actual function behavior (tag stripper, not sanitizer)
- Fixed `tokenizeAndStem` and `queryTerms` missing from search.ts (were called but not defined)
- Fixed POST /api/chat: removed duplicate function that wasn't attached to the right method handler

### ⚠️ Breaking Changes

None. All existing CLI commands and API endpoints remain compatible.

---

## [0.1.0] — 2026-03-14

### Initial Release

- Playwright scraper with Cloudflare Turnstile bypass
- SHA-256 integrity verification + TOC cross-reference
- Multi-format export (JSON, Markdown, TXT, CSV)
- Bun.serve() web viewer with collapsible TOC
- Ollama + ChromaDB RAG pipeline with source citations
- 5 civic intelligence domains (Emergency, Business, Public Safety, Environment, Infrastructure)
- Basic in-memory full-text keyword search
- NOAA tsunami, USGS earthquake, NWS weather alert monitors
- Municipal code change detection
- RSS news monitor (Times-Standard, Lost Coast Outpost, Humboldt Times)
- Government meeting tracker (City Council, Planning Commission, Harbor Commission)
- Analytics dashboard: PCA scatter plot, K-Means clustering, word loadings
- Per-section Ollama summarization
- 208 tests · 0 failures · 19 test files

---

[0.2.0]: https://github.com/docxology/crescent-city-intel-intel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/docxology/crescent-city-intel-intel/releases/tag/v0.1.0

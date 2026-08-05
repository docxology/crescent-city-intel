# Changelog

All notable changes to the **Crescent City Intelligence Platform** are
documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioned by [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Deepest review pass (2026-08-04) — round 4 ("proceed with all improvements")

### Added

- **Real browser smoke test** (`scripts/browser-smoke.ts`, `bun run test:browser`): starts the
  actual GUI server and drives it in headless Chromium, asserting the SPA renders, the
  loopback API-key trust boundary injects a real key, `/api/toc` authenticates, and
  `/api/search/semantic` returns a fallback envelope. Resolves the Playwright-build
  version-skew by auto-detecting the installed Chromium. Verified passing.
- **`docs/api-reference.md` + `docs/modules/{gui,llm}.md`** completed (Phase 14) for the
  semantic-search, rerank, chat-history, webhook, dedup-key, bounded-JSONL and
  link-item exports.

### Fixed

- Removed unused `writeFileSync` imports from `epa_airnow`, `nws_weather`, `usgs_earthquake`.

### Deepest review pass (2026-08-04) — "proceed with all" completion

### Added

- **Semantic search** `GET /api/search/semantic`: Ollama-embed + ChromaDB retrieval with
  graceful BM25 fallback (`src/gui/semantic_search.ts`). Registered in the OpenAPI
  route-contract gate; tests in `tests/semantic-search.test.ts`.
- **RAG reranking** behind `RERANK_ENABLED=true`: `rerankByQueryOverlap` (lexical-hybrid)
  reorders top retrieval chunks; off by default so existing behavior is unchanged.
  Tests in `tests/rag-rerank.test.ts`.
- **Conversation history**: `POST /api/chat` and `/api/chat/stream` accept a bounded
  `history` array; pure `buildChatMessages` (last 6 turns). GUI tracks `chatHistory` and
  sends it. Tests in `tests/chat-history.test.ts`.
- **GUI error banner**: top-of-page `#error-banner` + `showErrorBanner`; `apiFetch`
  surfaces network failures. String-contract test in `tests/gui-chat-contract.test.ts`.
- **Alert webhook notifier** (`src/alerts/notify.ts`): `ALERT_WEBHOOK_URL` POSTs on
  composite WARNING/EMERGENCY (fire-and-forget). Tested against a real local listener.
- **Fire weather surfaced**: NWS weather monitor flags `isRedFlag` + `redFlagCount`
  (Del Norte Red Flag already flows through the CAZ006 zone fetch).
- **Structured meeting agenda/minutes**: `extractLinkItems` + `agendaItems`/`minuteItems`
  on meeting items. Tests in `tests/gov-meeting-agenda.test.ts`.
- **`bun run test:coverage`** alias.

### Deepest review pass (2026-08-04) — Round 3 completion

### Fixed / Added

- **Bounded alert history (R7, was a deferred Major):** `shared/source_health.ts` adds
  `appendBoundedJsonl`/`appendBoundedJsonlSync`, capped JSONL appenders that tail-trim to
  10 000 lines; wired into all eight alert monitors. JSONL history no longer grows unbounded.
- **Header-only API key auth:** the `?api_key=` query-parameter fallback is removed (it leaked
  credentials into logs/URLs); only `X-API-Key` is accepted. OpenAPI `apiKeyQuery` scheme dropped.
- **`GET /api/alerts/{type}/history`:** paginated per-type alert history
  (`?limit=&offset=`, 400 on unknown type); registered in the OpenAPI route-contract gate.
- **`/api/health` rate-limit metrics:** `getRateLimitStats()` → `{trackedIps, peakUsage, blocked}`.
- **`--full-rescrape`** scrape flag (bypasses the resume cache).
- **Monthly report covers tides + fishing** (new "🌊 Tides" and "🦀 Dungeness Crab Season"
  sections from `output/{tides,fishing}/history.jsonl`).
- **News dedup key is URL+title** (`dedupKey`), so distinct paginated articles sharing a path
  are no longer collapsed; cross-feed/param variants still dedup.
- **`sanitizeFilename` guard** for empty/dot/dot-dot results.
- **Composite tides/fishing availability is freshness-gated.**
- **`isComplexWord` sentence-position fix** — sentence-initial polysyllabic content words are
  no longer dropped as "proper nouns", correcting Gunning-Fog under-reporting.
- **CDFW bulletin `date` is honest** (parsed from anchor when present, else empty).

### Deepest review pass (2026-08-04) — continuation

### Fixed

- **Tides and fishing now appear in the unified alert timeline/analytics.**
  `noaa_tides.ts` wrote its history to `output/tides/tide-history.jsonl` — a
  filename nothing read while `alert_analytics.ts` looks for
  `output/tides/history.jsonl` — and `cdfw_fishing.ts` wrote no history file at
  all, so the timeline/stats silently omitted both monitor types. Both monitors
  now write the `history.jsonl` path the analytics layer reads (tides records
  gain a real `level`, fishing gains a `history.jsonl`), and
  `tests/alert-analytics-contract.test.ts` locks the path contract.
- **`src/scrape.ts` no longer runs on import** (`import.meta.main` guard added,
  matching the `export.ts` / `verify.ts` guards), so no module import can launch
  Playwright as a side effect.

### Deepest review pass (2026-08-04)

### Fixed

- **SSE `/api/chat/stream` streaming restored.** `maybeCompress` (src/gui/server.ts)
  treated `text/event-stream` like any text response and `arrayBuffer()`'d the live
  ReadableStream, consuming the whole stream and returning the RAG answer buffered
  (every browser sends `Accept-Encoding: gzip`, so streaming was effectively broken).
  Event-stream responses now pass through untouched; regression tests in
  tests/gui-compress.test.ts.
- **`request-log.jsonl` now records the real HTTP status** (was a hardcoded 0 written by
  middleware that runs before the handler). The server records each API response's status
  and duration via `recordRequestLog()`.
- **`src/export.ts` is now importable**: builders are pure (`buildConsolidatedJson`,
  `buildMarkdownFiles`, `buildPlainText`, `buildSectionIndexCsv`) and `main()` is guarded
  by `import.meta.main`. Adds `tests/export.test.ts` (closes the deferred export test gap).
- **`src/verify.ts` no longer runs on import** (`import.meta.main` guard) and exports
  `collectDescendantSections`; adds `tests/verify.test.ts`.
- **Alert `current.json` is written atomically** (writeJsonAtomic) in 6 alert monitors, so a
  torn write cannot surface as a spurious unavailable live state.
- **Composite wildfire severity is distance-aware** — `hasLargeFireNearby` requires a
  fire within 50 km, matching the monitor's own ADVISORY/WARNING classification (a large
  fire ~130 km away no longer forces the composite to WARNING).
- **Stale tide-severity thresholds corrected** in the severity.ts header and README
  (WARNING≥7.0 / WATCH≥6.0 ft MLLW, not the old 5/3 ft).
- **Fuzzy search fallback logs zero-result queries** for search analytics.
- **AGENTS.md doc drift corrected** (test-file references, API rate-limit model, tides
  monitor export).

### Deepest hostile red-team hardening pass (2026-08-01)

### Fixed

- Rate-limit bypass via spoofed `X-Forwarded-For`/`X-Real-IP` closed — the
  trusted-local bypass is now decided on the real socket address.
- Well-known default API key (`dev-key-12345`) replaced with a random per-boot
  credential when `CRESCENT_CITY_API_KEY` is unset (docs + compose updated).
- Upstream alert fetches (tides, tsunami, fishing, marine) now carry a timeout
  so a hung feed cannot stall `run-alerts`.
- EPA AirNow no longer publishes a false `GOOD` reading when its keyed ZIP
  endpoint returns no data (falls through to the public KML product).
- `loadAllArticles` now sorts corpus output (deterministic ordering) and logs
  corrupt-article loss at ERROR level instead of a silent per-file warn.
- Atomic writes (`writeJsonAtomic`/`writeTextAtomic`/idempotency `save`) now
  `fsync` the temp file before `rename`, closing a crash window that could wipe
  dedup state.
- Long-lived GUI no longer permanently locks OpenRouter generation after 100
  cumulative calls; LLM lazy-load retries after a transient failure.
- Verifier section enumeration now matches the scraper's; monthly-report
  earthquake magnitude NaN guarded; export sorts a copy; analytics reports
  `degraded` on a missing code corpus; monitor flags extra sections as changed.
- Haversine NaN clamp (earthquake/airnow/wildfire); `chunk(size≤0)` guard;
  yt-dlp video-id validation; dead code removed; `2.5.0` version drift
  corrected to `2.5.1`; README hardcoded test count dropped.

### Deepest hostile red-team hardening pass (2026-08-01) — part 2: scoped Majors

The red-team review's MAJOR findings are now implemented (previously scoped in
TODO.md). See the issue-by-issue notes in TODO.md.

### Fixed

- **Tsunami composite severity now works (was M1/M3).** `noaa_tsunami.ts` persists
  each alert's classified `threatLevel` (warning/watch/advisory) into
  `current.json`, the fetch now pulls all active CA tsunami events (Warning,
  Watch and Advisory — previously pinned to `event=Tsunami Warning` only, so the
  WATCH tier was structurally empty), and `run-alerts.ts` reads `threatLevel`
  instead of the CAP `severity` enum. A real tsunami warning now elevates the
  composite banner to EMERGENCY; watches/advisories to WATCH.
- **NWS weather composite severity now works (was M2).** `nws_weather.ts` persists
  its computed `severityLevel` (advisory/watch/warning) into each `current.json`
  alert and `run-alerts.ts` reads it — a Severe weather warning now correctly
  reaches WARNING instead of being misclassified as an advisory.
- **Change-detector now checks the manifest baseline (was M3-monitor).**
  `monitor.ts checkHashes` compares the recomputed SHA-256 against the trusted
  `manifest.articles[guid].sha256` rather than the hash stored in the article
  file itself, so a consistent whole-file rewrite is detected, not self-validated.
- **Readability no longer fragments on every period (was M4).** `readability.ts`
  shields decimal section numbers (`17.04.010`), dotted citations (`U.S.C.`), and
  common abbreviations (`No.`, `Cal.`) before sentence-splitting, correcting
  Flesch-Kincaid / Reading Ease / Gunning Fog for decimal-heavy legal text.
- **`.env` excluded from the Docker image (was M5).** Added `.dockerignore`
  (`.env`, `node_modules`, `output`, `.git`, `.pages`, `.claude`) so an API key
  in `.env` can no longer be baked into image layers.
- **Tide alerting no longer fires on every normal high tide (was R2).**
  Composite tides severity now uses the CURRENT observed water level and
  thresholds above Crescent City's typical max high tide (WATCH≥6.0 / WARNING≥7.0
  ft MLLW); `noaa_tides` mirror `HIGH_TIDE_ALERT_FT` to 7.0.
- **Marine composite uses the primary buoy (was R4).** `run-alerts.ts` prefers
  station 46027 over `observations[0]` (which could be a ~120NM far-field buoy).
- **NWS `pointInPolygon` handles holes (was R6).** Now per-ring even-odd with
  hole exclusion instead of a single ray-cast over concatenated rings.
- Consolidated `noaa_tsunami` / `nws_weather` / tide source-health URLs to the
  current endpoints and updated the matching docs.

### Still deferred (architecture-only, no behavior change)

- `run-alerts.ts` thin-orchestrator refactor (was M6) — move shaping/freshness/
  source-health classification into `src/alerts/`; behavior-neutral, left for a
  focused refactor pass.
- Unbounded alert JSONL history → shared `IdempotencyStore` with a cap + process
  lock (was R7) across the 5 alert monitors.

### Part 3 — deep refactorings & deferred-item completion (2026-08-01)

- **M6 (run-alerts thin-orchestrator) completed.** Added `src/alerts/composite.ts`
  holding all pure composite-input shaping (`buildCompositeInput`), source-health
  classification (`classifySourceHealth`) and freshness (`isFreshReport`);
  `scripts/run-alerts.ts` is now a thin orchestrator that only runs monitors and
  persists artifacts. Added an advisory run-lock to `run-alerts` to prevent
  overlapping cron runs from double-processing alert events across processes
  (part of R7).
- **Alert analytics timeline is now bounded** (`alert_analytics.ts`): the
  timeline carries at most `maxTimelineEntries` (default 1000) most-recent
  entries so an ever-growing history can't balloon API responses; per-type
  statistics still use the full record set.
- **Domain coverage now counts sections, not refs** (`domains/coverage.ts`): a
  ref like `17.04` matching 40 real sections contributes 40 to
  `referencedCount`/`coveragePct` (previously counted as 1 — underreported).
- **Export artifacts are now atomically written** (`export.ts`): consolidated
  JSON, Markdown, plain-text and CSV all go through `writeJsonAtomic`/
  `writeTextAtomic` (fsync'd temp + rename) instead of plain `writeFile`.
- **Verification report persists sample-outcome data** (`verify.ts`): the live
  re-fetch sample now records `sample.{attempted,passes,mismatches}` in
  `verification-report.json` and is written atomically (was console-only +
  non-atomic).
- **Streaming OpenRouter prompt no longer triple-wraps context**
  (`streaming_rag.ts` + `openrouter.ts`): `streamChat` now honors
  `options.systemPrompt`, and the RAG streamer passes the domain prompt and the
  retrieved context separately so the system message is composed once.
- **Search query stemming is exception-aware** (`gui/search.ts`): query terms now
  use the same `STEMMER_EXCEPTIONS` as the index (e.g. "planning" no longer
  silently stems to "plan" at query time).
- **docker-compose forwards OpenRouter/LLM env** (`LLM_PROVIDER`,
  `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_MAX_REQUESTS`,
  `YT_DLP_TIMEOUT_MS`) so the containerized GUI/curation can use the hosted
  provider.

### Still deferred (this pass)

- Bounded per-monitor alert JSONL (cap file length) + `export.test.ts` +
  `isComplexWord` capitalized-word tuning + news `normalizeUrl` dedup — see
  TODO.md Deferred section.

---

## [2.5.1] — 2026-07-30

### Functional observability and interaction pass (promoted from [Unreleased])

### Added

- Durable weekly pipeline-run envelopes with run IDs, stage durations,
  output-path lineage, commit/runtime metadata, and aggregate source health.
- Machine-readable monthly report companions with UTC period bounds, numeric
  metrics, warnings, and freshness-aware source summaries.
- Curation input fingerprints, prompt versioning, explicit citations, retry
  metadata, duplicate suppression, and changed-source reprocessing.
- RAG query IDs, context fingerprints, grounding flags, retrieval metadata,
  and cancellation-aware streaming results.
- `/api/metadata`, `/api/curation/status`, and `/api/report/latest.json` with
  matching OpenAPI contracts.
- Canonical source registry with normalized URLs, provenance, discovery
  citations, fingerprints, bounded live probes, explicit automation gaps, and
  persistent idempotency state.
- `/api/sources` and `/api/source-discovery`, monthly source-coverage metrics,
  and a Pages source-registry explorer with text/state filters.
- Added GUI Source Coverage drill-downs, automation/status filters, structured
  JSON downloads, and explicit coverage-gap rendering.
- Reworked the local GUI and public Pages landing views into welcome linktrees
  with direct paths to local news, source-grounded summaries, source health,
  municipal code, alerts, analysis, reports, structured data, and official
  local source hubs.
- Added Pages source sorting, per-record inspection, fingerprint copying,
  filtered JSON/CSV downloads, and structured health/content exports.
- Added `/api/sources?format=csv` and matching OpenAPI documentation for flat
  downstream source-coverage workflows.
- Static Pages filtering, refresh controls, shared content search, and
  pipeline/provider/report metadata panels; local GUI chat cancellation.

### Hardened

- **Path traversal**: static file serving now rejects `../` sequences in URL
  pathnames (including percent-encoded variants), preventing directory escape.
- **Request logging**: `request-log.jsonl` entries now carry actual wall-clock
  duration rather than always recording 0ms.
- **LLM config**: unrecognized `LLM_PROVIDER` values emit a clear warning
  rather than silently falling back to Ollama.
- **Type safety**: `as any` casts in `server.ts` replaced with typed
  `NodeJS.ErrnoException`.
- **README**: stale project structure tree replaced with accurate snapshot of
  all 58 source modules, 18 scripts, and supporting directories.

### Verification

- Added deterministic orchestration, metadata-route, report-lineage, and GUI
  interactivity contract tests.

---

## [2.5.0] — 2026-07-24

### Deep functional hardening

- Added typed source-health envelopes for RSS/Atom and EvoGov meeting feeds.
- Added bounded fetches, Atom parsing, normalized deduplication, local HTTP fixtures, and the documented `--no-dedup` flag.
- Added grounded curation provenance, provider/model fields, atomic output writes, and retryable provider failures.
- Added current-state report paths, monthly source highlights, malformed marine-history repair, and availability-aware alert composites.
- Made RAG chat, summarization, streaming, and curation honor the configured Ollama/OpenRouter provider.
- Added fingerprinted Chroma indexing, stale-chunk deletion, YouTube subprocess timeouts, and retryable extraction failures.
- Added `bun run validate` / `bun run release:check` as the authoritative strict TypeScript and deterministic release gate.
- Reconciled OpenAPI v2.5.0, GUI health/provider diagnostics, and current documentation/configuration.
- Added a least-privilege GitHub Pages workflow with atomic bounded snapshot exports, static code search, downloadable health/provenance artifacts, and explicit exclusion of private/runtime logs and Triplicate article content.

---

## [2.4.0] — 2026-07-23

### 🚀 TODO Items Implemented

#### GUI Enhancements (`src/gui/static/index.html`)
- **Loading skeletons**: animated pulse placeholders while section loads
- **Section permalink**: copy-to-clipboard button for deep-link URLs
- **Print view**: CSS `@media print` stylesheet hiding chrome, showing only section text
- **Bookmarks**: toggle bookmark on sections (stored in localStorage), visual star indicator
- **Export section**: download any section as Markdown file
- **Streaming chat UI**: SSE streaming with real-time token rendering, fallback to regular chat
- **Pulse animation**: `@keyframes pulse` for loading states

#### LLM Preflight (`src/llm/index.ts`)
- **Ollama preflight**: checks if running, provides install instructions, checks model availability
- **ChromaDB preflight**: checks collection exists, reports document count, warns if empty
- **Model availability check**: verifies embedding and chat models are pulled

#### New Tests (17 tests, 2 files)
- `tests/content-fixture.test.ts` — 8 tests: HTML parsing, section structure, definition extraction, history parsing, SHA-256 determinism
- `tests/ndbc-parser.test.ts` — 9 tests: NDBC line parsing, unit conversions (m/s→kt, m→ft, C→F), severity classification with realistic buoy data

### 📊 Test Suite
- **454 tests passing** across **38 files** (up from 437 in v2.3.0)
- **0 test failures** (5 pre-existing module import errors)

---

## [2.4.0] — 2026-07-23

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
- **454 tests passing** across **38 files** (up from 413 in v2.4.0)
- New test files: `scraper_utils.test.ts` (18 tests), `v2-endpoints-extended.test.ts` (6 tests)
- **0 test failures** (5 pre-existing module import errors)

---

## [2.4.0] — 2026-07-23

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
- **454 tests passing** across **38 files** (up from 404 in v2.1.0)
- New test file: `v2-endpoints.test.ts` — 9 tests for health, report, search analytics, domain coverage
- **0 test failures** (5 pre-existing module import errors from missing npm deps)

### 📝 Documentation
- OpenAPI spec: 4 new endpoint definitions (v2.4.0, 45+ endpoints total)
- All version references updated to 2.4.0 (README, AGENTS.md, TODO, tests/AGENTS.md, docs/README.md)

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
- `tests/AGENTS.md` — updated with 404 tests across 38 files
- `docs/README.md` and `docs/modules/AGENTS.md` updated

### 📊 Test Suite
- **404 tests passing** across **38 files** (up from 268 in v1.4.0)
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
- RSS news monitor for local and civic North Coast sources
- Government meeting tracker (City Council, Planning Commission, Harbor Commission)
- Analytics dashboard: PCA scatter plot, K-Means clustering, word loadings
- Per-section Ollama summarization
- 208 tests · 0 failures · 19 test files

---

[0.2.0]: https://github.com/docxology/crescent-city-intel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/docxology/crescent-city-intel/releases/tag/v0.1.0

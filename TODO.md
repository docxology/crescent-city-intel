# TODO — Crescent City Intelligence Platform

> Remaining development backlog · v2.1.0 · 404 tests passing · 45 source modules · 33 test files
>
> Priority key: 🔴 Major (new capability) · 🟡 Medium (significant enhancement) · 🟢 Minor (polish/fix)
>
> Jump to: [Phase 1](#phase-1--production-hardening) · [Phase 2](#phase-2--search--query-enhancement) · [Phase 3](#phase-3--rag-pipeline-enhancement) · [Phase 4](#phase-4--monitoring-expansion) · [Phase 5](#phase-5--alert-system--analytics) · [Phase 6](#phase-6--intelligence-domains) · [Phase 7](#phase-7--analytics--reporting) · [Phase 8](#phase-8--marine--harbor-intelligence) · [Phase 9](#phase-9--gui-enhancements) · [Phase 10](#phase-10--data-quality--freshness) · [Phase 11](#phase-11--infrastructure--devops) · [Phase 12](#phase-12--api--openapi) · [Phase 13](#phase-13--new-alert-monitors) · [Phase 14](#phase-14--structured-queries) · [Phase 15](#phase-15--legal-analysis) · [Phase 16](#phase-16--documentation--quality)

---

## Phase 1 — Production Hardening

### 1.1 Rate Limiting
- [x] **Sliding window rate limiter**: `src/api/middleware.ts` — per-IP, per-endpoint, clock injection
- [x] **Test clock injection / sliding window exhaustion**: `tests/middleware_sliding_window.test.ts`
- 🟢 **Add rate limit metrics to `/api/health`**: current usage per-IP, peak, blocked count

### 1.2 Scraper Robustness
- 🟡 **Cloudflare stall detection**: detect Turnstile challenge stuck >10s → log suggestion to retry with `CLOUDFLARE_MAX_WAIT_MS` env var
- 🟡 **Network error retry**: exponential backoff on `fetch` errors mid-scrape (`RATE_LIMIT_MS * 2`, max 3 retries per article)
- 🟡 **HTTP 503/redirect detection**: detect ecode360.com maintenance mode or redirect → bail gracefully with actionable error
- 🟢 **Progress bar**: live terminal progress indicator showing scraped/total/failed counts
- 🟢 **Scrape metrics**: record per-article timing in manifest for performance analysis

### 1.3 Error Boundaries
- 🟡 **GUI error banner**: render user-facing error UI for failed `/api/*` responses in `static/index.html`
- 🟡 **Ollama preflight**: add `ollama check` before `bun run index` — fail fast with install instructions if not running
- 🟡 **ChromaDB preflight**: check collection exists before RAG query; better error message if empty

---

## Phase 2 — Search & Query Enhancement

### 2.1 Search Engine
- [x] **Porter stemmer**: `src/shared/porter_stem.ts` — zero-dep, Steps 1a-5b
- [x] **Stop word filtering**: 42 legal/English stop words in `LEGAL_STOP_WORDS`
- [x] **Synonym expansion**: 28 CA municipal law synonym pairs at query time
- [x] **Stemmer exceptions**: 13 legal compound terms preserved from Porter stemmer
- [x] **Fuzzy matching**: Levenshtein distance + `GET /api/fuzzy?q=` endpoint
- [x] **BM25 fuzzy fallback**: returns `fuzzyCorrections` when BM25 finds 0 results
- 🟢 **Field-level search**: `?field=number` to search only section numbers
- 🟡 **Fuzzy search UI**: show "Did you mean: harbor?" below search box in GUI
- 🟡 **Search analytics**: track most-queried terms from search logs to `output/search-queries.jsonl`
- 🔴 **Semantic search**: use ChromaDB embeddings for concept-based search (not just keyword BM25)

### 2.2 Structured Query Interface
- [x] **Legislative history**: `GET /api/history/:guid` — ordinance chain parsing
- [x] **Section comparison**: `GET /api/compare?guid1=&guid2=` — word-level diff
- [x] **Semantic similarity**: `GET /api/similar/:guid` — cosine + title boost
- [x] **Cross-reference resolution**: `GET /api/cross-refs/validate` — corpus-wide validation
- 🟡 **Section dependency graph**: which sections reference which (network graph visualization)
- 🟢 **Definition tooltips**: hover over defined terms in viewer for tooltip

---

## Phase 3 — RAG Pipeline Enhancement

### 3.1 Query Understanding
- 🟡 **Adaptive topK**: tune retrieval count based on estimated query complexity (short/specific → top-5, broad → top-15)
- 🟡 **Query expansion**: expand with CA municipal law synonyms before embedding
- 🟡 **Reranking**: cross-encode top-20 retrieved chunks → return top-5 (better precision)
- 🟡 **Conversation history**: support multi-turn chat with context window management
- 🟢 **Citation format**: improve source citations to include direct ecode360 deep-links

### 3.2 Streaming & Realtime
- [x] **SSE streaming**: `POST /api/chat/stream` — word-by-word via Server-Sent Events
- 🟢 **Multi-model selection**: `/api/chat?model=llama3:8b` override per request
- 🟡 **Chat history persistence**: `output/chat-history/YYYY-MM-DD.jsonl`
- 🟢 **Streaming chat UI**: connect SSE stream to GUI chat panel for real-time token display

### 3.3 Indexing
- 🟢 **Incremental indexing**: only re-embed changed sections (not full re-index every time)
- 🟡 **Embedding model upgrade**: support `nomic-embed-text-v1.5` (768→1024 dim)
- 🟢 **Collection metadata**: store scrape manifest hash in ChromaDB collection metadata for staleness detection

---

## Phase 4 — Monitoring Expansion

### 4.1 News Monitor
- [x] **4 RSS sources**: Times-Standard, Lost Coast Outpost, Humboldt Times, KIEM-TV NBC Eureka
- [x] **Persistent dedup**: `output/news/seen-ids.json` across runs
- [x] **Keyword filtering**: `--keywords="tsunami,earthquake,harbor"`
- 🟢 **Del Norte Triplicate**: add feed when public RSS becomes available (currently no API)
- 🟢 **KHUM-FM**: add local radio news RSS if available
- 🟡 **Sentiment scoring**: classify each filtered article as positive/negative/neutral
- 🟡 **Aggregated digest**: daily digest of top-5 articles by relevance + sentiment at `output/news/daily-digest.json`
- 🟡 **Slack/webhook alert**: POST to configurable webhook URL when high-urgency civic keywords detected

### 4.2 Government Meeting Monitor
- [x] **3 commission tracker**: City Council, Planning Commission, Harbor Commission
- 🟡 **Agenda item extraction**: parse HTML agendas with `@xmldom/xmldom` to produce structured agenda item list
- 🟡 **Vote record extraction**: parse minutes HTML to record yea/nay/abstain for each resolution
- 🟡 **SHA-256 change detection**: hash each agenda/minutes document → alert on hash change
- 🟡 **Code cross-reference**: keyword-match agenda items to relevant municipal code sections via BM25
- 🟢 **Agenda calendar**: infer next meeting dates from past schedule → proactive reminder
- 🟢 **PDF support**: use pdfparse or Bun WASM to extract text from PDF agendas/minutes

### 4.3 Municipal Code Change Monitor
- [x] **SHA-256 hash comparison**: `src/monitor.ts` — compares saved vs live hashes
- 🟢 **`--full-rescrape` flag**: bypass resume, re-fetch all 242 articles regardless of manifest state
- 🟡 **Diff report**: when hashes mismatch, generate human-readable diff of changed sections → `output/monitor-diff.json`
- 🟡 **Version snapshots**: archive a full JSON snapshot on each change detection run for historical diff comparison
- 🟡 **Change notification**: webhook/email notification when municipal code changes detected
- 🟡 **Staleness detection**: warn if manifest `completedAt` is >30 days old → display GUI banner
- 🟡 **Section diff storage**: when re-scraped section differs, store unified diff at `output/diffs/`

---

## Phase 5 — Alert System & Analytics

### 5.1 Tsunami Alerts (NOAA)
- [x] **NOAA CAP feed monitoring**: `src/alerts/noaa_tsunami.ts`
- [x] **Persistent alert dedup**: `output/alerts/tsunami/history.jsonl`
- 🟡 **CAP polygon geometry**: parse `geometry.coordinates` → compute exact distance from harbor using Haversine
- 🟡 **Evacuation route section lookup**: when tsunami alert fires, automatically surface relevant code sections
- 🟢 **False positive handling**: distinguish "Watch" vs "Warning" vs "Advisory" severity levels

### 5.2 Earthquake Alerts (USGS)
- [x] **USGS GeoJSON feed**: `src/alerts/usgs_earthquake.ts`
- [x] **Haversine distance**: 200 km radius from Crescent City
- [x] **Cascadia tracking**: `isCascadiaEvent(lat, lng)` — flags CSZ epicenters
- [x] **Persistent history**: `output/alerts/earthquake/history.jsonl`
- 🟡 **Tsunami potential scoring**: cross-reference USGS `alert` field (green/yellow/orange/red) with tsunami potential
- 🟡 **Aftershock sequence**: detect aftershock swarms (>3 events in 24h) and summarize

### 5.3 Weather Alerts (NWS)
- [x] **NWS zone CAZ006 monitoring**: `src/alerts/nws_weather.ts`
- [x] **Severity categorization**: advisory / watch / warning
- [x] **Persistent history**: `output/alerts/weather/history.jsonl`
- 🟡 **Coastal flood advisory (CFW) parsing**: extract predicted surge height, timing, affected beaches
- 🟡 **High wind advisory**: track sustained wind + gust values for harbor operations
- 🟢 **Storm track overlay**: map NWS storm track to harbor exposure geometry

### 5.4 Tides (NOAA CO-OPS)
- [x] **48h tide predictions**: `src/alerts/noaa_tides.ts` — station 9419750
- [x] **5 ft MLLW alert threshold**: WARNING level
- 🟢 **Historical tide comparison**: compare current predictions against historical averages

### 5.5 Fishing (CDFW)
- [x] **Crab season calendar**: `src/alerts/cdfw_fishing.ts`
- [x] **Marine bulletin monitoring**: domoic acid / entanglement delays
- 🟢 **Season status history**: track season opening/closing dates year over year

### 5.6 Air Quality (EPA AirNow)
- [x] **Real-time AQI**: `src/alerts/epa_airnow.ts` — PM2.5, ozone, PM10
- [x] **6-level classification**: GOOD → HAZARDOUS
- [x] **Health advisories**: per-level advisory messages
- [x] **Persistent history**: `output/alerts/airquality/history.jsonl`
- 🟢 **AQI trend chart**: GUI widget showing AQI over time
- 🟡 **Wildfire smoke correlation**: cross-reference AQI spikes with CAL FIRE wildfire events

### 5.7 Wildfire (CAL FIRE)
- [x] **Active incident monitoring**: `src/alerts/calfire_wildfire.ts`
- [x] **4-county coverage**: Del Norte, Siskiyou, Humboldt, Trinity
- [x] **Haversine distance**: distance from Crescent City per incident
- [x] **Evacuation order detection**: EMERGENCY severity level
- [x] **Persistent history**: `output/alerts/wildfire/history.jsonl`
- 🟡 **Red flag warning integration**: NWS fire weather warnings for Del Norte County
- 🟢 **Incident map**: GUI widget showing incident locations on a simple map

### 5.8 Marine Buoy (NDBC)
- [x] **3 buoy stations**: 46027, 46022, 46214
- [x] **Wave/wind/temp parsing**: `src/alerts/ndbc_marine.ts`
- [x] **Gale threshold detection**: 15 ft waves / 34 kt wind → WARNING
- [x] **Long-period swell alert**: 15s+ period → WATCH
- [x] **Persistent history**: `output/alerts/marine/history.jsonl`
- 🟢 **Marine conditions trend**: GUI widget showing wave/wind trends over time

### 5.9 Composite Severity & Analytics
- [x] **8-monitor composite**: `src/alerts/severity.ts` — CALM → EMERGENCY
- [x] **Composite persistence**: `output/alerts/composite/current.json`
- [x] **Unified timeline**: `GET /api/alerts/timeline` — all 8 types
- [x] **Recent alerts**: `GET /api/alerts/recent?limit=N`
- [x] **Per-type statistics**: counts, severity distribution, frequency
- [x] **GUI dashboard**: 8-monitor composite panel with severity banner + per-monitor grid
- 🟡 **Alert correlation**: detect earthquake → tsunami warning sequences automatically
- 🟡 **Alert heatmap**: geographic visualization of alert events on a map
- 🟡 **Alert frequency trends**: monthly chart of alert events by type
- 🟢 **Composite status in `/api/health`**: include current alert level in health check

---

## Phase 6 — Intelligence Domains

### 6.1 Coverage & Quality
- [x] **12 domains**: Emergency, Business, Environment, Public Safety, Events, Housing, Tourism, Harbor, Education, Climate, Demographics, Public Health
- [x] **Domain coverage metrics**: `GET /api/domains/coverage` — % of sections cross-referenced
- 🟡 **Expand Emergency domain**: add specific tsunami evacuation route section GUIDs (Title 8 + Title 12)
- 🟡 **External resource validation**: verify all external URLs in domain definitions return 200 (link checker)
- 🟢 **Domain summary auto-generation**: use Ollama to generate a 2-paragraph plain-English summary per domain
- 🟢 **Domain-specific dashboard tabs**: GUI tab per domain with curated sections + external refs

---

## Phase 7 — Analytics & Reporting

### 7.1 Readability
- [x] **Flesch-Kincaid Grade Level**: `src/shared/readability.ts`
- [x] **Flesch Reading Ease**: `src/shared/readability.ts`
- [x] **Gunning Fog Index**: `src/shared/readability.ts`
- [x] **Difficulty classification**: plain / standard / complex / legal
- 🟡 **Readability trend**: compare section readability across ordinance amendment dates (requires historical data)
- 🟢 **Plain-language rewrite suggestions**: use Ollama to draft simplified versions of high-grade-level sections
- 🟡 **Readability heatmap**: color-code TOC tree by grade level (green=plain, red=legal)
- 🟢 **Coverage visualization**: domain coverage donut charts in analytics dashboard

### 7.2 Automated Reporting
- [x] **Monthly civic health report**: `src/monthly_report.ts` — all 8 alert types
- 🟢 **`/api/report/latest`**: serving the most recent monthly report via API
- 🟡 **Word frequency tracking**: compare word frequency across multi-version snapshots (detect emerging legal terms)
- 🟡 **Section longevity**: identify oldest unmodified sections (most likely to be outdated)

### 7.3 Visualization Enhancements
- 🟡 **Alert timeline chart**: chronological chart of all alert events in `output/alerts/`
- 🟡 **RAG query analytics**: frequency chart of most-queried topics from `rag-queries.jsonl`
- 🟢 **Ordinance timeline**: visualize amendment history as a timeline chart

---

## Phase 8 — Marine & Harbor Intelligence

### 8.1 Tides & Marine Conditions
- [x] **NOAA CO-OPS tides**: station 9419750, 48h predictions
- [x] **NDBC buoy observations**: 3 stations, wave/wind/temp
- 🟡 **USCG coastal safety broadcasts**: Sector Humboldt Bay safety messages
- 🟡 **Marine weather**: NOAA offshore forecast zone PZZ455 (Northern California nearshore) parsing
- 🟢 **Swell height**: NOAA buoy data for NDBC Station 46027 → wave height/period

### 8.2 Port & Fisheries Data
- 🟡 **PacFIN landing data**: weekly Dungeness crab and groundfish landings at Crescent City port (ex-vessel value, trip count)
- 🟡 **Vessel AIS tracking**: public AIS feed (MarineTraffic/AISHub) for harbor entry/exit traffic
- 🟢 **Permit cross-reference**: map harbor commission permit sections to active vessel/business license data

### 8.3 Harbor Commission Monitoring
- [x] **Harbor Commission meeting tracker**: `src/gov_meeting_monitor.ts`
- 🟡 **Harbor-specific agenda parser**: dedicated parser for harbor-specific agenda format
- 🟡 **Dredging schedule**: parse harbor dredging permit documents from US Army Corps of Engineers
- 🟢 **Fuel price tracking**: scrape fuel dock published prices for compliance with Title 13 harbor rate schedule

---

## Phase 9 — GUI Enhancements

### 9.1 Intelligence Dashboard
- [x] **🚨 Alerts button + 8-monitor composite dashboard**: severity banner, per-monitor grid, timeline summary
- 🟡 **Alert timeline chart**: chronological visualization of all events (Chart.js)
- 🟡 **Air quality widget**: current AQI with color-coded severity
- 🟡 **Marine conditions panel**: wave height, wind, water temp from buoys
- 🟡 **Wildfire map**: incident locations on a simple map widget
- 🟢 **Alert sparklines**: mini trend lines per monitor in dashboard grid

### 9.2 Search & Query UI
- 🟡 **Fuzzy search suggestions**: show "Did you mean: harbor?" below search
- 🟡 **Section compare view**: side-by-side diff of two sections
- 🟡 **Legislative history panel**: ordinance chain timeline for a section
- 🟢 **Glossary overlay**: searchable definition glossary modal

### 9.3 UI/UX Polish
- 🟢 **Error banners**: user-facing error UI for all failed `/api/*` calls
- 🟢 **Loading skeletons**: replace spinner with skeleton loaders for section viewer
- 🟢 **Section permalink**: copy-to-clipboard button for deep-link URL to a specific section
- 🟢 **Print view**: CSS print stylesheet for individual section printing
- 🟢 **Keyboard navigation**: arrow keys to navigate TOC, `/` to focus search, `Esc` to clear
- 🟢 **Bookmark sections**: local-storage bookmarks list for frequently referenced sections
- 🟢 **Side-by-side compare**: select two sections → diff view of text
- 🟢 **Section annotation**: allow user notes attached to sections (stored in `localStorage` or `output/notes/`)
- 🟢 **Export section**: download a single section as PDF or Markdown from the viewer
- 🟡 **Chat history**: persist RAG chat sessions in `output/chat-history/YYYY-MM-DD.jsonl`
- 🟢 **Readability overlay**: toggle in TOC to color-code sections by grade level
- 🟢 **Coverage overlay**: toggle in TOC to highlight sections cross-referenced by each domain

### 9.4 Performance
- 🟢 **Virtual scroll**: TOC tree with 2,486 nodes causes DOM performance issues — implement virtual rendering
- 🟢 **Search debounce**: 250ms debounce on search input to reduce unnecessary BM25 re-queries
- 🟢 **Section lazy load**: load section text on-demand rather than embedding it all in initial page load

---

## Phase 10 — Data Quality & Freshness

### 10.1 Scrape Freshness
- 🟡 **Staleness detection**: if manifest `completedAt` is >30 days old, display warning banner on GUI
- 🟡 **Auto-rescrape schedule**: optional flag to trigger full re-scrape when weekly-check detects changes
- 🟡 **ecode360 change feed**: monitor ecode360 sitemap.xml or Last-Modified headers
- 🟡 **Section diff storage**: when re-scraped section differs from previous, store unified diff

### 10.2 Data Integrity
- [x] **Section length outliers**: `checkSectionLengthOutliers()` in `utils.ts` — flags <25 / >5,000 word sections
- [x] **Unicode normalization**: `normalizeText()` in `utils.ts` — smart quotes, em dashes, NBSP, ligatures
- [x] **Cross-reference validation**: `validateAllCrossReferences()` — resolution rate + unresolved list
- 🟡 **Cross-reference table validation**: verify all internal section references resolve
- 🟡 **Ordinal sequence check**: detect gaps in section numbering within each article

### 10.3 Content Enhancement
- 🟡 **Legal citation hyperlinking**: auto-link CA Code citations in section text (detected by `legal_parser.ts`)
- 🟡 **Effective date extraction**: parse "Amended by Ord. No. XXXX" patterns → structured date field
- 🟡 **Definition extraction**: build a glossary from defined terms in Title 1 for tooltip hints in the viewer

---

## Phase 11 — Infrastructure & DevOps

### 11.1 Testing
- [x] **404 tests across 33 files**: zero-mock policy, real data
- 🟢 **`tests/browser.test.ts`**: Playwright error handling — page timeout, dead page detection, retry behavior
- 🟢 **`tests/content-fixture.test.ts`**: section extraction from fixture HTML strings (no live browser needed)
- 🟡 **Coverage gate**: integrate `bun test --coverage` with minimum coverage threshold (target: 60%)
- 🟢 **Route handler tests**: add tests for new v2 endpoints (history, compare, similar, citations, glossary, alerts/*)
- 🟢 **NDBC parser unit test**: test `parseNdbcLine()` with fixture data
- 🟢 **CAL FIRE API mock test**: test `classifyWildfireSeverity()` with various incident arrays

### 11.2 Performance
- [x] **ETag caching**: `/api/toc`, `/api/stats`, `/api/readability`, `/api/domains/coverage` return ETag + Cache-Control
- [x] **Section count endpoint**: `/api/stats/count` returns `{count}` without loading all sections
- [x] **Parallel export**: `export.ts` runs all 4 formats concurrently with `Promise.all()`
- 🟢 **Gzip compression**: add `Content-Encoding: gzip` for large JSON API responses

### 11.3 OpenAPI & Documentation Sync
- [x] **OpenAPI 3.0.3 spec**: v2.1.0 with 40+ endpoint definitions
- 🟢 **Generate TypeScript client** from openapi.yaml using `openapi-typescript` or `orval`
- 🟡 **Validate routes against spec**: CI check that every path in openapi.yaml has a corresponding route handler

### 11.4 Scheduling & Automation
- [x] **GitHub Actions workflow**: weekly CI runs all 8 alert monitors + tests
- 🟡 **Docker Compose**: containerize GUI + ChromaDB + Ollama for one-command deployment
- 🟡 **Health check endpoint monitoring**: expose `/api/health` including disk space, index status, last scrape time
- 🟢 **Composite status in health check**: include current 8-monitor alert level in `/api/health`

---

## Phase 12 — API & OpenAPI

### 12.1 Existing Endpoints (40+)
- [x] **Core**: `/api/toc`, `/api/article/:guid`, `/api/section/:guid`, `/api/search`, `/api/sections`
- [x] **Stats**: `/api/stats`, `/api/stats/count`, `/api/health`
- [x] **Chat**: `/api/chat` (GET + POST), `/api/summarize`
- [x] **Analytics**: `/api/analytics/stats`, `/api/analytics/embeddings`
- [x] **Domains**: `/api/domains`, `/api/domain/:id`, `/api/domains/search`, `/api/domain/:id/sections`, `/api/domains/coverage`
- [x] **Readability**: `/api/readability`
- [x] **Monitor**: `/api/monitor/status`, `/api/monitor/history`, `/api/monitor/alerts`
- [x] **TOC**: `/api/toc/breadcrumb`
- [x] **Docs**: `/api/openapi.yaml`, `/api/docs`
- [x] **v2 Structured Queries**: `/api/history/:guid`, `/api/compare`, `/api/similar/:guid`
- [x] **v2 Legal Analysis**: `/api/citations/:guid`, `/api/glossary`, `/api/cross-refs/validate`
- [x] **v2 Alert Analytics**: `/api/alerts/timeline`, `/api/alerts/recent`
- [x] **v2 Per-type Alerts**: `/api/alerts/airquality`, `/api/alerts/wildfire`, `/api/alerts/marine`, `/api/alerts/composite`
- [x] **v2 Streaming**: `POST /api/chat/stream` (SSE)
- [x] **v2 Fuzzy**: `/api/fuzzy`

### 12.2 Future Endpoints
- 🟢 **`/api/report/latest`**: serve most recent monthly civic health report
- 🟢 **`/api/search/analytics`**: most-queried terms from search logs
- 🟡 **`/api/alerts/:type/history`**: paginated history for a specific alert type
- 🟡 **`/api/alerts/correlation`**: detected alert correlations (e.g., earthquake → tsunami)
- 🟢 **`/api/domains/:id/coverage`**: per-domain coverage metrics

---

## Phase 13 — New Alert Monitors (Future)

### 13.1 Completed (8 monitors)
- [x] NOAA Tsunami, USGS Earthquake, NWS Weather, NOAA Tides, CDFW Fishing
- [x] EPA AirNow Air Quality, CAL FIRE Wildfire, NDBC Marine Buoy
- [x] 8-monitor composite severity scoring

### 13.2 Future Monitors
- 🟡 **USCG safety broadcasts**: Sector Humboldt Bay maritime safety messages via govdelivery API
- 🟡 **Red flag warnings**: NWS fire weather warnings for Del Norte County
- 🟡 **Drought monitor**: US Drought Monitor data for Del Norte County
- 🟡 **Power outage tracking**: PG&E PSPS event monitoring for Crescent City
- 🟢 **Smoke forecast**: NOAA HRRR smoke model for wildfire smoke trajectory prediction
- 🟢 **Road closure monitor**: Caltrans QuickMap for US-101 and US-199 closures
- 🟢 **School closure monitor**: Del Norte Unified School District closure alerts

---

## Phase 14 — Structured Queries (Future)

### 14.1 Completed
- [x] Legislative history, section comparison, semantic similarity
- [x] Cross-reference resolution + corpus-wide validation
- [x] Legal citation extraction + ordinance amendment parsing
- [x] Definition glossary builder

### 14.2 Future
- 🟡 **Ordinance timeline visualization**: chronological chart of amendment history per section
- 🟡 **Section dependency graph**: network graph showing which sections reference which
- 🟢 **Definition tooltips**: hover over defined terms in viewer for inline definition tooltip
- 🟡 **Section lineage tracking**: trace how a section evolved through ordinance amendments
- 🟢 **Cross-reference hyperlinking**: auto-link § references in section text to actual sections

---

## Phase 15 — Legal Analysis (Future)

### 15.1 Completed
- [x] CA Code citation extraction (Government, Health & Safety, Penal, Vehicle, etc.)
- [x] Federal law citation extraction (U.S.C.)
- [x] Case law citation extraction (X v. Y pattern)
- [x] Ordinance amendment extraction with dates
- [x] Definition extraction ("shall mean", "means", "is defined as")
- [x] Glossary builder from entire corpus
- [x] Effective date extraction from legislative history

### 15.2 Future
- 🟡 **Legal citation hyperlinking**: auto-link detected citations in section text to external sources
- 🟡 **California Code cross-linking**: link CA Code citations to leginfo.legislature.ca.gov
- 🟡 **Federal law cross-linking**: link U.S.C. citations to uscode.house.gov
- 🟢 **Ordinance chronology**: build a timeline of all ordinance amendments across the entire code
- 🟢 **Definition conflict detection**: find cases where the same term is defined differently in different sections

---

## Phase 16 — Documentation & Quality

### 16.1 Documentation Status
- [x] `README.md` — comprehensive with v2.1.0 badges, feature table, quick start
- [x] `AGENTS.md` — full module inventory, v2.1.0, 404 tests
- [x] `CHANGELOG.md` — v2.1.0 entry with full feature list
- [x] `TODO.md` — this file, comprehensively scoped
- [x] `tests/AGENTS.md` — 33-file test table with accurate counts
- [x] `docs/README.md` — documentation index with v2-intelligence.md
- [x] `docs/modules/AGENTS.md` — includes all v2 modules
- [x] `docs/modules/alerts.md` — fully rewritten for 8 monitors + composite + analytics
- [x] `docs/modules/v2-intelligence.md` — comprehensive v2 module documentation
- [x] `openapi.yaml` — v2.1.0, 40+ endpoints

### 16.2 Documentation TODO
- 🟢 **Update `docs/architecture.md`**: add v2 modules to data flow diagram and dependency graph
- 🟢 **Update `docs/api-reference.md`**: add all v2 exported functions and interfaces
- 🟢 **Update `docs/configuration.md`**: add `AIRNOW_API_KEY` env var
- 🟢 **Update `docs/setup.md`**: rename to "Crescent City Intelligence Platform", add AirNow setup
- 🟢 **Update `docs/roadmap.md`**: consolidate with this TODO.md (currently has stale Phase 1-2 content)
- 🟢 **Update `docs/modules/gui.md`**: add alerts dashboard, streaming chat, fuzzy search
- 🟢 **Update `docs/modules/llm.md`**: add streaming_rag.ts
- 🟢 **Update `docs/modules/shared.md`**: add fuzzy.ts, readability.ts (Gunning Fog)
- 🟢 **Update `docs/modules/domains.md`**: add 3 new domains (Climate, Demographics, Public Health)
- 🟢 **Update `docs/modules/monitoring.md`**: add monthly_report.ts v2 sections
- 🟢 **Update `src/AGENTS.md`**: add new modules to table (structured_queries, legal_parser, alert_analytics, fuzzy)
- 🟢 **Update `src/alerts/AGENTS.md`**: add 3 new monitors to table
- 🟢 **Update `src/shared/AGENTS.md`**: add fuzzy.ts to table
- 🟢 **Update `src/llm/AGENTS.md`**: add streaming_rag.ts to table
- 🟢 **Update `scripts/AGENTS.md`**: note run-alerts.ts now runs 8 monitors

---

_Last updated: July 2026 · v2.1.0 · 404 tests passing · 45 source modules · 33 test files_

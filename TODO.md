# TODO — Crescent City Intelligence Platform

> Upcoming development backlog · v2.2.0 · 413 tests passing · 45 source modules · 34 test files
>
> Priority key: 🔴 Major (new capability) · 🟡 Medium (significant enhancement) · 🟢 Minor (polish/fix)
>
> Jump to: [Phase 1](#phase-1--production-hardening) · [Phase 2](#phase-2--search--query) · [Phase 3](#phase-3--rag-pipeline) · [Phase 4](#phase-4--monitoring-expansion) · [Phase 5](#phase-5--alert-system--analytics) · [Phase 6](#phase-6--intelligence-domains) · [Phase 7](#phase-7--analytics--reporting) · [Phase 8](#phase-8--marine--harbor-intelligence) · [Phase 9](#phase-9--gui-enhancements) · [Phase 10](#phase-10--data-quality--freshness) · [Phase 11](#phase-11--infrastructure--devops) · [Phase 12](#phase-12--api--openapi) · [Phase 13](#phase-13--new-alert-monitors) · [Phase 14](#phase-14--structured-queries--legal-analysis) · [Phase 15](#phase-15--documentation)

---

## Phase 1 — Production Hardening

### 1.1 Rate Limiting & Health
- 🟢 **Rate limit metrics in `/api/health`**: current per-IP usage, peak, blocked count
- 🟡 **Gzip compression**: `Content-Encoding: gzip` for large JSON API responses

### 1.2 Scraper Robustness
- 🟡 **Cloudflare stall detection**: detect Turnstile challenge stuck >10s → retry with `CLOUDFLARE_MAX_WAIT_MS` env var
- 🟡 **Network error retry**: exponential backoff on `fetch` errors mid-scrape (max 3 retries per article)
- 🟡 **HTTP 503/redirect detection**: detect ecode360.com maintenance mode → bail with actionable error
- 🟢 **Progress bar**: live terminal indicator showing scraped/total/failed counts
- 🟢 **Scrape metrics**: per-article timing in manifest for performance analysis

### 1.3 Error Boundaries
- 🟡 **GUI error banner**: render user-facing error UI for failed `/api/*` responses
- 🟡 **Ollama preflight**: `ollama check` before `bun run index` — fail fast with install instructions
- 🟡 **ChromaDB preflight**: check collection exists before RAG query; better error if empty

---

## Phase 2 — Search & Query

### 2.1 Search Engine
- 🟢 **Field-level search**: `?field=number` to search only section numbers
- 🔴 **Semantic search**: use ChromaDB embeddings for concept-based search (not just keyword BM25)
- 🟢 **Search debounce**: 250ms debounce on search input to reduce unnecessary BM25 re-queries

### 2.2 Structured Queries
- 🟡 **Section dependency graph**: network graph showing which sections reference which
- 🟢 **Definition tooltips**: hover over defined terms in viewer for inline tooltip
- 🟢 **Cross-reference hyperlinking**: auto-link § references in section text to actual sections

---

## Phase 3 — RAG Pipeline

### 3.1 Query Understanding
- 🟡 **Adaptive topK**: tune retrieval count based on query complexity (short → top-5, broad → top-15)
- 🟡 **Query expansion**: expand with CA municipal law synonyms before embedding
- 🟡 **Reranking**: cross-encode top-20 retrieved chunks → return top-5
- 🟡 **Conversation history**: multi-turn chat with context window management
- 🟢 **Citation format**: source citations include direct ecode360 deep-links

### 3.2 Streaming & Models
- 🟢 **Multi-model selection**: `/api/chat?model=llama3:8b` override per request
- 🟢 **Streaming chat UI**: connect SSE stream to GUI chat panel for real-time token display

### 3.3 Indexing
- 🟡 **Embedding model upgrade**: support `nomic-embed-text-v1.5` (768→1024 dim)
- 🟢 **Collection metadata**: store scrape manifest hash in ChromaDB collection metadata

---

## Phase 4 — Monitoring Expansion

### 4.1 News Monitor
- 🟢 **Del Norte Triplicate**: add feed when public RSS becomes available
- 🟢 **KHUM-FM**: add local radio news RSS if available
- 🟡 **Sentiment scoring**: classify each filtered article as positive/negative/neutral
- 🟡 **Aggregated digest**: daily top-5 articles by relevance + sentiment at `output/news/daily-digest.json`
- 🟡 **Slack/webhook alert**: POST to configurable webhook when high-urgency civic keywords detected

### 4.2 Government Meeting Monitor
- 🟡 **Agenda item extraction**: parse HTML agendas → structured agenda item list `{item, description, action}`
- 🟡 **Vote record extraction**: parse minutes HTML → yea/nay/abstain per resolution
- 🟡 **SHA-256 change detection**: hash each agenda/minutes document → alert on hash change
- 🟡 **Code cross-reference**: keyword-match agenda items to relevant code sections via BM25
- 🟢 **Agenda calendar**: infer next meeting dates from past schedule → proactive reminder
- 🟢 **PDF support**: extract text from PDF agendas/minutes

### 4.3 Municipal Code Change Monitor
- 🟢 **`--full-rescrape` flag**: bypass resume, re-fetch all 242 articles
- 🟡 **Diff report**: human-readable diff of changed sections → `output/monitor-diff.json`
- 🟡 **Version snapshots**: archive full JSON snapshot on each change detection run
- 🟡 **Change notification**: webhook/email notification when municipal code changes detected
- 🟡 **Section diff storage**: unified diff at `output/diffs/` when re-scraped section differs
- 🟡 **ecode360 change feed**: monitor sitemap.xml or Last-Modified headers
- 🟡 **Auto-rescrape schedule**: trigger full re-scrape when weekly-check detects changes

---

## Phase 5 — Alert System & Analytics

### 5.1 Tsunami (NOAA)
- 🟡 **CAP polygon geometry**: parse `geometry.coordinates` → exact distance from harbor via Haversine
- 🟡 **Evacuation route section lookup**: when tsunami alert fires, surface relevant code sections
- 🟢 **Severity distinction**: distinguish Watch vs Warning vs Advisory more precisely

### 5.2 Earthquake (USGS)
- 🟡 **Tsunami potential scoring**: cross-reference USGS `alert` field with tsunami potential
- 🟡 **Aftershock sequence**: detect aftershock swarms (>3 events in 24h) and summarize

### 5.3 Weather (NWS)
- 🟡 **Coastal flood advisory (CFW) parsing**: extract predicted surge height, timing, affected beaches
- 🟡 **High wind advisory**: track sustained wind + gust values for harbor operations
- 🟢 **Storm track overlay**: map NWS storm track to harbor exposure geometry

### 5.4 Tides (NOAA)
- 🟢 **Historical tide comparison**: compare current predictions against historical averages

### 5.5 Fishing (CDFW)
- 🟢 **Season status history**: track season opening/closing dates year over year

### 5.6 Air Quality (EPA)
- 🟢 **AQI trend chart**: GUI widget showing AQI over time
- 🟡 **Wildfire smoke correlation**: cross-reference AQI spikes with CAL FIRE wildfire events

### 5.7 Wildfire (CAL FIRE)
- 🟡 **Red flag warning integration**: NWS fire weather warnings for Del Norte County
- 🟢 **Incident map**: GUI widget showing incident locations on a simple map

### 5.8 Marine Buoy (NDBC)
- 🟢 **Marine conditions trend**: GUI widget showing wave/wind trends over time

### 5.9 Composite & Analytics
- 🟡 **Alert correlation**: detect earthquake → tsunami warning sequences automatically
- 🟡 **Alert heatmap**: geographic visualization of alert events on a map
- 🟡 **Alert frequency trends**: monthly chart of alert events by type
- 🟢 **Alert sparklines**: mini trend lines per monitor in dashboard grid
- 🟡 **`/api/alerts/:type/history`**: paginated history for a specific alert type
- 🟡 **`/api/alerts/correlation`**: detected alert correlations (e.g., earthquake → tsunami)

---

## Phase 6 — Intelligence Domains

- 🟡 **Expand Emergency domain**: add specific tsunami evacuation route section GUIDs (Title 8 + 12)
- 🟡 **External resource validation**: verify all external URLs in domain definitions return 200
- 🟢 **Domain summary auto-generation**: use Ollama to generate 2-paragraph summary per domain
- 🟢 **Domain-specific dashboard tabs**: GUI tab per domain with curated sections + external refs

---

## Phase 7 — Analytics & Reporting

### 7.1 Readability
- 🟡 **Readability trend**: compare section readability across ordinance amendment dates
- 🟢 **Plain-language rewrite suggestions**: use Ollama to draft simplified versions of high-grade sections
- 🟡 **Readability heatmap**: color-code TOC tree by grade level (green=plain, red=legal)
- 🟢 **Coverage visualization**: domain coverage donut charts in analytics dashboard

### 7.2 Automated Reporting
- 🟡 **Word frequency tracking**: compare word frequency across multi-version snapshots
- 🟡 **Section longevity**: identify oldest unmodified sections (most likely outdated)

### 7.3 Visualization
- 🟡 **Alert timeline chart**: chronological Chart.js visualization of all alert events
- 🟡 **RAG query analytics**: frequency chart of most-queried topics from `rag-queries.jsonl`
- 🟢 **Ordinance timeline**: visualize amendment history as a timeline chart

---

## Phase 8 — Marine & Harbor Intelligence

### 8.1 Marine Conditions
- 🟡 **USCG coastal safety broadcasts**: Sector Humboldt Bay safety messages
- 🟡 **Marine weather**: NOAA offshore forecast zone PZZ455 (Northern California nearshore)
- 🟢 **Swell height**: NOAA buoy data for Station 46027 → wave height/period

### 8.2 Port & Fisheries Data
- 🟡 **PacFIN landing data**: weekly Dungeness crab and groundfish landings at port
- 🟡 **Vessel AIS tracking**: public AIS feed for harbor entry/exit traffic
- 🟢 **Permit cross-reference**: map harbor commission permit sections to active vessel licenses

### 8.3 Harbor Commission
- 🟡 **Harbor-specific agenda parser**: dedicated parser for harbor-specific agenda format
- 🟡 **Dredging schedule**: parse harbor dredging permit documents from USACE
- 🟢 **Fuel price tracking**: scrape fuel dock prices for compliance with Title 13 rate schedule

---

## Phase 9 — GUI Enhancements

### 9.1 Dashboard Widgets
- 🟡 **Air quality widget**: current AQI with color-coded severity (in intel dashboard)
- 🟡 **Marine conditions panel**: wave height, wind, water temp from buoys (in intel dashboard)
- 🟡 **Wildfire map**: incident locations on a simple map widget

### 9.2 UI/UX Polish
- 🟢 **Loading skeletons**: replace spinner with skeleton loaders for section viewer
- 🟢 **Section permalink**: copy-to-clipboard button for deep-link URL
- 🟢 **Print view**: CSS print stylesheet for individual section printing
- 🟢 **Bookmark sections**: local-storage bookmarks list for frequently referenced sections
- 🟢 **Section annotation**: allow user notes attached to sections (localStorage or `output/notes/`)
- 🟢 **Export section**: download a single section as PDF or Markdown from viewer
- 🟢 **Readability overlay**: toggle in TOC to color-code sections by grade level
- 🟢 **Coverage overlay**: toggle in TOC to highlight sections cross-referenced by each domain

### 9.3 Performance
- 🟢 **Virtual scroll**: TOC tree with 2,486 nodes causes DOM performance issues — implement virtual rendering
- 🟢 **Section lazy load**: load section text on-demand rather than embedding in initial page load

---

## Phase 10 — Data Quality & Freshness

### 10.1 Data Integrity
- 🟡 **Ordinal sequence check**: detect gaps in section numbering within each article

### 10.2 Content Enhancement
- 🟡 **Legal citation hyperlinking**: auto-link CA Code citations in section text
- 🟡 **Effective date field**: parse "Amended by Ord. No. XXXX" → structured date field
- 🟡 **Definition tooltip integration**: build glossary from Title 1 for tooltip hints in viewer

---

## Phase 11 — Infrastructure & DevOps

### 11.1 Testing
- 🟢 **`tests/browser.test.ts`**: Playwright error handling — timeout, dead page, retry
- 🟢 **`tests/content-fixture.test.ts`**: section extraction from fixture HTML strings
- 🟡 **Coverage gate**: `bun test --coverage` with minimum threshold (target: 60%)
- 🟢 **NDBC parser unit test**: test `parseNdbcLine()` with fixture data
- 🟢 **CAL FIRE API mock test**: test `classifyWildfireSeverity()` with various incident arrays

### 11.2 OpenAPI & CI
- 🟢 **Generate TypeScript client** from openapi.yaml using `openapi-typescript` or `orval`
- 🟡 **Validate routes against spec**: CI check that every openapi.yaml path has a route handler

### 11.3 Deployment
- 🟡 **Docker Compose**: containerize GUI + ChromaDB + Ollama for one-command deployment
- 🟡 **Health check monitoring**: `/api/health` including disk space, index status, last scrape time

---

## Phase 12 — API & OpenAPI

- 🟡 **`/api/alerts/:type/history`**: paginated history for a specific alert type
- 🟡 **`/api/alerts/correlation`**: detected alert correlations (e.g., earthquake → tsunami)

---

## Phase 13 — New Alert Monitors

- 🟡 **USCG safety broadcasts**: Sector Humboldt Bay maritime safety messages via govdelivery API
- 🟡 **Red flag warnings**: NWS fire weather warnings for Del Norte County
- 🟡 **Drought monitor**: US Drought Monitor data for Del Norte County
- 🟡 **Power outage tracking**: PG&E PSPS event monitoring for Crescent City
- 🟢 **Smoke forecast**: NOAA HRRR smoke model for wildfire smoke trajectory prediction
- 🟢 **Road closure monitor**: Caltrans QuickMap for US-101 and US-199 closures
- 🟢 **School closure monitor**: Del Norte Unified School District closure alerts

---

## Phase 14 — Structured Queries & Legal Analysis

### 14.1 Structured Queries
- 🟡 **Ordinance timeline visualization**: chronological chart of amendment history per section
- 🟡 **Section dependency graph**: network graph showing which sections reference which
- 🟡 **Section lineage tracking**: trace how a section evolved through ordinance amendments

### 14.2 Legal Analysis
- 🟡 **Legal citation hyperlinking**: auto-link detected citations in section text to external sources
- 🟡 **California Code cross-linking**: link CA Code citations to leginfo.legislature.ca.gov
- 🟡 **Federal law cross-linking**: link U.S.C. citations to uscode.house.gov
- 🟢 **Ordinance chronology**: build a timeline of all ordinance amendments across the entire code
- 🟢 **Definition conflict detection**: find cases where same term is defined differently in different sections

---

## Phase 15 — Documentation

### 15.1 Module Docs to Update
- 🟢 **`docs/api-reference.md`**: add all v2 exported functions and interfaces
- 🟢 **`docs/modules/gui.md`**: add alerts dashboard, streaming chat, fuzzy search, intel dashboard
- 🟢 **`docs/modules/llm.md`**: add streaming_rag.ts, incremental indexing, chat history
- 🟢 **`docs/modules/shared.md`**: add fuzzy.ts, readability.ts (Gunning Fog)
- 🟢 **`docs/modules/domains.md`**: add 3 new domains (Climate, Demographics, Public Health)
- 🟢 **`docs/modules/monitoring.md`**: add monthly_report.ts v2 sections (air quality, wildfire, marine)

---

_Last updated: July 2026 · v2.2.0 · 413 tests passing · 45 source modules · 34 test files_

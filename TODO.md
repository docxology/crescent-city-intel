# TODO — Crescent City Intelligence Platform

> Upcoming development backlog · v2.5.0 · 538 tests passing · 51 source modules · 43 test files
>
> Priority key: 🔴 Major (new capability) · 🟡 Medium (significant enhancement) · 🟢 Minor (polish/fix)
>
> Jump to: [Phase 1](#phase-1--production-hardening) · [Phase 2](#phase-2--search--query) · [Phase 3](#phase-3--rag-pipeline) · [Phase 4](#phase-4--monitoring-expansion) · [Phase 5](#phase-5--alert-system--analytics) · [Phase 6](#phase-6--intelligence-domains) · [Phase 7](#phase-7--analytics--reporting) · [Phase 8](#phase-8--marine--harbor) · [Phase 9](#phase-9--gui-enhancements) · [Phase 10](#phase-10--data-quality) · [Phase 11](#phase-11--infrastructure) · [Phase 12](#phase-12--new-alert-monitors) · [Phase 13](#phase-13--structured-queries--legal-analysis) · [Phase 14](#phase-14--documentation)

---

## Phase 1 — Production Hardening

### 1.1 Rate Limiting & Performance
- 🟢 **Rate limit metrics in `/api/health`**: current per-IP usage, peak, blocked count
- 🟡 **Gzip compression**: `Content-Encoding: gzip` for large JSON API responses

### 1.2 Error Boundaries
- 🟡 **GUI error banner**: render user-facing error UI for failed `/api/*` responses
- 🟡 **Ollama preflight**: `ollama check` before `bun run index` — fail fast with install instructions
- 🟡 **ChromaDB preflight**: check collection exists before RAG query; better error if empty
- ✅ **Frontend never sent an API key** (found 2026-07-23, fixed 2026-07-24): server now injects the live key into the served `index.html` (`serveIndexHtml()` in `src/gui/server.ts`) and the frontend's `apiFetch()` wrapper attaches it as `X-API-Key` on every one of its 30 call sites. Verified live in a real browser session: every previously-401ing panel (streaming chat, monitor/alerts, analytics/embeddings, readability, glossary, cross-refs, curated feed, report, domains) now returns 200 and renders real data, while `curl` with no key still correctly 401s — the auth gate itself is untouched, only the browser's own requests were fixed. **Hardened same day**: the key is only injected for loopback/private-LAN requesters (`isTrustedLocalIp()` in `src/api/middleware.ts`) — a remote visitor to a publicly-deployed instance gets the un-substituted placeholder (falls back to unauthenticated `fetch()`, matching pre-fix behavior for them) rather than the real key leaking into page source they can view. Verified: a `curl` with a real loopback socket gets the real key; one spoofing `X-Forwarded-For` to a public IP gets an empty string; a spoofed public IP is still correctly 429'd after its rate limit (10 real requests through, 2 more correctly blocked).
- ✅ **Rate limiter never recognized direct local browser traffic as loopback** (found + fixed 2026-07-24): `resolveIp()` only checked `x-forwarded-for`/`x-real-ip`, which a direct `bun run gui` browser session never sends, so every local user shared one `"unknown"` rate-limit bucket instead of the intended loopback bypass — confirmed live: a real browser session 429'd on `/api/analytics/embeddings` (10 req/hr limit) after a handful of clicks. Fixed by threading Bun's own `server.requestIP(req)` through `applyMiddleware()` as a fallback IP source alongside the proxy headers.
- ✅ **`/api/chat/stream` silently 500'd on every real call** (found + fixed 2026-07-24): the handler called `ollama.healthCheck()`, which does not exist on `src/llm/ollama.ts` (the real export is `isOllamaRunning()`) — every request threw, was caught, and returned a 500 with zero server-side log line (the catch block returned `json(...)` directly without going through `logger.error`), so the failure was invisible in `bun run gui`'s own logs. The GUI's own chat panel silently fell back to the non-streaming `GET /api/chat` and worked, masking the break. Fixed the call-site and added `log.error` to the catch block.

---

## Phase 2 — Search & Query

- 🔴 **Semantic search**: use ChromaDB embeddings for concept-based search (not just keyword BM25)
- 🟢 **Search debounce**: 250ms debounce on search input to reduce unnecessary BM25 re-queries
- 🟡 **Section dependency graph**: network graph showing which sections reference which
- 🟢 **Definition tooltips**: hover over defined terms in viewer for inline tooltip
- 🟢 **Cross-reference hyperlinking**: auto-link § references in section text to actual sections

---

## Phase 3 — RAG Pipeline

- 🟡 **Reranking**: cross-encode top-20 retrieved chunks → return top-5
- 🟡 **Conversation history**: multi-turn chat with context window management
- 🟢 **Citation format**: source citations include direct ecode360 deep-links
- 🟢 **Streaming chat UI**: connect SSE stream to GUI chat panel for real-time token display
- 🟡 **Embedding model upgrade**: support `nomic-embed-text-v1.5` (768→1024 dim)
- 🟢 **Collection metadata**: store scrape manifest hash in ChromaDB collection metadata

---

## Phase 4 — Monitoring Expansion

### 4.1 News Monitor
- ✅ **Redwood Voice**: live, active RSS feed added (`redwoodvoice.org/feed/`, confirmed publishing 2026-07-23)
- 🟢 **Del Norte Triplicate**: no public RSS exists (confirmed 2026-07-23); Cloudflare-protected — see `src/triplicate_monitor.ts` (Playwright-based, not RSS)
- 🟢 **KHUM-FM**: add local radio news RSS if available
- 🟡 **Sentiment scoring**: classify each filtered article as positive/negative/neutral
- 🟡 **Aggregated digest**: daily top-5 articles by relevance + sentiment
- 🟡 **Slack/webhook alert**: POST to webhook when high-urgency civic keywords detected

### 4.2 Government Meeting Monitor
- ✅ **All 3 configured agenda URLs were dead (found + fixed 2026-07-24)**: `crescentcity.org/government/{city-council,planning-commission,harbor-commission}/agendas` all 404'd — the city migrated to the EvoGov CMS, whose `/meetings` calendar is JS-rendered (no meeting data in the static HTML at all). Found the real same-origin JSON API the widget itself calls (`GET /meetings/get_list?selected_calendar_ids=...`) by capturing network traffic with Playwright, and rewrote `fetchGovMeetings()` in `src/gov_meeting_monitor.ts` to call it directly (no browser automation needed at runtime — it's a plain JSON endpoint). City Council and Planning Commission share one underlying calendar and are now distinguished by matching `title` (confirmed against a full year of real data); a live run pulled 6 real items with working agenda/minutes PDF links (verified one resolves: `https://www.crescentcity.org/meetingfiles/.../agendas/....pdf` → 200, `application/pdf`). **Harbor Commission has no known digital agenda source right now** — absent from the EvoGov widget, and its own domain `crescentcityharbor.com` no longer resolves in DNS (confirmed live) — kept in `GOV_SOURCES` so it filters and honestly returns 0 rather than 404ing, but finding a real source needs manual research, not more scraping code.
- 🟡 **Agenda item extraction**: parse HTML agendas → structured agenda item list
- 🟡 **Vote record extraction**: parse minutes HTML → yea/nay/abstain per resolution
- 🟡 **SHA-256 change detection**: hash each agenda/minutes document → alert on hash change
- 🟡 **Code cross-reference**: keyword-match agenda items to relevant code sections via BM25
- 🟢 **Agenda calendar**: infer next meeting dates from past schedule → proactive reminder
- 🟢 **PDF support**: extract text from PDF agendas/minutes

### 4.4 YouTube Meeting Transcripts (✅ shipped 2026-07-23)
- ✅ **`src/youtube_monitor.ts`**: lists `youtube.com/c/CityofCrescentCityCalifornia`, extracts auto-captions via `yt-dlp`, indexes into ChromaDB with `sourceType: "youtube_transcript"` citations distinct from municipal code.
- 🟡 **Extractor-args maintenance**: the `player_client=android,web_safari` yt-dlp flag was empirically required 2026-07-23 to clear YouTube's current JS challenge — this WILL need revisiting as YouTube's extraction internals evolve. `extraction_failed` status is logged distinctly from `unavailable` (no captions) precisely so this regression is visible rather than silently read as "no new videos."
- 🟢 **Backfill older meetings**: current run defaults to the 15 most recent channel videos; a one-time deeper backfill pass would need channel pagination beyond `--playlist-end`.
- 🟢 **Cleaner transcript reconstruction**: `parseVtt`'s growing-caption collapse handles simple prefix-extension groups well but leaves some residual near-duplication on more complex caption patterns — acceptable for RAG search, not a polished human-readable transcript.

### 4.5 Curation Pipeline (✅ shipped 2026-07-23)
- ✅ **`src/curation.ts`** / `bun run curate`: LLM-summarizes + domain-tags new items across news/gov-meetings/youtube via the configured provider (Ollama default, OpenRouter opt-in). `/api/curated` + GUI "Curated Feed" tab.
- 🟡 **Triplicate not yet wired into curation**: `gatherCurationInputs()` covers news/gov_meetings/youtube; adding Triplicate is a small follow-up (same `gatherXItems()` pattern).
- ✅ **OpenRouter default model/cap**: default model is `inclusionai/ling-3.0-flash:free` (free tier, changed from the original `openai/gpt-4o-mini` placeholder so an unset `OPENROUTER_MODEL` never silently incurs cost), cap 100 req/run.
- ✅ **Curation burned through the free-tier rate limit on any real batch (found + fixed 2026-07-24)**: summarizing items back-to-back with zero spacing hit OpenRouter's free-model ~20 req/min cap within seconds on anything but a tiny batch — confirmed live: a 34-item batch (fresh Triplicate + YouTube + gov-meetings items from a single verification pass) got a 429 on every item after the first. Added `llmConfig.openrouterMinRequestIntervalMs` (default 3100ms, env-overridable via `OPENROUTER_MIN_REQUEST_INTERVAL_MS`) and a conditional delay in `runCuration()`'s loop — only when `provider=openrouter`; Ollama has no external rate limit so its path is untouched.
- 🟢 **Facebook**: deliberately not built this pass — no sanctioned automated-access path for a hobby project (ToS prohibits scraping; Graph API Page Public Content Access needs Meta App Review). Revisit only if a real content gap surfaces that no other source covers.

### 4.3 Municipal Code Change Monitor
- 🟢 **`--full-rescrape` flag**: bypass resume, re-fetch all 242 articles
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
- ✅ **Tides + fishing never actually ran under `bun run alerts`/`alerts:all`, and the composite severity banner always ignored them (found + fixed 2026-07-24)**: `scripts/run-alerts.ts` called `m.runTidesMonitor?.()`/`m.runFishingMonitor?.()` via dynamic import — those functions never existed (the real exports are `monitorTides`/`monitorFishing`), so the optional-call silently evaluated to `undefined` every run, wrapped in an empty `.catch(() => {})` that swallowed the mismatch with zero logging. Separately, even had they run, the composite-severity calculation fed them static `{available:false}`/`{closureActive:false}` stubs rather than reading their real output. Net effect: the top-level CALM/WATCH/WARNING banner could never reflect an actual high-tide or fishery-closure condition. Fixed both — real monitors now run with proper error logging, and their live reports feed the composite calc directly. Verified live: a real 6.8 ft predicted high tide now correctly produces `"level": "WARNING", "reason": "Tides: 🔴 High tide 6.8 ft MLLW"` in `output/alerts/composite/current.json` (previously would have stayed `CALM` regardless).
- 🟡 **Alert heatmap**: geographic visualization of alert events on a map
- 🟡 **Alert frequency trends**: monthly chart of alert events by type
- 🟢 **Alert sparklines**: mini trend lines per monitor in dashboard grid
- 🟡 **`/api/alerts/:type/history`**: paginated history for a specific alert type

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

## Phase 8 — Marine & Harbor

- 🟡 **USCG coastal safety broadcasts**: Sector Humboldt Bay safety messages
- 🟡 **Marine weather**: NOAA offshore forecast zone PZZ455 (Northern California nearshore)
- 🟢 **Swell height**: NOAA buoy data for Station 46027 → wave height/period
- 🟡 **PacFIN landing data**: weekly Dungeness crab and groundfish landings at port
- 🟡 **Vessel AIS tracking**: public AIS feed for harbor entry/exit traffic
- 🟢 **Permit cross-reference**: map harbor commission permit sections to active vessel licenses
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
- ✅ **Nav tab clarity refactor** (2026-07-24): the old 4-button nav (Analytics / Alerts / 🧠 Intelligence / Chat) flattened 12 unrelated things — code-analysis tools, actual news/feed content, dev tooling, and a duplicate alert timeline — under one vague "Intelligence" label. Replaced with 6 clearly-scoped top-level tabs: 📖 Code, 📊 Code Analytics (Stats, Readability, Glossary, Cross-Refs, Domains, Compare, Legislative History), 📰 News & Feeds (Civic Dashboard, News Feed, Monthly Report — the actual news/meeting/YouTube content), 🚨 Alerts (8-monitor grid + timeline merged, no more duplicate), 💬 Chat, 🔌 Developer (API Explorer, Search Analytics). Also fixed two real bugs this surfaced: asymmetric overlay-closing (only 1 of 4 old buttons closed its siblings) and a hardcoded `--header-height` that didn't account for the dynamic stale-data/alert banners, making nav buttons unclickable behind an open overlay when a banner was showing. See `docs/modules/gui.md` Navigation section.
- 🟢 **Loading skeletons**: replace spinner with skeleton loaders for section viewer
- 🟢 **Section permalink**: copy-to-clipboard button for deep-link URL
- 🟢 **Print view**: CSS print stylesheet for individual section printing
- 🟢 **Bookmark sections**: local-storage bookmarks list for frequently referenced sections
- 🟢 **Section annotation**: allow user notes attached to sections (localStorage or `output/notes/`)
- 🟢 **Export section**: download a single section as PDF or Markdown from viewer
- 🟢 **Readability overlay**: toggle in TOC to color-code sections by grade level
- 🟢 **Coverage overlay**: toggle in TOC to highlight sections cross-referenced by each domain

### 9.3 Performance
- 🟢 **Virtual scroll**: TOC tree with 2,486 nodes causes DOM performance issues
- 🟢 **Section lazy load**: load section text on-demand rather than embedding in initial page load

---

## Phase 10 — Data Quality

### 10.1 Data Integrity
- 🟡 **Ordinal sequence check refinement**: improve gap detection accuracy

### 10.2 Content Enhancement
- 🟡 **Legal citation hyperlinking**: auto-link CA Code citations in section text
- 🟡 **Effective date field**: parse "Amended by Ord. No. XXXX" → structured date field
- 🟡 **Definition tooltip integration**: build glossary from Title 1 for tooltip hints in viewer

---

## Phase 11 — Infrastructure

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
- 🟡 **Health check monitoring**: `/api/health` including disk space, index status, last scrape time

---

## Phase 12 — New Alert Monitors

- 🟡 **USCG safety broadcasts**: Sector Humboldt Bay maritime safety messages
- 🟡 **Red flag warnings**: NWS fire weather warnings for Del Norte County
- 🟡 **Drought monitor**: US Drought Monitor data for Del Norte County
- 🟡 **Power outage tracking**: PG&E PSPS event monitoring for Crescent City
- 🟢 **Smoke forecast**: NOAA HRRR smoke model for wildfire smoke trajectory prediction
- 🟢 **Road closure monitor**: Caltrans QuickMap for US-101 and US-199 closures
- 🟢 **School closure monitor**: Del Norte Unified School District closure alerts

---

## Phase 13 — Structured Queries & Legal Analysis

- 🟡 **Ordinance timeline visualization**: chronological chart of amendment history per section
- 🟡 **Section dependency graph**: network graph showing which sections reference which
- 🟡 **Section lineage tracking**: trace how a section evolved through ordinance amendments
- 🟡 **Legal citation hyperlinking**: auto-link detected citations in section text to external sources
- 🟡 **California Code cross-linking**: link CA Code citations to leginfo.legislature.ca.gov
- 🟡 **Federal law cross-linking**: link U.S.C. citations to uscode.house.gov
- 🟢 **Ordinance chronology**: build a timeline of all ordinance amendments across the entire code

---

## Phase 14 — Documentation

- 🟢 **`docs/api-reference.md`**: add all v2 exported functions and interfaces
- 🟢 **`docs/modules/gui.md`**: add alerts dashboard, streaming chat, fuzzy search, intel dashboard
- 🟢 **`docs/modules/llm.md`**: add streaming_rag.ts, incremental indexing, chat history, adaptive topK
- 🟢 **`docs/modules/shared.md`**: add fuzzy.ts, readability.ts (Gunning Fog)
- 🟢 **`docs/modules/domains.md`**: add 3 new domains (Climate, Demographics, Public Health)
- 🟢 **`docs/modules/monitoring.md`**: add monthly_report.ts v2 sections + diff report + snapshots

---

_Last updated: July 2026 · v2.5.0 · 538 tests passing · 51 source modules · 43 test files_

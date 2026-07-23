# TODO — Crescent City Intelligence Platform

> Remaining development backlog · v2.0.0 · 329 tests passing

---

## Phase 11 — RAG Pipeline Enhancement

### 11.1 Query Understanding
- [ ] **Adaptive topK**: tune retrieval count based on estimated query complexity
- [ ] **Query expansion**: expand with CA municipal law synonyms before embedding
- [ ] **Reranking**: cross-encode top-20 retrieved chunks → return top-5
- [ ] **Conversation history**: support multi-turn chat with context window

### 11.2 Streaming & Realtime
- [x] **SSE streaming**: `POST /api/chat/stream` — word-by-word via Server-Sent Events
- [ ] **Multi-model selection**: `/api/chat?model=llama3:8b` override per request
- [ ] **Chat history persistence**: `output/chat-history/YYYY-MM-DD.jsonl`

---

## Phase 12 — Structured Queries (v2.0)

### 12.1 Completed
- [x] **Legislative history**: `GET /api/history/:guid` — ordinance chain parsing
- [x] **Section comparison**: `GET /api/compare?guid1=&guid2=` — word-level diff
- [x] **Semantic similarity**: `GET /api/similar/:guid` — cosine + title boost
- [x] **Citation extraction**: `GET /api/citations/:guid` — CA Code, U.S.C., case law
- [x] **Glossary builder**: `GET /api/glossary` — definition extraction from corpus
- [x] **Cross-reference resolution**: internal § X.XX.XXX resolution

### 12.2 Future
- [ ] **Ordinance timeline**: visualize amendment history as a timeline chart
- [ ] **Section dependency graph**: which sections reference which (network graph)
- [ ] **Definition tooltips**: hover over defined terms in viewer for tooltip

---

## Phase 13 — New Alert Monitors (v2.0)

### 13.1 Completed
- [x] **EPA AirNow air quality**: PM2.5, ozone, PM10 — `src/alerts/epa_airnow.ts`
- [x] **CAL FIRE wildfire**: Del Norte + surrounding counties — `src/alerts/calfire_wildfire.ts`
- [x] **NDBC marine buoy**: 3 stations, wave/wind/temp — `src/alerts/ndbc_marine.ts`
- [x] **8-monitor composite severity**: `src/alerts/severity.ts` expanded

### 13.2 Future
- [ ] **USCG safety broadcasts**: Sector Humboldt Bay maritime safety messages
- [ ] **Red flag warnings**: NWS fire weather warnings for Del Norte County
- [ ] **Drought monitor**: US Drought Monitor data for Del Norte County
- [ ] **Power outage tracking**: PG&E PSPS event monitoring for Crescent City

---

## Phase 14 — Search Enhancement (v2.0)

### 14.1 Completed
- [x] **Fuzzy matching**: Levenshtein distance + `GET /api/fuzzy?q=` endpoint
- [x] **Typo correction**: vocabulary-based fuzzy correction with similarity scores

### 14.2 Future
- [ ] **Field-level search**: `?field=number` to search only section numbers
- [ ] **Search analytics**: track most-queried terms from search logs
- [ ] **Semantic search**: use ChromaDB embeddings for concept-based search

---

## Phase 15 — Alert Analytics (v2.0)

### 15.1 Completed
- [x] **Unified timeline**: `GET /api/alerts/timeline` — all 8 monitor types
- [x] **Recent alerts**: `GET /api/alerts/recent?limit=N`
- [x] **Per-type statistics**: counts, severity distribution, frequency

### 15.2 Future
- [ ] **Alert correlation**: detect earthquake → tsunami warning sequences
- [ ] **Alert heatmap**: geographic visualization of alert events
- [ ] **Alert frequency trends**: monthly chart of alert events by type
- [ ] **Dashboard widget**: GUI panel with composite status + sparklines

---

## Phase 16 — Data Quality

### 16.1 Content Enhancement
- [ ] **Legal citation hyperlinking**: auto-link CA Code citations in section text
- [ ] **Effective date field**: parsed from legislative history → structured date
- [ ] **Cross-reference validation**: verify all § references resolve to actual sections

### 16.2 Freshness
- [ ] **Staleness detection**: warn if manifest >30 days old
- [ ] **Section diff storage**: unified diffs when re-scraped sections change
- [ ] **Version snapshots**: archive full JSON on each change detection run

---

## Phase 17 — GUI Enhancements

### 17.1 Intelligence Dashboard
- [ ] **8-monitor alert panel**: composite status with per-monitor breakdown
- [ ] **Alert timeline chart**: chronological visualization of all events
- [ ] **Air quality widget**: current AQI with color-coded severity
- [ ] **Marine conditions panel**: wave height, wind, water temp from buoys
- [ ] **Wildfire map**: incident locations on a simple map widget

### 17.2 Search & Query UI
- [ ] **Fuzzy search suggestions**: show "Did you mean: harbor?" below search
- [ ] **Section compare view**: side-by-side diff of two sections
- [ ] **Legislative history panel**: ordinance chain timeline for a section
- [ ] **Glossary overlay**: searchable definition glossary modal

---

_Last updated: July 2026 · v2.0.0 · 329 tests passing_

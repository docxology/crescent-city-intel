# Roadmap — The Quadruplicate

> For the full detailed backlog with priority tags, see [TODO.md](../TODO.md).
> This page provides a high-level strategic overview.

## Completed Milestones

### v1.0 — Core Pipeline (2026-03)
- Playwright scraper with Cloudflare bypass
- SHA-256 verification engine
- Multi-format exporter (JSON, Markdown, text, CSV)
- Bun.serve() web viewer with TOC tree
- BM25 full-text search with Porter stemmer
- Ollama RAG chat with ChromaDB

### v1.4 — Intelligence Layer (2026-03)
- 9 civic intelligence domains with code cross-references
- 5 alert monitors (tsunami, earthquake, weather, tides, fishing)
- RSS/Atom news monitor (configured sources with per-source health)
- Government meeting tracker (3 commissions)
- Flesch-Kincaid readability scoring
- Domain coverage metrics
- Monthly civic health report
- Sliding-window rate limiter + API key auth
- GitHub Actions weekly CI
- 268 tests across 20 files

### v2.0 — Comprehensive Intelligence Platform (2026-07)
- 3 new alert monitors (EPA AirNow, CAL FIRE, NDBC Marine)
- Composite severity scoring expanded from eight to thirteen monitors (fourteen as of 2026-09)
- Structured query engine (legislative history, section diff, semantic similarity)
- Legal citation parser (CA Code, U.S.C., case law, ordinance amendments)
- Definition glossary builder
- Fuzzy typo-tolerant search (Levenshtein)
- Streaming RAG via Server-Sent Events
- Alert analytics (unified timeline, per-type statistics)
- 3 new intelligence domains (Climate, Demographics, Public Health — 12 total)
- Cross-reference validation engine
- 16 new API endpoints (40+ total)
- Renamed from `crescent-city` → `crescent-city-intel`

### v2.1 — Integration & Documentation (2026-07)
- All monitors — thirteen at the time — wired end-to-end through orchestrators + CI
- BM25 fuzzy fallback integrated into search response shape
- 3 new domains integrated into monthly report
- GUI alerts dashboard (alert composite panel)
- OpenAPI spec expanded to 40+ endpoints
- 56 new tests (404 total, 38 files)
- All documentation audited and updated
- `run.sh` interactive menu expanded for the alert monitors
- Bug fix: alert_analytics fishing/tides path resolution

## Future Direction

> Status audit 2026-09-08 against the implemented tree. Earlier drafts listed
> items under "Open" that had already shipped; those are marked ✅ below so the
> open set stays honest, and the audit is re-run whenever this section is
> touched rather than trusted from the last edit.

### Shipped since the last roadmap audit (previously listed here)

- ✅ Fuzzy search suggestions in the GUI (debounced `/api/fuzzy` on empty results)
- ✅ Section compare view + glossary tabs (intel tabs)
- ✅ gzip compression (`tests/gui-compress.test.ts`), search-input debounce
- ✅ NDBC parser tests (`tests/ndbc-parser.test.ts`)
- ✅ Semantic search via ChromaDB embeddings with BM25 fallback, RAG reranking, conversation history
- ✅ Meeting agenda-item extraction, vote-record parsing, agenda/minutes SHA-256 drift reports
- ✅ Alert heatmap + per-type frequency trends (GUI `alert-trends-shell`)
- ✅ Drought, PSPS/power-outage, red-flag monitors; Docker Compose; coverage gate; route-spec CI validation
- ✅ Meeting-minutes → municipal-code BM25 cross-references (`src/agenda_crossref.ts`)
- ✅ NWS Coastal Waters Forecast monitor (CWF PZZ450 — the live product renumbered the zone the roadmap called PZZ455)
- ✅ **Alert correlation detection across monitors** (`src/alert_correlation.ts`,
  `GET /api/alerts/correlation`) — the 2026-09-03 pass shipped it; this section
  still listed it as Medium-term open until the 2026-09-05 audit.
- ✅ **RAG adaptive topK and query expansion** (`adaptiveTopK` / `expandQuery` in
  `src/llm/rag.ts`) — likewise shipped, likewise still listed as open.
- ✅ **Definition conflict detection** (`GET /api/definitions/conflicts`).
- ✅ **Ordinance chronology / lineage** — data layer in
  `src/ordinance_chronology.ts`; the visualization it was waiting on shipped
  2026-09-05 (Code Analytics → 🏛️ Ordinance Timeline).
- ✅ **Section dependency graph** (`src/section_graph.ts`,
  `GET /api/sections/graph`) with a deterministic radial ego-network drawing in
  the GUI. A whole-corpus radial plot is deliberately not drawn: at this node
  count it would show shape without meaning.
- ✅ **Word-frequency and section-longevity views** (`src/word_frequency.ts`,
  `src/section_longevity.ts`, `GET /api/lexicon/frequency`,
  `GET /api/sections/longevity`) with GUI panels.
- ✅ **Multi-model LLM selection UI** — `/api/chat` had accepted a per-request
  `model` override for some time with no way to discover a valid value;
  `GET /api/llm/models` is that discovery surface and the chat panel now
  carries a picker wired to both the streaming and fallback paths.
- ✅ **Civic insights reached a consumer** — `src/insights.ts` computed a
  cross-artifact trend brief that only ever reached disk via a CLI script;
  `GET /api/insights` and the News & Feeds → 🔮 Civic Insights panel surface it.
- ✅ **Readability trend/heatmap panels** — the blocker was history storage;
  `src/readability_history.ts` landed the bounded JSONL run history (10k cap),
  `GET /api/readability/history` serves it, and the GUI Readability tab renders
  the trend. The storage decision is made: bounded JSONL, not a database.
- ✅ **Virtual scroll for long section lists** — search results (>24 items)
  and the glossary table (>40 rows) render through `assets/virtual-list.js`.
- ✅ **USCG Broadcast Notice to Mariners monitor** (`src/alerts/uscg_broadcasts.ts`)
  — the 15th monitor (8 core + 7 extended): District 11 BNM listing, no API
  key, North Coast relevance filter, feeding the composite severity and the
  GUI trend roster.

### Open

Item-level tracking lives in [TODO.md](../TODO.md), which holds the
reconciled open set with acceptance criteria — this section no longer
duplicates it. Strategically, the remaining work clusters into: live-source
monitor expansion (permits/dredging/fuel, PacFIN, AIS), blocked on owner
decisions about data budgets rather than engineering; genuinely per-article
incremental re-embedding (the whole-corpus fingerprint check shipped
2026-09-08); and the deferred GUI/UX set. Keeping the architecture diagram
and API reference in sync with each release remains the standing short-term
obligation.

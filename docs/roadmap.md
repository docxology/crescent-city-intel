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

> Status audit 2026-09-03 against the implemented tree — several "future"
> items from earlier drafts shipped since; they are marked ✅ so the open
> set stays honest.

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

### Open

#### Short-term (Minor)

- Docs: keep architecture diagram and API reference in sync with each release
- Performance: virtual scroll for very long section lists

#### Medium-term

- Alert: correlation detection across monitors (co-occurrence of hazard events)
- RAG: adaptive topK, query expansion
- Marine: PacFIN landing data, AIS vessel tracking

#### Long-term (Major)

- Section dependency graph (network visualization)
- Ordinance timeline visualization; ordinance chronology/lineage
- New monitors: USCG broadcasts, PZZ455, permits/dredging/fuel
- Multi-model LLM selection UI (provider selection exists; per-request model picker does not)
- Incremental indexing; definition conflict detection
- GUI: readability trend/heatmap panels, word-frequency and section-longevity views, AQ widget,
  wildfire map, annotation overlays, structured-query pages (scoped in `docs/`)

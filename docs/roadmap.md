# Roadmap — Crescent City Intelligence Platform

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
- RSS news monitor (4 sources)
- Government meeting tracker (3 commissions)
- Flesch-Kincaid readability scoring
- Domain coverage metrics
- Monthly civic health report
- Sliding-window rate limiter + API key auth
- GitHub Actions weekly CI
- 268 tests across 20 files

### v2.0 — Comprehensive Intelligence Platform (2026-07)
- 3 new alert monitors (EPA AirNow, CAL FIRE, NDBC Marine)
- 8-monitor composite severity scoring
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
- All 8 monitors wired end-to-end through orchestrators + CI
- BM25 fuzzy fallback integrated into search response shape
- 3 new domains integrated into monthly report
- GUI alerts dashboard (8-monitor composite panel)
- OpenAPI spec expanded to 40+ endpoints
- 56 new tests (404 total, 38 files)
- All documentation audited and updated
- `run.sh` interactive menu expanded for 8 monitors
- Bug fix: alert_analytics fishing/tides path resolution

## Future Direction

### Short-term (Minor)
- GUI: fuzzy search suggestions, section compare view, glossary overlay
- Docs: update architecture diagram, API reference, configuration, setup
- Tests: NDBC parser, route handler, CAL FIRE API mock
- Performance: gzip compression, virtual scroll, search debounce

### Medium-term
- RAG: adaptive topK, query expansion, reranking, conversation history
- Monitoring: agenda item extraction, vote record parsing, change diff reports
- Alert: correlation detection, heatmap, frequency trends
- Marine: PacFIN landing data, AIS vessel tracking, marine weather forecasts
- Infrastructure: Docker Compose, coverage gate, route-spec CI validation

### Long-term (Major)
- Semantic search via ChromaDB embeddings
- Section dependency graph (network visualization)
- Ordinance timeline visualization
- New monitors: USCG broadcasts, red flag warnings, drought, power outages
- Multi-model LLM selection
- Incremental indexing
- Definition conflict detection

# GUI Module

## `src/gui/server.ts` — HTTP Server

Lightweight `Bun.serve()` server on port 3000 (configurable via `PORT` env var).

- Applies the full middleware chain (`applyMiddleware`) before routing.
- Routes `/api/*` requests to `handleApiRoute()`.
- Serves static files from `src/gui/static/`.
- Falls back to `index.html` for SPA routing.
- Pre-loads search index on startup via `initSearch()`.

---

## `src/gui/routes.ts` — API Routes

All API endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`).

LLM-dependent routes (`/api/chat`, `/api/analytics/*`, `/api/summarize`) degrade gracefully: if the selected chat provider, Ollama embeddings, or ChromaDB are unavailable they return `503 Service Unavailable` rather than crashing. `/api/health` reports dependency status separately from `sourceCoverage`, which contains present/missing counts and named source records. An unavailable feed is never rendered as calm, and a missing feed does not make liveness `degraded` by itself.

The GUI uses the same 18-source health contract as the Pages exporter. If a
monitor has not emitted a health record, `/api/health`, `/api/metadata`, and
`/api/sources` expose a named unavailable coverage record rather than treating
the missing row as evidence that the source was checked.

### Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| GET | `/api/health` | Liveness and dependency/source health — returns status, timestamp, provider preflight, embedding/vector-store metadata, and source diagnostics |
| GET | `/api/toc` | Full TOC tree (JSON) |
| GET | `/api/article/:guid` | Single article with all sections |
| GET | `/api/section/:guid` | Single section with parent article metadata |
| GET | `/api/search?q=...&limit=N` | Full-text search (default limit: 20) |
| GET | `/api/stats` | Municipality stats (article/section counts, timestamps) |
| GET | `/api/domains` | All 12 intelligence domains (from `domains.ts`) |
| GET | `/api/monitor/status` | Latest monitor report `output/monitor-report.json` |
| GET | `/api/monitor/alerts` | Latest persisted output from each alert monitor, composite level, and alert source-health artifact |
| GET | `/api/alerts/timeline` | Bounded unified timeline plus per-type statistics across all eight monitors |
| GET | `/api/alerts/{type}/history?limit=&offset=` | Bounded paginated history for one canonical alert type |
| GET | `/api/metadata` | Build, provider, artifact, and source-lineage metadata |
| GET | `/api/sources` | Canonical source registry and discovery joins; add `?format=csv` for a flat download |
| GET | `/api/source-discovery` | Fingerprinted source coverage report and explicit gaps |
| GET | `/api/chat?q=...` | RAG query (requires Ollama + ChromaDB) |
| GET | `/api/analytics/overview` | Shared deterministic cross-surface overview: current signal, source gaps, alerts, content counts, pipeline metadata, and optional LLM executive summary |
| GET | `/api/analytics/stats` | Code statistics (word counts, title breakdown) |
| GET | `/api/analytics/embeddings` | PCA projection of embedding vectors |
| POST | `/api/summarize` | AI-generated section summary body: `{text, number, title}` |
| GET | `/api/openapi.yaml` | OpenAPI 3.0 specification |
| GET | `/api/docs` | Swagger UI |

### Error Handling

| Code | Cause |
| :--- | :--- |
| 400 | Missing required parameters |
| 404 | Resource not found |
| 503 | External service unavailable (Ollama/ChromaDB) |
| 500 | Internal processing error |

---

## `src/gui/search.ts` — Search Engine

In-memory full-text search across all municipal code sections.

### Exports

| Function | Signature | Description |
| :--- | :--- | :--- |
| `initSearch` | `() → Promise<void>` | Load all sections into memory (singleton; subsequent calls no-op) |
| `search` | `(query, limit?) → SearchResult[]` | Keyword search with relevance ranking |
| `getIndexedCount` | `() → number` | Current number of indexed sections |

### Ranking Algorithm

| Match Type | Score Boost |
| :--- | :--- |
| Section number prefix | +10 |
| Title substring | +5 |
| Text occurrence (each) | +1 |

Results sorted by total match count descending.

---

## `src/gui/analytics.ts` — Analytics Engine

Server-side computation of municipal code statistics and PCA embedding projections. PCA starts and K-Means initialization are deterministic, including small or partially indexed collections, so repeated exports are comparable.

## `src/analytics_backend.ts` — Shared Overview

`bun run analytics` writes `output/state/analytics-overview.json`. The weekly
pipeline writes the same artifact after monitors, curation, source discovery,
and reporting complete. It is the canonical entry point for interpretation:
deterministic metrics and warning signals remain available when the selected
LLM provider is unavailable, while a successful executive summary records its
provider, model, prompt version, and evidence fingerprint. Unavailable and
stale sources are explicit warnings; empty alert feeds are never rewritten as
calm.

### Exports

| Function | Signature | Description |
| :--- | :--- | :--- |
| `getCodeStats` | `() → Promise<CodeStats>` | Articles/sections/words, per-title breakdown, longest/shortest sections |
| `getEmbeddingProjection` | `() → Promise<EmbeddingProjection>` | PCA projection with K-Means clustering and word loadings |
| `kmeans` | `(data, k, maxIter?) → {centroids, assignments}` | K-Means clustering |
| `powerIteration` | `(data, dim, _, iterations?) → {vector, eigenvalue}` | Dominant eigenvector of X^T X |
| `computeWordLoadings` | `(docs, projections, pcs) → WordLoading[]` | Pearson correlation between term frequencies and PC scores |

### PCA Pipeline

1. Fetch all embeddings from ChromaDB (batched, max 2000 points)
2. Center data (subtract mean)
3. Extract top 10 principal components via sequential power iteration + deflation
4. Project all points onto PCs
5. Normalize PC1/PC2 to [-1, 1] for default view
6. K-Means clustering (k=6) on projection scores
7. Compute word loadings (top 50 terms by combined correlation)

---

## `src/gui/alert_trends.ts` — Alert Trend Aggregation

Pure UTC-day aggregation for the local GUI's compact per-type trend and
eight-monitor heatmap. The browser combines the existing bounded
`/api/alerts/timeline` response with at most 500 records from each
`/api/alerts/{type}/history` endpoint, deduplicates exact overlaps, and caps the
combined view at 5,000 records over 14 days.

Source health from `/api/health` is deliberately independent from historical
event count and the latest monitor level from `/api/monitor/alerts`:

- `empty` means the source was checked successfully but returned no matching
  regional items; it is not calm.
- `stale` and `unavailable` remain explicit even when a prior monitor payload
  reported `CALM`.
- A zero-count heatmap cell means only that no event was recorded on that UTC
  day.
- The UI labels `CALM` only when a current monitor payload supplies an explicit
  calm-equivalent level (`CALM`, `GOOD`, `NONE`, `NORMAL`, or `OK`).

### Exports

| Export | Description |
| :--- | :--- |
| `buildAlertTrendView(input)` | Build bounded 14-day buckets for all eight alert types, with health/current-state metadata and deduplication diagnostics |
| `classifyAlertCondition(level)` | Classify an explicit monitor level as `calm`, `active`, or `unknown` |
| `deriveAlertDisplayState(health, condition)` | Preserve health-state precedence so missing evidence is never rendered as calm |
| `alertHeatIntensity(count, maximum)` | Scale a count into the stable heatmap range 0–4 |

The single-file frontend mirrors this pure model because the GUI has no browser
build step. Pure zero-mock tests exercise the TypeScript contract, and the real
Playwright smoke opens the Alerts panel and verifies the rendered trend,
heatmap, source-state rows, and accessible cell labels.

---

## `src/gui/static/index.html` — Frontend

Single-file SPA with no build step.

### Navigation (redesigned 2026-07-24)

Seven top-level nav buttons, each a distinct, non-overlapping purpose. Exactly one overlay is ever open at a time — every button calls a shared `closeAllOverlays()` before opening its own, so switching tabs never leaves a stale panel open behind the new one (previously only one of the four buttons did this closing, asymmetrically).

| Tab | Contains | Sub-tabs |
| :--- | :--- | :--- |
| 📖 **Code** | Not an overlay — resets to the TOC/section-viewer view (the default landing state) | — |
| 📊 **Code Analytics** | Tools for analyzing the municipal code itself | Stats & Charts, Readability, Glossary, Cross-Refs, Domains, Compare Sections, Legislative History |
| 📰 **News & Feeds** | Everything sourced from *outside* the code — the actual "news sources" (RSS, government meeting agendas, YouTube transcripts) | Civic Dashboard, News Feed, Monthly Report |
| 🧭 **Sources** | Canonical source coverage, operational joins, provenance, and machine-readable exports | Source Coverage, Structured Output |
| 🚨 **Alerts** | The 8 real-time safety monitors + their timeline (previously the timeline duplicated as a separate Intelligence sub-tab) | — (single panel) |
| 💬 **Chat** | RAG assistant over the code + transcripts | — |
| 🔌 **Developer** | Meta/dev-facing tools, not end-user civic content | API Explorer, Search Analytics |

Before this pass, all of Code Analytics/News & Feeds/Developer's content lived flattened under one 12-tab "🧠 Intelligence" button with no grouping — a user had no way to tell, from the tab bar alone, that e.g. the Glossary (a code tool) and the Curated Feed (actual news) were unrelated kinds of content sharing one label.

### Landing page / welcome directory

The default local GUI view is a welcome linktree rather than a blank code
browser. It gives visitors direct paths to local news and provider-labeled
summaries, source coverage and freshness, municipal code, safety alerts,
analytics, RAG chat, civic reports, developer/API tools, and official City,
County, media-hub, Harbor, transit, and project links. The landing status line
reports current source degradation, selected chat provider, alert level, and
code corpus counts. Each destination opens the existing focused panel, so the
landing page is navigation rather than a second copy of the data model.

### Features

| Feature | Description |
| :--- | :--- |
| **TOC browser** | Collapsible tree sized from the current `output/toc.json` |
| **Section viewer** | Full formatted section content |
| **Search** | Instant full-text search with highlighting |
| **Analytics dashboard** | Bar charts (sections/words per Title), PCA scatter plot, word loadings |
| **✨ Summarize** | Per-section legal summary generated by the configured chat provider |
| **💬 Chat panel** | RAG queries with cited sources |
| **Dark/light mode** | Toggle persisted in localStorage |
| **Domains panel** | Intelligence domain browser with municipal code cross-refs |
| **Source Coverage panel** | Filterable monitored/discovery/reference registry, per-source drill-down, coverage gaps, and structured JSON download |
| **Alert activity view** | Selectable 14-day per-type trend plus an eight-type heatmap with explicit calm/empty/stale/unavailable/unknown labeling |

### Tests

```bash
bun test tests/routes.test.ts      # 7 tests
bun test tests/search.test.ts      # 8 tests
bun test tests/analytics.test.ts   # 7 tests
bun test tests/alert-trends.test.ts
```

### Search, chat & resilience additions

- `GET /api/search/semantic` uses `src/gui/semantic_search.ts` — Ollama-embed + ChromaDB
  retrieval that degrades to BM25 (`mode: "bm25-fallback"`) whenever the vector stack is
  down. Preflight uses short health checks so a missing Ollama/Chroma fails fast.
- Chat (`sendChat`) tracks a `chatHistory` array and sends it as `history` on
  `/api/chat/stream` and POST `/api/chat` (server composes a bounded last-6 context via
  `buildChatMessages`).
- A top-of-page `#error-banner` (`showErrorBanner`) surfaces genuine network failures from
  `apiFetch`; per-route inline errors are preserved.

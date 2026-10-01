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

The GUI and Pages exporter use the health roster defined by
`EXPECTED_SOURCE_HEALTH` in `src/shared/source_health.ts`. If a
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
| GET | `/api/search?q=...&limit=N` | Full-text search (default limit: 50) |
| GET | `/api/stats` | Municipality stats (article/section counts, timestamps) |
| GET | `/api/domains` | All 12 intelligence domains (from `domains.ts`) |
| GET | `/api/monitor/status` | Latest monitor report `output/monitor-report.json` |
| GET | `/api/monitor/alerts` | Latest persisted output from each alert monitor, composite level, and alert source-health artifact |
| GET | `/api/alerts/timeline` | Bounded unified timeline plus per-type statistics across the alert monitors |
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
| `search` | `(query, options?) → PagedSearchResult` | BM25 keyword search with pagination, title/type/field filters, highlight, and fuzzy-correction fallback |
| `getIndexedCount` | `() → number` | Current number of indexed sections |

`initSearch()` (called by `server.ts` on startup) initializes the in-memory
index for the selected artifact root. Shared loaders and cache identity preserve
root ownership across concurrent and redirected reads.

### Ranking Algorithm

BM25 with a field-weighted index:

- Section number prefix match: heavy boost (×20)
- Title matches: 3× weight boost
- Body text: standard BM25 scoring

When BM25 returns 0 results, Levenshtein fuzzy corrections are returned in the
`fuzzyCorrections` field of `PagedSearchResult`.

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
| `powerIteration` | `(data, dim, iterations?) → {vector, eigenvalue}` | Dominant eigenvector of X^T X |
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

## `src/gui/docs_dashboard.ts` — Docs/Modules Dashboard Derivation

Pure, offline-testable derivation behind `GET /api/docs/modules` and the
`/docs-dashboard.html` page. It computes — never restates — the module roster
from the source tree and the docs surfaces from `docs/modules/*.md` plus
`docs/architecture.md`. Per module it reports which docs surfaces name it
(`documentedBy`); per docs surface it reports the modules it names and any
`.ts` references that resolve to no existing file (`missingFiles`, the live
drift signal). A root with no backing tree yields `empty: true` and zero
rows — the dashboard's explicit empty state, never a fabricated roster.

Tests: `tests/gui-phase14.test.ts` (real-repo derivation, stale-reference
control, empty-root fixture, page and route string contracts).

---

## `src/gui/static/structured-queries.html` — Structured-Query Page

A dedicated static page at `/structured-queries.html` for the three
structured-query engine surfaces already served by the API — legislative
history (`/api/history/{guid}`), section diff (`/api/compare`), and semantic
similarity (`/api/similar/{guid}`). Inputs accept a section number (resolved
through `/api/search?field=number`) or a raw GUID. Each panel carries an
explicit empty state on load and on an empty result, plus a distinct error
state; the page is served with the same loopback-only API-key injection as
`index.html` (see `server.ts`'s `serveStaticHtmlWithKey`).

Tests: `tests/gui-phase14.test.ts` (string contracts on the empty states,
endpoint wiring, and server serving).

---

## `src/gui/ordinal_refinement.ts` — Ordinal-Sequence Refinement

Pure, offline derivation behind `GET /api/ordinals` and the
`/phase10-legal.html` page. Each
title's chapter ordinals are classified as `numeric`, `suffixed`
(`"04-R"` — a real post-adoption insertion slot sharing its base number with
the plain form), or `non-numeric`; gaps are computed strictly between present
ordinal VALUES (a suffix family is one slot, never a gap of 1..R−1), missing
ordinals are formatted with their neighbours' zero-padding, and unparseable
segments are REPORTED rather than coerced to NaN. The narrower published
`GET /api/ordinal-check` keeps its published shape.

Tests: `tests/gui-phase10.test.ts` (classification/gap fixtures, zero-padding,
real-corpus determinism, empty-report state, route + spec wiring).

---

## `src/gui/legal_crosslinks.ts` — Legal-Citation Cross-Linking

Pure corpus sweep behind `GET /api/citations/index` and the
`/phase10-legal.html` page. Every California-code and U.S.C. citation the
legal parser finds in section prose is resolved to its canonical official
URL (`leginfo.legislature.ca.gov` for the California codes, via a fixed
code-name → `lawCode` mapping; `law.cornell.edu` for the U.S. Code). The
honesty rule: a citation with no stable target — case law, ordinance
references, a malformed capture like "(42 U.S.C. Section 12101 et seq.)"
parsed with a junk section — reports `href: null` and is never linked
to a guessed URL. Citations naming a section of this corpus also carry its
guid, resolved by the same dot-boundary rule the cross-ref validator uses.

Tests: `tests/gui-phase10.test.ts` (canonical URLs, junk-section negative,
unknown-code negative, corpus-wide sweep asserting only the two canonical
hosts appear in hrefs, empty state, route ordering vs `/api/citations/{guid}`).

---

## `src/gui/effective_dates.ts` — Latest Recorded Amendment Year

The field behind `GET /api/effective-dates` and the `/phase10-legal.html` page
derives each section's latest recorded amendment year from
its own history line via `legal_parser.extractOrdinanceAmendments`: the most
recent year in the parsed amendment trail, with the ordinance and action that
carried it. A section whose history carries no parseable year is an explicit
`effectiveYear: null` — rendered as "no recorded amendment year on record", never
guessed from an ordinance number or the scrape date. The corpus report
partitions sections with/without a date and bounds the year range to what is
actually on record. The UI calls this a recorded amendment year. The
`effectiveYear` field and `/api/effective-dates` route retain their compatibility
names; they do not establish a legal effective date. That requires primary
ordinance evidence and a separate legal chronology assessment.

Tests: `tests/gui-phase10.test.ts` (derivation, no-fabrication negatives,
corpus partition + year-range bound, route + spec wiring, unknown-guid 400).

---

## `src/gui/static/phase10-legal.html` — Legal Analysis Page

A dedicated static page at `/phase10-legal.html` for three legal-analysis
surfaces: ordinal sequences (`/api/ordinals`), legal-citation cross-links
(`/api/citations/index`), and recorded amendment years (`/api/effective-dates`).
Each panel carries an explicit empty state on load and on empty data, plus a
distinct error state; the page is served with the same loopback-only API-key
injection as `index.html` (see `server.ts`'s `serveStaticHtmlWithKey`).

Tests: `tests/gui-phase10.test.ts` (string contracts on the empty states,
endpoint wiring, and server serving).

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
| `buildAlertTrendView(input)` | Build bounded 14-day buckets for the alert types, with health/current-state metadata and deduplication diagnostics |
| `classifyAlertCondition(level)` | Classify an explicit monitor level as `calm`, `active`, or `unknown` |
| `deriveAlertDisplayState(health, condition)` | Preserve health-state precedence so missing evidence is never rendered as calm |
| `alertHeatIntensity(count, maximum)` | Scale a count into the stable heatmap range 0–4 |

The no-build ESM frontend renders the corresponding trend model through its
explicit reader modules. Pure zero-mock tests exercise the TypeScript contract, and the real
Playwright smoke opens the Alerts panel and verifies the rendered trend,
heatmap, source-state rows, and accessible cell labels.

---

## `src/gui/static/index.html` — Frontend

No-build SPA. `index.html` imports one `assets/gui-app.js` ES module entry
point; reader dependencies and shared mutable state are explicit. Dedicated
HTML readers have their own imported controllers. Generated markup uses the
scoped `CCGui.render()` inert-template sanitizer; it does not patch every page's
native DOM setter. Local assets and the server nonce CSP avoid remote runtime
code and prevent generated resource-loading attributes/styles.

### Asset layout

| Path | Role |
| --- | --- |
| `index.html` | Markup shell, local stylesheet/module entry and request-aware escaped API-key bootstrap |
| `assets/gui-app.js` | Explicit module initialization and ready-state owner |
| `assets/app-state.js` | Shared mutable reader state |
| `assets/gui-runtime.js` | Inert rendering, safe links and local Markdown helpers |
| `assets/reader-lifecycle.js` / `reader.css` | Bounded latest-request/cancel/retry controls, announcements and focus restoration |
| `assets/gui.css` | Local GUI layout and theme stylesheet |
| `assets/virtual-list.js` | Explicitly imported windowed search/glossary renderer |
| `assets/modules/` | Imported navigation, search, chat, alerts, analytics, source and civic reader functions |
| `assets/{docs-dashboard,structured-queries,phase10-legal}.js` | Dedicated reader controllers preserving their stable URLs |

### Navigation

Seven top-level nav buttons group the main surfaces. Each button calls the
shared `closeAllOverlays()` before opening its own overlay.

| Tab | Contains | Sub-tabs |
| :--- | :--- | :--- |
| 📖 **Code** | Not an overlay — resets to the TOC/section-viewer view (the default landing state) | — |
| 📊 **Code Analytics** | Tools for analyzing the municipal code itself | Stats & Charts, Readability, Glossary, Cross-Refs, Domains, Compare Sections, Legislative History |
| 📰 **News & Feeds** | Everything sourced from *outside* the code — the actual "news sources" (RSS, government meeting agendas, YouTube transcripts) | Civic Dashboard, News Feed, Monthly Report |
| 🧭 **Sources** | Canonical source coverage, operational joins, provenance, and machine-readable exports | Source Coverage, Structured Output |
| 🚨 **Alerts** | The real-time safety monitors + their timeline | — (single panel) |
| 💬 **Chat** | RAG assistant over the code + transcripts | — |
| 🔌 **Developer** | Meta/dev-facing tools, not end-user civic content | API Explorer, Search Analytics |

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
| **Alert activity view** | Selectable 14-day per-type trend plus an all-monitor heatmap with explicit calm/empty/stale/unavailable/unknown labeling |

### Tests

```bash
bun test tests/routes.test.ts
bun test tests/search.test.ts
bun test tests/analytics.test.ts
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

### Observation and readability panels

Two panels fetch the hazard-observation and readability-history envelopes and
provide empty states when data is unavailable.

- **📈 Readability → "History trend" sub-block** (`#readability-history-content`):
  `GET /api/readability/history?limit=60` → `{ total, count, offset, limit,
  entries[], trend: { buckets: [{ windowStart, windowEnd, avgEase, runs }],
  latest, delta } }`. Renders a per-run ease/fog delta list plus a 30-day
  average-ease SVG line. Empty state: "No readability history recorded yet —
  run `bun run readability`".
- **🗺️ Hazard Geo → "Live hazard observations" sub-block**
  (`#geo-observations-content`): `GET /api/geo-observations` → the
  `crescent-city-geo-observations/v1` envelope (`schema`, `anchor`,
  `composite`, `monitors[]`, `hazardSummary[]`, `freshness`). Renders a
  composite-level badge plus per-monitor status chips. Empty state: "Live
  hazard observations unavailable (route not live yet)."

## `src/browser_smoke.ts` — Real-Browser Smoke Test

Boots the actual GUI server and drives it with Playwright Chromium: page load, tab switching, search, and alert-panel render checks against the real static assets. Not part of the deterministic suite (requires a browser); run via `bun run test:browser`.

## `src/gui/annotations.ts` — Map Annotation Persistence

User-anchored map annotations for the wildfire map's distance bands: notes are
persisted server-side in a bounded JSON artifact under `output/state/`
(`annotations.json`, written atomically), following the bounded-storage
precedent of `readability_history.ts`. Browser side lives in
`gui/static/assets/modules/145-phase9-hazards.js`.

## Reader acceptance boundary

`bun run test:gui-readers` exercises actual primary APIs in isolated roots at
desktop/mobile widths, including every declared reader tab, keyboard section
selection, map-note anchors, downloads, summaries, loading cancellation/retry
and standalone readers. `bun run test:gui-journeys` separately exercises storage
failure, delayed requests, inert adversarial rendering, API-key handling and
chat/SSE terminal behavior. These are real local browser/HTTP checks; model
protocol fixtures and small corpus fixtures are identified rather than presented
as fresh upstream or semantic acceptance. Exact exported Pages rendering has its
own command and saved-tree receipt.

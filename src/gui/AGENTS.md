# Agents Guide — `src/gui/`

## Overview

Lightweight Bun HTTP server serving a single-page application for browsing, searching, and analyzing the municipal code.

## Files

| File | Purpose | Tests |
|---|---|---|
| `server.ts` | `Bun.serve()` entry point on port 3000, request trust and static security headers | `tests/gui-server.test.ts`, `tests/gui-journeys.browser.ts` |
| `routes.ts` | API route handler (`/api/toc`, `/api/search`, `/api/article/:guid`, etc.) | `tests/routes.test.ts` |
| `search.ts` | In-memory full-text search engine over sections | `tests/search.test.ts` |
| `annotations.ts` | Bounded JSON wildfire-map annotation store (GET/POST/DELETE `/api/annotations`) | `tests/phase9-hazard-surfaces.test.ts` |
| `semantic_search.ts` | Ollama-embed + ChromaDB semantic search with BM25 fallback (`/api/search/semantic`) | `tests/semantic-search.test.ts` |
| `analytics.ts` | Code statistics, PCA projection, K-means clustering | `tests/analytics.test.ts` |
| `alert_trends.ts` | Pure UTC-day alert trend buckets + heatmap intensity for the Alerts panel | `tests/alert-trends.test.ts` |
| `docs_dashboard.ts` | Pure docs/modules dashboard derivation: module roster + docs-surface sync status computed from the tree (`GET /api/docs/modules`) | `tests/gui-phase14.test.ts` |
| `ordinal_refinement.ts` | Ordinal-sequence refinement: per-title chapter ordinals classified numeric/suffixed/non-numeric, gaps, density (`GET /api/ordinals`) | `tests/gui-phase10.test.ts` |
| `legal_crosslinks.ts` | Legal-citation cross-linking: CA-code/U.S.C. citations → canonical official URLs, null when no stable target (`GET /api/citations/index`) | `tests/gui-phase10.test.ts` |
| `effective_dates.ts` | Latest recorded amendment year from each section's history line, null when unparseable (`GET /api/effective-dates`); the compatibility name does not establish a legal effective date | `tests/gui-phase10.test.ts` |
| `static/docs-dashboard.html` | Dashboard page at `/docs-dashboard.html` (roster + sync status, explicit empty state) | `tests/gui-phase14.test.ts` |
| `static/structured-queries.html` | Structured-query page at `/structured-queries.html` (history / compare / similar, explicit empty states) | `tests/gui-phase14.test.ts` |
| `static/phase10-legal.html` | Legal-analysis page at `/phase10-legal.html` (ordinal refinement, citation cross-links, recorded amendment years; explicit empty states) | `tests/gui-phase10.test.ts` |
| `static/` | `index.html` (SPA markup shell: dark/light theme, TOC, search, analytics, chat), `docs.html` (API docs at `/api/docs`), and `assets/` — `gui.css` + `virtual-list.js` + `modules/*.js`, loaded by classic `<link>`/`<script src>` tags with shared globals and explicit load order | `tests/gui-chat-contract.test.ts`, `tests/gui-interactivity.test.ts`, `tests/corpus-intelligence-routes.test.ts`, `tests/pages-theme.test.ts` |

## Key Patterns

- `handleApiRoute(url, req?)` returns `Promise<Response>`. Always returns a `Response` (404 for unmatched routes). The server routes `/api/*` requests to it and serves static files for all other paths.
- `initSearch()` must be called before `search()` — it loads all sections into memory.
- Analytics computation is CPU-intensive; results are cached after first request.
- Chat uses Ollama for embeddings and ChromaDB for retrieval, with Ollama or
  OpenRouter selected as the chat provider through `LLM_PROVIDER`.

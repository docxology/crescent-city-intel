# TODO — Crescent City Intelligence Platform

> Upcoming development backlog · v2.5.1 · validation counts are reported by `bun run validate`
>
> Priority key: 🔴 Major (new capability) · 🟡 Medium (significant enhancement) · 🟢 Minor (polish/fix) — reviewed 2026-08-04
>
> **Owner:** docxology · **Status:** active · **Last reviewed:** 2026-08-04 (deepest review pass)

---

## Completed / Closed

### Deep review pass (2026-08-04) — implemented and verified

Every item below is implemented and verified by `bun run validate` (suite **701 → 717**
tests across 57 → 61 files, 0 failures, strict-ts + contract + generated-output checks green).

- ✅ **SSE `/api/chat/stream` streaming restored (MAJOR).** `src/gui/server.ts maybeCompress`
  treated `text/event-stream` like any other text response and called
  `res.arrayBuffer()` on the live ReadableStream, which **consumed the entire SSE
  stream** (blocking until the RAG generation finished) and returned the whole body
  as one buffered response. Because every browser sends `Accept-Encoding: gzip`, the
  chat stream delivered the answer all at once instead of token-by-token. `maybeCompress`
  now passes `text/event-stream` through UNTOUCHED (same Response object). Regression
  tests in `tests/gui-compress.test.ts` (4 tests) assert streaming identity + JSON gzip.
- ✅ **`export.test.ts absent` deferred Minor closed.** `src/export.ts` is refactored to
  export **pure builders** (`buildConsolidatedJson`, `buildMarkdownFiles`, `buildPlainText`,
  `buildSectionIndexCsv`) and its full-run `main()` is now guarded by `import.meta.main` —
  importing it no longer runs an export as a side effect. New `tests/export.test.ts` (6 tests)
  covers the consolidated-JSON shape, CSV escaping/layout, plain-text ordering/history, and
  Markdown title/chapter/appendix layout.
- ✅ **`verify.ts` no longer launches a browser on import.** `main()` is now guarded by
  `import.meta.main`; `collectDescendantSections` is exported. New `tests/verify.test.ts`
  (2 tests) locks the section-enumeration parity contract (division/chapter/part nesting).
- ✅ **Request log records the real HTTP status (`src/api/middleware.ts`, `src/gui/server.ts`).**
  The logging middleware ran before the route handler and wrote a hardcoded `status: 0` for
  every entry. The server now calls the new `recordRequestLog()` after it has the actual
  Response (middleware short-circuit **or** handled route), so `request-log.jsonl` is honest.
- ✅ **Alert `current.json` artifacts are now written atomically.** `noaa_tsunami`,
  `nws_weather`, `usgs_earthquake`, `epa_airnow`, `calfire_wildfire`, and `ndbc_marine`
  switched their live-state `current.json` writes from plain `writeFile` to
  `writeJsonAtomic` (fsync'd temp + rename), so a torn write cannot surface as a spurious
  `unavailable`/deleted live state.
- ✅ **Composite wildfire severity is distance-aware (`src/alerts/composite.ts`).**
  `hasLargeFireNearby` now requires `distanceKm ≤ 50` (matching `classifyWildfireSeverity`),
  so a large fire ~130 km away (e.g. interior Humboldt) no longer raises the composite to
  WARNING while the monitor itself reports ADVISORY. Regression tests in
  `tests/composite-alerts.test.ts` (4 tests; also marine primary-buoy preference).
- ✅ **Stale tide-severity thresholds corrected (docs/prose).** `src/alerts/severity.ts`
  header and `README.md` (`alerts:tides` comment, Tides API table) still described the old
  `WARNING≥5 ft / WATCH≥3 ft` thresholds; corrected to the live `WARNING≥7.0 / WATCH≥6.0`
  (storm surge / king tide) model from the R2 fix.
- ✅ **`search.ts` fuzzy fallback now logs zero-result queries** (`src/gui/search.ts`), so
  `/api/search/analytics` counts queries that surfaced `did-you-mean` corrections.
- ✅ **AGENTS.md doc drift corrected.** `src/AGENTS.md` + `src/shared/AGENTS.md` pointed
  readability/content tests at the non-existent `tests/content.test.ts` (now
  `content-fixture.test.ts`; `export.test.ts` / `verify.test.ts` now actually exist);
  `src/api/AGENTS.md` documented a non-existent `RATE_LIMIT_MS` "min-ms-between-requests"
  behavior (now the real sliding-window model); `src/alerts/AGENTS.md` claimed
  `noaa_tides.ts` "runs on import" (it exports `monitorTides()`).

### Prior passes already completed (carried forward)

- 2026-08-01 deepest hostile red-team: M1 tsunami composite severity, M2 NWS weather
  severity, M3(self) monitor hash baseline, M4 readability decimal shielding, M5
  `.dockerignore`, R2 tide thresholds, R4 marine primary buoy, R6 polygon holes, plus the
  Minor/Medium hardening pass (rate-limit spoof, random API key, bounded fetches, AirNow
  KML fallback, deterministic corpus ordering, atomic fsync writes, etc.) and part-3
  refactor (M6 thin orchestrator, bounded alert timeline, domain section counting,
  export atomic writes, verify sample outcomes, stream prompt dedup, stem-exception parity).

---

## Open — Major

- 🔴 **Unbounded per-monitor alert JSONL history (R7, still deferred).** `output/alerts/<type>/history.jsonl`
  (tsunami, weather, earthquake, airquality, wildfire, marine, tides) grows without bound
  and is fully re-read each run. **Why:** unbounded disk growth and O(n) startup reads over
  months of runs. **Fix:** migrate to the shared `IdempotencyStore` with a cap (the store
  already exists and is fsync-atomic) or add a bounded tail-trim to the JSONL appenders.
  **Affected:** `src/alerts/*` history appenders.
- 🔴 (capability) **Semantic/embedding search in the GUI.** BM25 is keyword-based; concept
  search needs ChromaDB embeddings surfaced in `/api/search`. **Why:** recall across
  drafting styles. **Affected:** `src/gui/search.ts`, `src/llm/embeddings.ts`.

---

## Open — Medium

- 🔴 **`?api_key=` query-param auth may leak keys into logs/URLs.** The middleware still
  accepts `?api_key=` in addition to the `X-API-Key` header. **Why:** query strings land in
  proxy/access logs and browser history. **Fix:** header-only auth (breaking change — needs a
  migration note in README/OpenAPI).
- 🟡 **`news_normalizeUrl` dedup collapses distinct paginated articles** sharing a path
  (`src/news_monitor.ts`). **Why:** distinct items with the same canonical path are dropped
  as duplicates. **Fix:** add a title/length secondary check to the dedup key.
- 🟡 **`isComplexWord` capitalized-word heuristic** (`src/shared/readability.ts`) drops any
  sentence-initial capitalized content word as a "proper noun", under-reporting Gunning-Fog
  complexity. **Why:** published readability scores are slightly optimistic. **Fix:** use
  sentence-position context before dropping a capitalized word.
- 🟡 **Semantic reranking + conversation history in RAG** (`src/llm/rag.ts`): cross-encode
  top-20 → top-5, and multi-turn context window. **Why:** answer quality on ambiguous queries.
- 🟡 **GUI error banner + Ollama/Chroma preflight wiring** (Phase 1.2): render user-facing
  error UI for failed `/api/*`; fail fast with actionable install instructions before
  `bun run index`/RAG when Ollama/ChromaDB are absent.
- 🟡 **Government meeting structure extraction** (Phase 4.2): parse HTML agendas into
  structured agenda-item lists, and minutes into yea/nay/abstain vote records; SHA-256 change
  detection on agenda/minutes PDFs; BM25 cross-reference of agenda items to code sections.
- 🟡 **Notification channels** (Phase 4.3/4.1): webhook/email/Slack on code-change detection,
  high-urgency civic keywords, or new high-severity alerts.
- 🟡 **Change-diff storage + `--full-rescrape`** (Phase 4.3): write `output/diffs/` when a
  re-scraped section differs; add a `--full-rescrape` flag that bypasses resume.
- 🟡 **Alert heatmap / trends / per-type history API** (Phase 5.9): map visualization,
  monthly trend charts, and `GET /api/alerts/:type/history?offset=&limit=` pagination.
- 🟡 **Wildfire smoke correlation & red-flag integration** (Phase 5.6/5.7): cross-ref AQI
  spikes vs CAL FIRE incidents; NWS fire-weather warnings for Del Norte.
- 🟡 **`tests/browser.test.ts` + coverage gate** (Phase 11.1): Playwright error-path tests
  (timeout/dead-page/retry) and a `bun test --coverage` floor.
- 🟡 **Validate routes against OpenAPI in CI** (Phase 11.2): check every openapi.yaml path
  has a handler (the reverse already exists in `scripts/validate.ts`).
- 🟢 **/api/health rate-limit metrics** (Phase 1.1): report current per-IP usage, peak,
  and blocked count.

---

## Open — Minor

- 🟢 **CDFW bulletin `date` is always today + placeholder content** (`src/alerts/cdfw_fishing.ts`):
  the SQL-regex parse stamps every `FishingBulletin.date` with the fetch date and
  `content` with `CDFW bulletin: <title>`; only counts are consumed today, but the persisted
  record misrepresents publish date. **Fix:** extract the real bulletin date from the CDFW
  page (or mark `date` unknown when unparseable), and fetch real bulletin text.
- 🟢 **`buildCompositeInput` tides/fishing `available` is not freshness-gated**
  (`src/alerts/composite.ts`): unlike air/wildfire/marine it uses `!!report` only. Harmless
  through the orchestrator (always a fresh report) but inconsistent for direct callers.
- 🟢 **`.claude/` is untracked** (pre-existing, not mine): decide whether to commit or ignore.
- 🟢 **`sanitizeFilename` can yield `.`/`..`** (`src/utils.ts`) for pathological input; used
  in export paths. Low risk (real chapter numbers are safe) — add an empty/`.` guard.
- 🟢 **`extractSnippet`/`truncateText` edge polish** and **physical roadmap items already
  listed in earlier phases** (Phase 2: debounce, dependency graph, definition tooltips,
  cross-ref hyperlinking; Phase 7: readability trend/heatmap, plain-language rewrite, word
  frequency tracking, section longevity, alert timeline chart, RAG query analytics,
  ordinance timeline; Phase 8: USCG broadcasts, PZZ455 marine forecast, swell height, PacFIN
  landings, AIS traffic, permit cross-ref, harbor agenda parser, dredging schedule, fuel
  price; Phase 9: AQ widget, marine panel, wildfire map, virtual scroll, lazy load, annotation,
  readability/coverage overlays; Phase 10: ordinal-sequence refinement, legal-citation and
  CA/US cross-linking, effective-date field; Phase 12: USCG broadcasts, red-flag warnings,
  drought monitor, PSPS, smoke forecast, road closures, school closures; Phase 13: ordinance
  chronology/lineage, section dependency graph, citation hyperlinks; Phase 14: remaining
  docs/modules pages for analytics, monitoring, and structured-query surfaces).

# TODO — Crescent City Intelligence Platform

> Upcoming development backlog · v2.5.1 · validation counts are reported by `bun run validate`
>
> Priority key: 🔴 Major (new capability) · 🟡 Medium (significant enhancement) · 🟢 Minor (polish/fix) — reviewed 2026-08-04 (Round 3 completion pass)
>
> **Owner:** docxology · **Status:** active · **Last reviewed:** 2026-08-04 (Round 3 completion pass)

---

## Completed / Closed

### Round 3 completion pass (2026-08-04) — implemented and verified

Every item below is implemented and verified. `bun run validate` is **741 tests / 66
files / 0 failures** (up from 719/63 at the end of Round 2), strict TypeScript + OpenAPI
route-contract + generated-Pages checks green.

- ✅ **R7 — unbounded per-monitor alert JSONL history (MAJOR, deferred since 2026-08-01).**
  `src/shared/source_health.ts` now exports `appendBoundedJsonl` / `appendBoundedJsonlSync`,
  capped appenders that tail-trim `history.jsonl` to the most-recent 10 000 lines
  (async: temp+rename atomic; sync: writeFileSync tmp + renameSync). Wired into ALL eight
  alert monitors (tsunami, weather, earthquake, airquality, wildfire, marine via the sync
  appender; tides + fishing via the async appender). Tests in `tests/bounded-jsonl.test.ts`.
- ✅ **Header-only API key auth (`src/api/middleware.ts`).** The `?api_key=` query-parameter
  fallback (which leaked credentials into proxy/access logs and browser history) is removed;
  only `X-API-Key` is accepted. The 401 message, OpenAPI (dropped the `apiKeyQuery` scheme),
  and `src/api/AGENTS.md` all updated. Tests in `tests/middleware.test.ts` prove a valid
  query-param key is rejected while the header still authenticates.
- ✅ **`GET /api/alerts/{type}/history` paginated endpoint.** New route with `?limit=&offset=`
  (400 on unknown type), backed by `getAlertsByType`; `ALERT_TYPES` exported. Registered in
  the OpenAPI route-contract gate (`scripts/validate.ts`) and declared in `openapi.yaml`.
  Tests in `tests/alerts-history.test.ts`.
- ✅ **`/api/health` rate-limit metrics (Phase 1.1).** `getRateLimitStats()` surfaces
  `{trackedIps, peakUsage, blocked}` in the health payload. Tests in
  `tests/rate-limit-health.test.ts`.
- ✅ **`--full-rescrape` flag (Phase 4.3).** `src/scrape.ts` bypasses the resume cache when
  the flag is present; documented in README + `docs/modules/scraping.md`.
- ✅ **Monthly report now covers tides + fishing (Phase 7.3 gap).** `src/monthly_report.ts`
  reads `output/tides/history.jsonl` and `output/fishing/history.jsonl` and renders
  "🌊 Tides" and "🦀 Dungeness Crab Season" sections. Verified by running `bun run report`
  (real output includes both sections).
- ✅ **News dedup no longer collapses paginated articles (`src/news_monitor.ts`).** Dedup key
  is now `normalizeUrl(url)|title` via the exported pure `dedupKey()`; distinct items sharing
  a path are kept, cross-feed/param variants still dedup. Tests in `tests/news-dedup-key.test.ts`.
- ✅ **`sanitizeFilename` path guard (`src/utils.ts`).** Empty / `.` / `..` results now return
  a safe `"_"` instead of an unusable or path-escaping filename. Tests updated/added.
- ✅ **Composite tides/fishing availability is freshness-gated (`src/alerts/composite.ts`).**
  Matches air/wildfire/marine; a stale report is treated as unavailable. Tests added.
- ✅ **`isComplexWord` sentence-position refinement (`src/shared/readability.ts`).** A word
  capitalized because it is sentence-initial is no longer dropped as a "proper noun", so
  Gunning-Fog no longer under-reports complexity for sentence-initial polysyllabic content
  words; mid-sentence proper nouns are still excluded. Tests added.
- ✅ **CDFW bulletin `date` is honest (`src/alerts/cdfw_fishing.ts`).** A publish date is
  extracted from the anchor/title when present; otherwise left empty ("unknown") instead of
  stamping every bulletin with today's date.
- ✅ **"Validate routes against OpenAPI" already implemented** — `scripts/validate.ts` checks
  BOTH directions (every OpenAPI path has an implementation and every implemented route is
  in OpenAPI); no new CI work needed.

### Rounds 1–2 already completed (carried forward)

- Round 2: tides+fishing reached the alert timeline (history-path contract fix +
  `tests/alert-analytics-contract.test.ts`); `src/scrape.ts` import guard; monthly-report
  gap filed (now completed this round).
- Round 1: SSE streaming restored; `export.ts`→pure builders + `tests/export.test.ts`;
  `verify.ts`/`scrape.ts` import guards + `tests/verify.test.ts`; honest request-log status;
  atomic alert `current.json`; distance-aware composite wildfire; stale tide thresholds;
  fuzzy-search query logging; AGENTS.md doc drift.
- 2026-08-01 hardening: M1/M2/M3/M4/M5 + R2/R4/R6 + Minor/Medium pass + part-3 refactor.

---

## Open — Deferred (precisely scoped; cannot be completed/verified in this environment)

These items remain open because they require an external service/model, live site structure,
a browser runtime, or an owner UX decision — each with a concrete plan and acceptance
criteria. None is a known defect in the current code.

### Major (deferred — external dependency)

- 🔴 **Semantic / embedding search in the GUI.** **Why:** BM25 recall across drafting styles.
  **Plan:** add `POST /api/search/semantic` that embeds the query with Ollama
  (`embed`), queries ChromaDB (`llm/chroma.ts query`), and maps hits to search-result shape;
  degrade gracefully to BM25 when Chroma/Ollama are unavailable. **Acceptance:** endpoint
  returns ranked sections on a live Ollama+Chroma stack and 503-style graceful fallback
  otherwise; GUI search box gains a toggle. **Reason deferred:** requires a running
  Ollama+ChromaDB to verify end-to-end, which is not available here; the code path is
  otherwise the same as `/api/chat`'s retrieval.

- 🔴 **RAG reranking (cross-encode top-20 → top-5).** **Requires** a cross-encoder reranker
  model/external service not in the current local stack. **Plan:** add a configurable
  rerank step in `src/llm/rag.ts` behind a provider flag; fall back to raw cosine order when
  unset. **Reason deferred:** no reranker model/provider available; cannot verify.

### Medium (deferred — frontend/UX or live-data dependent)

- 🟡 **Conversation history in the RAG chat.** Multi-turn context window. **Plan:** GUI keeps
  an in-page message list and passes prior turns into `ragQuery`; server tracks a bounded
  window. **Reason:** SPA (`src/gui/static/index.html`) change; unverifiable without a
  browser; UX decision on how many turns to retain.
- 🟡 **GUI error banner for failed `/api/*`.** Preflight endpoints already return actionable
  503s; the frontend needs a banner. **Reason:** frontend-only SPA change.
- 🟡 **Government-meeting agenda/vote extraction (Phase 4.2).** Parse EvoGov HTML agendas into
  structured agenda items and minutes into yea/nay/abstain votes; SHA-256 change detection on
  agenda/minutes PDFs; BM25 cross-ref of agenda items to code sections. **Reason:** depends on
  the live EvoGov HTML/PDF markup; would need live fixtures to verify.
- 🟡 **Notification channels (webhook/email/Slack) on code-change or high-severity alerts.**
  **Plan:** config-driven webhook POST from `scripts/run-monitor.ts` and `scripts/run-alerts.ts`
  when `*_WEBHOOK_URL` is set. **Reason:** external endpoint + operator decision on the
  channel; cannot verify against a live webhook.
- 🟡 **Alert heatmap / monthly trend charts (frontend).** The backend `/api/alerts/{type}/history`
  and timeline now exist; map + trend widgets are SPA/Chart.js work. **Reason:** frontend,
  unverifiable without a browser.
- 🟡 **Red-flag / drought / PSPS / smoke / road / school monitors (Phase 5.7, 12).**
  **Reason:** new external live data sources whose response shapes must be validated against
  the live feeds; no live access here to verify parsers honestly.
- 🟡 **`tests/browser.test.ts` + `bun test --coverage` floor (Phase 11.1).** **Requires** a
  Playwright browser runtime in CI; the deterministic suite deliberately avoids browsers.
  **Plan:** a separate `test:browser` script gated behind a browser-available flag; a
  coverage-script alias without hard threshold until coverage is stable.
- 🟡 **Monthly-report tides/fishing recommendation note** — done (see Completed). N/A.

### Minor (deferred — owner decision / roadmap / frontend)

- 🟢 **`.claude/` untracked** — pre-existing file owned by the operator; decide whether to
  commit or `.gitignore` it (I do not touch operator-owned files).
- 🟢 **Roadmap UX/frontend items** (Phase 2 debounce/dependency-graph/tooltips/cross-ref
  hyperlinking; Phase 7 readability trend/heatmap/plain-language rewrite/word-frequency/
  section-longevity/ordinance timeline; Phase 8 USCG/PZZ455/PacFIN/AIS/permits/dredging/fuel;
  Phase 9 AQ widget/marine panel/wildfire map/virtual scroll/lazy load/annotation/overlays;
  Phase 10 ordinal refinement/legal-citation + CA + US cross-linking/effective-date field;
  Phase 13 ordinance chronology/lineage/dep-graph; Phase 14 docs/modules/… dashboard and
  structured-query pages). **Reason:** all frontend/SPA or new external-source features that
  require live data or browser verification; each is documented in `docs/` where scoped.
- 🟢 **Fishing bulletin full-text fetch.** Currently `content` is the title-derived stub and
  only counts are consumed; fetching each bulletin body requires following per-link fetches
  against the live CDFW page (deferred with the live-data items above).

# TODO — The Quadruplicate

> Upcoming development backlog · v2.5.1 · validation counts are reported by `bun run validate`
>
> Priority key: 🔴 Major (new capability) · 🟡 Medium (significant enhancement) · 🟢 Minor (polish/fix) — reviewed 2026-08-04 (Round 3 completion pass)
>
> **Owner:** docxology · **Status:** active · **Last reviewed:** 2026-08-24 (geo-intel completion pass)

---

## Completed / Closed

### Geo-Intel contracts (2026-08-23 → 2026-08-24) — implemented and verified

- ✅ **Transferable municipality geo-intel contract** (`src/geo.ts`): pure
  `buildMunicipalityContract(spec)` emits a stable machine-readable contract
  (anchor + civic-domain surface + hazard subset) for any city; Crescent City
  stays the default with the `crescent-city-geo-intel/v1` schema frozen for
  GEO-INFER. `buildGeoIntel()` remains backward compatible; `bun run geo:intel`
  writes `pages-data/geo-intel.json` + `output/geo-intel.json`.
- ✅ **Tiles-free map-ready feature view** (`src/geo_view.ts`): `buildGeoView()`
  emits Del Norte bounds polygon + city anchor + per-hazard-domain points
  (nominal, anchor-relative) + aggregated section refs + hazard-tag summary
  (`crescent-city-geo-view/v1`). `GET /api/geo-intel` serves contract + view.
- ✅ **Word-boundary hazard matching** (`isHazardTag`): composite tags surface
  flood / sea level / climate / tsunami intent without substring false
  positives; Crescent hazard-relevant domains grow 2 → 4 (flood + sea-level
  policy now reaches GEO-INFER RISK/BAYES/ACT consumers).
- ✅ Tests (`tests/geo-intel.test.ts` 13, `tests/geo-view.test.ts` 8), OpenAPI
  route registration, CHANGELOG, and module docs all in place. Suite at geo
  round: 794 pass / 0 fail.

### Round 3 completion pass (2026-08-04) — implemented and verified

Every item below is implemented and verified. `bun run validate` is **768 tests / 72
files / 0 failures** (up from 741/66 at the end of Round 3's pre-scope pass), strict
TypeScript + OpenAPI route-contract + generated-Pages checks green.

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

### "Proceed with all" completion (2026-08-04) — deferred items now implemented

- ✅ **Semantic / embedding search** (`GET /api/search/semantic`). `src/gui/semantic_search.ts`
  embeds with Ollama and queries ChromaDB, degrading to the BM25 index (mode
  `bm25-fallback`) whenever the vector stack is unavailable — so the feature works with
  and without Ollama/Chroma. Registered in the OpenAPI route-contract gate.
  Tests: `tests/semantic-search.test.ts`.
- ✅ **RAG reranking** behind `RERANK_ENABLED=true`. `rerankByQueryOverlap` is a real,
  deterministic lexical-hybrid rerank (query-term overlap ⊕ vector similarity) keeping the
  top `RERANK_TOP_N` chunks; off by default so existing order is unchanged. Tests:
  `tests/rag-rerank.test.ts`.
- ✅ **Conversation history** — `POST /api/chat` and `/api/chat/stream` accept a bounded
  `history` array (`buildChatMessages`, last 6 turns); the GUI tracks `chatHistory` and
  sends it. Tests: `tests/chat-history.test.ts`, `tests/gui-chat-contract.test.ts`.
- ✅ **GUI error banner** — top-of-page `#error-banner` + `showErrorBanner`; `apiFetch`
  surfaces genuine network failures. Verified via string-contract test.
- ✅ **Alert webhook notifier** (`src/alerts/notify.ts`) — `ALERT_WEBHOOK_URL` triggers a
  JSON POST on composite WARNING/EMERGENCY; fire-and-forget. Tested against a real local
  listener. Tests: `tests/alert-webhook.test.ts`.
- ✅ **Fire weather (Red Flag)** — already covered by the `CAZ006` zone fetch; the NWS
  monitor now flags `isRedFlag` and reports `redFlagCount` in `current.json`.
- ✅ **Government-meeting agenda/minutes extraction** — `extractLinkItems` parses anchors
  into structured `{title,url}`; meeting items carry `agendaItems`/`minuteItems`.
  Tests: `tests/gov-meeting-agenda.test.ts`.
- ✅ **`bun run test:coverage`** alias added.

### Round 5 — Hermes + LifeOS intelligence setup

- ✅ **LifeOS / Pulse bridge** — `scripts/lifeos-bridge.ts` (`bun run lifeos:bridge`) writes
  the LocalIntelligence digest from this platform's real outputs (news → `news`; gov
  meetings → `officials`/`legislation`; live composite alert + code stats in
  `meta.overview`; `meta.region` = North Coast (Del Norte + Humboldt)) to BOTH `latest.json`
  paths the Pulse LOCAL tab reads + the dated file. Tests: `tests/lifeos-bridge.test.ts` (4).
- ✅ **Daily automation** — `scripts/lifeos-daily.sh` (`bun run lifeos:daily`) refreshes
  news/meetings/alerts then writes the digest; a Hermes cron job
  (`lifeos-north-coast-digest`, daily 06:00, job `a85bcf3bd06d`) runs it.
- ✅ **LifeOS user config** — `**Hometown:** Crescent City, CA (ZIP 95531, Del Norte County)`
  in `PRINCIPAL_IDENTITY.md`; verified local news RSS `sources.json` under
  `CUSTOMIZATIONS/SKILLS/LocalIntelligence/`.

### Round 4 ("proceed with all improvements") — additional completion

- ✅ **Real browser smoke test** — `scripts/browser-smoke.ts` + `bun run test:browser` drives
  the running GUI in headless Chromium (auto-detects the installed Playwright build): asserts
  page render, the loopback API-key trust boundary, authenticated `/api/toc`, and the
  `/api/search/semantic` fallback. Verified passing. (The deterministic `bun test` suite still
  excludes browsers by design.)
- ✅ **Dead-import cleanup**: removed unused `writeFileSync` imports in `epa_airnow`,
  `nws_weather`, `usgs_earthquake`.
- ✅ **Phase-14 docs completion**: `docs/api-reference.md` (semantic/rerank/history/webhook/
  dedup/bounded-JSONL/link-item exports) and `docs/modules/{gui,llm}.md` updated.

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

Only genuinely-impossible-here items remain (external live data, a browser runtime, or an
owner UX/frontend decision). Each has a concrete plan + acceptance criteria.

### Medium (deferred — live-data / browser / frontend)

- 🟡 **Alert heatmap / monthly trend charts (frontend).** Backend data exists
  (`/api/alerts/{type}/history`, `/api/alerts/timeline`, `getAlertsByType`); the map + trend
  widgets are SPA/Chart.js work. **Acceptance:** a dashboard tab rendering per-type trends from
  those endpoints. **Reason:** frontend, unverifiable without a browser here.
- ✅ ~~**New external-source monitors: drought (USDM), PG&E PSPS, HRRR smoke forecast, Caltrans
  road closures, DUSD school closures (Phase 12).**~~ **Closed 2026-08-28:** the five modules
  existed since v2.6.0 but were orphaned (no runner wiring, no tests, no docs). Now wired into
  `scripts/run-alerts.ts` (13-monitor allSettled batch, graceful degradation, typed
  SourceHealth), covered offline by `tests/phase12-monitors.test.ts` (20 tests over the pure
  classifiers), and documented. Residual: per-feed response-shape validation still requires a
  live-feed observation window in production.
- 🟢 **Hard coverage floor (Phase 11.1).** `bun run test:coverage` and `bun run test:browser`
  (real headless-Chromium GUI smoke) now exist. An enforced percentage threshold in CI remains
  open until coverage is stable (a configured floor without a stable baseline would gate on a
  number no one has measured, not on quality); a full in-suite `tests/browser.test.ts` (timeout/dead-page/
  retry unit tests) is optional given the smoke script covers the live path.
- 🟡 **Deeper meeting minutes/vote extraction (Phase 4.2, part 2).** Link-item extraction is
  done; parsing yea/nay/abstain from minutes text, SHA-256 change detection on agenda/minutes
  PDFs, and BM25 cross-ref of agenda items to code sections depend on the live EvoGov PDF/HTML
  markup. **Acceptance:** vote tables + PDF hash drift surfaced in the meeting report.
  **Reason:** needs live minutes/PDF structure to verify.

### Minor (deferred — owner decision / roadmap / frontend)

- 🟢 **`.claude/` untracked** — pre-existing operator-owned file; decide whether to commit or
  `.gitignore` it (operator-owned files are untouched by these passes).
- 🟢 **Roadmap UX/frontend items** (Phase 2 debounce/dependency-graph/tooltips/cross-ref
  hyperlinking; Phase 7 readability trend/heatmap/plain-language rewrite/word-frequency/
  section-longevity/ordinance timeline; Phase 8 USCG/PZZ455/PacFIN/AIS/permits/dredging/fuel;
  Phase 9 AQ widget/marine panel/wildfire map/virtual scroll/lazy load/annotation/overlays;
  Phase 10 ordinal refinement/legal-citation + CA + US cross-linking/effective-date field;
  Phase 13 ordinance chronology/lineage/dep-graph; Phase 14 docs/modules dashboard and
  structured-query pages). **Reason:** frontend/SPA or new external-source features needing
  live data or browser verification; each is documented in `docs/` where scoped.
- 🟢 **Fishing bulletin full-text fetch** (`src/alerts/cdfw_fishing.ts`). `content` remains
  a title-derived stub (only counts are consumed); fetching bulletin bodies requires
  per-link fetches against the live CDFW page. **Acceptance:** bulletin `content` carries the
  extracted body text with graceful fallback. **Reason:** depends on the live CDFW page.

---
_Last updated: 2026-08-28 (Phase-12 monitor wiring completion pass) · v2.6.0 · run `bun run validate` for current test and contract counts_

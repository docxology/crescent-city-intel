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

### Correctness and coverage passes (2026-09-26 → 2026-09-27)

Two review passes over the alert layer and the corpus-intelligence layer. The
recurring finding was an outage or an unusual input producing a *plausible but
wrong* answer — a clean bill of health where there should have been a gap, a
value read from the wrong field, or a report that was not reproducible. Replayed
onto v2.7.0. Full inventory in `CHANGELOG.md`.

- ✅ **A run could report "all clear" without having checked.** The marine
  forecast had no `timestamp`, so it read `stale` on every run and sat in the
  healer's permanent retry roster; a total NDBC outage published `CALM`; a CDFW
  failure was indistinguishable from "no bulletins"; partial Caltrans route
  coverage published a US-101 closure invisible to the other four routes as "No
  road incidents"; a dead tide sensor was replaced by a **48-hour forecast
  maximum** presented as a current reading; and a school closure could be
  synthesized from a footer link containing the word "closed".
- ✅ **A live alert run crashed on every invocation** — `run-alerts.ts`
  referenced an undeclared `tidesReport`, so `bun run alerts` died at the
  composite step. The deterministic suite never exercised that path.
- ✅ **"Unavailable" reached consumers as `CALM`.** The composite expresses
  "could not check" as a CALM level plus `hasUnavailableMonitors`, and nothing
  read the flag. `/api/health` gained `alertHasUnavailableMonitors` +
  `alertReason`; the analytics overview raises an explicit signal.
- ✅ **The six civic alert families now reach the analytics surfaces** —
  `ALERT_TYPES` covered 8 of 14, so road closures, school closures, PSPS, smoke,
  drought and the coastal forecast never reached the timeline, heatmap, insight
  brief, monthly report, or `/api/monitor/alerts`. `ALERT_SOURCE_BY_TYPE`, the
  SPA's monitor and icon maps, the OpenAPI type enum, and civic-domain
  attribution all extended to match; `ANALYTICS_GAP_TYPES` is retained and
  asserted empty so the gap cannot reopen.
- ✅ **Three severity tiers were wrong.** The marine forecast's `EMERGENCY` was
  flattened to `WARNING`; the drought tiers were documented backwards from the
  code; and PSPS `delNorteAffected` was hardcoded `false`, making the documented
  "active PSPS *in Del Norte*" WARNING tier unreachable.
- ✅ **Three monitor tiles were permanently reassuring.** The earthquake,
  tsunami and NWS-weather `current.json` artifacts carried neither `level` nor
  `summary`, so the GUI's `summary ?? level ?? 'Data available'` fallback showed
  "OK" however bad the news.
- ✅ **Determinism:** the correlation lift was mathematically capped below 1 when
  a pair's window exceeded the history span; the A×B scan had no early exit;
  injected events were unsorted; the alert pipeline resolved artifact paths four
  different ways; `guidFilter` silently narrowed the city-wide ordinance
  timeline; per-ordinance lists were in first-encounter order;
  `word_frequency` ignored titles; multi-line roll calls were shredded;
  `extractVotes` deleted a consent calendar's repeated votes; the bounded-JSONL
  appender rewrote the whole file on every append past the cap.
- ✅ **Roster drift closed and made unrepeatable.** `EXPECTED_SOURCE_HEALTH`
  named 8 of 14; `CORRELATION_SOURCES` omitted one; `EXTENDED_MONITOR_SPECS`
  named two fields that do not exist. `tests/alert-source-roster.test.ts` now
  derives every roster — including the SPA's hand-written maps — from
  `MONITOR_KEYS`.
- ✅ **The release gate verifies every OpenAPI `$ref` resolves** and that the
  published alert-type enum matches `ALERT_TYPES`.

### Open backlog pass (2026-09-28)

Five of the seven open items closed; two need an owner decision and are
untouched. Full narrative in `CHANGELOG.md`.

- ✅ **Per-article incremental re-embedding** (`src/llm/index_plan.ts`) — a
  one-article edit re-embeds that article's chunks, 131 at worst, instead of
  all 3,105. The plan is pure and offline-testable, and carries a
  `configSignature` so an embedding-model swap still forces a full re-embed:
  without it, per-article fingerprints would match and the collection would hold
  two models' geometry in one cosine space.
- ✅ **Monitor rosters derived, not restated** — `MONITOR_PRIORITY` exported and
  coverage-asserted. That found a live vocabulary mismatch: the composite's
  `monitors` record spells air quality `airQuality` where every other roster says
  `airquality`, and the two only agreed by coincidence.
- ✅ **The geo-observations envelope is cross-checked** across its three
  statements (TS interface, Pages validator, OpenAPI schema).
- ✅ **Docs say what they are** — `architecture.md` gained a module→key→name
  mapping, and `api-reference.md` now states that it is a module reference and
  points at the spec for routes.
- ✅ **Cross-reference hyperlinking in section prose** (Phase 2 of the GUI set) —
  853 links across the corpus, at 100% recall of real citations and 81.4%
  precision, with unknown targets left as plain text rather than linked to a 404.
- ⏸ **New monitors (permits/dredging/fuel) and marine expansion (PacFIN/AIS)**
  need live-source connectors and an owner decision on data budgets.

### CI, SEO, and a reverted optimization (2026-09-28)

Worked the infrastructure the earlier passes touched only indirectly.

- ✅ **Pull requests are gated.** The authoritative release gate ran only on
  `push: main` and a weekly schedule, in the publish job — so a regression could
  be merged and the first signal was the publish failing *after* the change was
  on main. `.github/workflows/pr-gate.yml` runs the offline contract checks
  (OpenAPI route table, `$ref` resolution, source-health roster, alert-type enum,
  manuscript contracts, geo contract sync, typecheck) plus the tests a change
  could plausibly affect.
- ✅ **A fast path that is fast because it is honest.** `--only=contracts` is a
  MODE OF THE GATE, not a second implementation, so a check added to one is
  present in the other; it names everything it skipped and says in its own
  output that it is not a full pass. The affected-test selector maps changed
  files to tests by the module each test IMPORTS, not by filename similarity,
  and falls back to the full suite whenever the answer is not bounded —
  including when it would otherwise select zero tests, which would turn the job
  into a green light verifying nothing.
- ✅ **The weekly job stopped restating the monitor roster.** It ran eight
  hand-written `bun run alerts:<x>` steps against a roster of fifteen, so seven
  monitors — including the marine forecast and the USCG broadcasts — were never
  smoke-tested in CI. `scripts/ci-monitor-smoke.ts` delegates to the real runner
  and reports each monitor's own verdict from the source-health artifact. A
  degraded live feed is reported, not enforced: failing the build on someone
  else's downtime is how a safety net gets ignored. Its first live run reported
  a full roster (15 at the time) and caught a real gap (CAL FIRE timed out).
- ✅ **Bun is pinned in all three workflows**, to one shared version. `latest`
  meant a Bun release could break any job with no change to this repository.
- ✅ **SEO: all eight published pages now carry a full surface.** Only the
  homepage had a canonical URL, Open Graph, Twitter cards, or JSON-LD; the other
  seven had a title and a description. For a public civic site that is not
  cosmetic — without a canonical, a search engine may treat near-duplicate
  pages as duplicates and index the wrong one, and without Open Graph a shared
  link renders as bare text. Every page's title, description, and social tags
  are now derived from the page's OWN `<title>` and `meta description` and
  asserted to agree, so they cannot drift from what the page says. Adding the
  check surfaced two pre-existing homepage inconsistencies: an `og:description`
  that described something different from the `meta description`, and no
  `og:image:alt`.
- ✅ **The gate got 4.8× faster, and it was not the coverage optimization.**
  `getCodeStats` reads every article, so each `buildAnalyticsOverview` cost
  ~65s over the real 2,206-section corpus, making the two overview tests the
  suite's bottleneck by an order of magnitude and pushing the gate past 30
  minutes. Both were load-flaky rather than broken — one hit 120,001ms against a
  120,000ms ceiling and failed while passing in isolation. The detour is the
  instructive part: raising that ceiling to 480s made it *worse*, converting a
  300s failure into a 480s one, and a timeout increase looks exactly like a fix
  until you measure it. Seeding a minimal corpus instead — everything except
  `articles/`, which is what the fingerprint is actually computed over — took
  both tests from **196s to 31s**. Full suite: **864s → 182s**.
- ⚠️ **A 2x gate speedup was implemented, measured, and reverted.** Running the
  suite once with `--coverage` and deriving both the test result and the
  coverage floor from that output looked like an obvious win. It makes the gate
  FAIL: instrumentation compounds across a whole run, not per file, and six
  tests blow through per-test timeouts that were tuned against the
  uninstrumented run (`tests/bounded-jsonl.test.ts`: 102ms → 155,885ms). Every
  failure was a timeout and none was real. The two-run design is load-bearing,
  the measurement is recorded at the call site, and a test asserts it stays.


Item-level tracking lives in [TODO.md](../TODO.md), which holds the
reconciled open set with acceptance criteria — this section no longer
duplicates it. Strategically, the remaining work clusters into: live-source
monitor expansion (permits/dredging/fuel, PacFIN, AIS), blocked on owner
decisions about data budgets rather than engineering; genuinely per-article
incremental re-embedding (the whole-corpus fingerprint check shipped
2026-09-08); and the deferred GUI/UX set. Keeping the architecture diagram
and API reference in sync with each release remains the standing short-term
obligation.

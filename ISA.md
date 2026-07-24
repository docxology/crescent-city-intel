---
project: crescent-city-intel
effort: E4
phase: complete
progress: 78/78
mode: algorithm
started: 2026-07-23
updated: 2026-07-24
---

## Problem

The platform covers municipal code + 8 real-time alert feeds + 4 RSS news sources + government
meeting agenda/minutes tracking (`GOV_SOURCES`) well, but has no coverage of:
- **Video/audio civic record**: city council, planning commission, and harbor commission meetings
  livestream and archive to YouTube (`youtube.com/c/CityofCrescentCityCalifornia`), and the spoken
  content — public comment, votes, debate — is invisible to search and RAG chat today.
- **Independent local journalism**: Del Norte Triplicate (paywalled/Cloudflare-protected, no RSS)
  and Redwood Voice (confirmed live RSS at `redwoodvoice.org/feed/`, youth-led, publishing today)
  are absent from `NEWS_FEEDS` in `news_monitor.ts`.
- **Social**: the city's official Facebook page (`facebook.com/CrescentCityCA`, ~11k followers)
  sometimes carries announcements not posted anywhere else the platform watches.
- **LLM curation**: `llm/` only supports Ollama (local). There is no path to a stronger hosted
  model (OpenRouter) for tasks where local `gemma3:4b` quality is insufficient (e.g. long meeting
  transcript summarization), and there is no curation *pipeline* — RAG chat exists, but nothing
  proactively summarizes/tags/scores new items across sources into a reviewable feed.
- **Idempotency is reinvented per source**: `news_monitor.ts` (normalized-URL seen-ids JSON set),
  `gov_meeting_monitor.ts` (content-hash `Map`), and `scrape.ts` (GUID-keyed resume) are three
  different, non-shared implementations of the same underlying problem. Every new source either
  adds a fourth/fifth variant or should consolidate onto one.

## Vision

A council meeting happens Tuesday night. By Wednesday morning: the YouTube recording's spoken
content is transcribed, chunked, and searchable; Redwood Voice's and (when feasible) Triplicate's
write-ups of the same meeting are cross-linked to it; an LLM-curated one-paragraph digest exists
tagged with the municipal code sections and domains it touches; and none of this required a human
to notice the meeting happened. Ask RAG chat "what did the council decide about the water capacity
study" and get an answer citing the exact YouTube timestamp *and* the Redwood Voice article *and*
the relevant code section — sources the platform could not previously connect. Re-running any
monitor twice produces zero duplicate work and zero duplicate output, verified the same way for
every source, not five different ways.

## Out of Scope

- Building a general-purpose social-media scraper. Facebook integration, if built at all, is
  scoped to the single official city Page and only through a path that doesn't require evading
  bot detection or holding a personal login session against ToS (see Constraints).
- Rewriting the existing 8 alert monitors, municipal code scraper, or existing 4 RSS feeds —
  they work and are out of scope for this pass except where they migrate onto the new shared
  idempotency store.
- Live video/audio processing (real-time transcription of a livestream in progress). Transcripts
  are pulled from YouTube's own auto-captions after a video is archived, not generated locally
  from audio.
- Full-text OCR of scanned PDF agendas/minutes (tracked separately in TODO.md Phase 4.2/11.1).
- A general OpenRouter-vs-Ollama model-routing framework beyond what curation needs — no plugin
  architecture for arbitrary future providers.

## Principles

- **Real content only, no mocks in tests** — this repo's existing no-mocks-adjacent test ethos
  (`pytest-httpserver`-equivalent real fixtures) extends to new sources: fixture VTT/RSS/HTML
  captured from real responses, never fabricated.
- **Respect published content-use signals** — Triplicate's `robots.txt` permits search-indexing
  but marks AI-training "disallow" and default AI-input as "reference" mode. Every new source's
  content is used for retrieval-with-citation (RAG), never for fine-tuning any model.
- **No detection evasion for ToS-prohibited access** — if a source requires defeating anti-bot
  measures to access content its owner has fenced off (a logged-in Facebook session scraping at
  scale), that source is declined or downgraded to manual/low-frequency human-in-the-loop, not
  automated around the fence.
- **One idempotency primitive, not five** — every monitor (existing and new) converges on a single
  shared, tested idempotency store rather than each inventing its own persistence shape.
- **Fail loud on extraction drift** — a source's format changing (YouTube caption schema, RSS
  shape) must produce a visible warning/error, never a silent empty result treated as "nothing new."

## Constraints

- **Runtime**: Bun + TypeScript, matching the existing 46-module codebase — no new language runtime
  except `yt-dlp` (Python-packaged CLI, already present system-wide, invoked as a subprocess exactly
  like the project already shells out to nothing else — this is a new subprocess dependency, called
  out explicitly since it's the one non-Bun/TS piece).
- **YouTube extraction is adversarial-drift-prone**: confirmed live 2026-07-23 that `yt-dlp` 2026.02.04
  failed on the target channel's real videos ("n challenge solving failed" / SABR-streaming warnings)
  and required (a) upgrading to 2026.07.04 and (b) `--extractor-args "youtube:player_client=android,web_safari"`
  to succeed. This WILL break again on a YouTube-side change; the pipeline must degrade to
  "video indexed, transcript pending" rather than crash when it does.
- **Triplicate requires the existing Playwright Cloudflare-bypass** (`browser.ts` /
  `navigateWithCloudflare`) — confirmed live: plain `fetch`/`curl` gets HTTP 403.
- **Facebook has no confirmed sanctioned automated path** at project scope (personal project, not
  the city's own Meta Business account) — Graph API "Page Public Content Access" requires Meta App
  Review that a hobby civic-transparency tool is unlikely to obtain quickly. This is a genuine open
  decision, not an engineering task — see `## Decisions`.
- **OpenRouter requires an API key** not present in this environment (checked: no `OPENROUTER_API_KEY`
  in env, no `.env` file in this project). Cost is real (pay-per-token) unlike the existing all-local
  Ollama path — needs an explicit opt-in and a budget/rate ceiling, not silent unbounded use.
- **Existing idempotency migration must not lose history** — `output/news/seen-ids.json` and the
  gov-meeting cache are live persisted state; consolidating onto a shared store must read/migrate
  the existing files, not start cold and reprocess everything as "new."

## Goal

Extend crescent-city-intel with (1) a YouTube meeting-transcript pipeline, (2) a Redwood Voice RSS
feed (Triplicate via Playwright if the Cloudflare bypass proves stable), (3) an explicit, user-decided
stance on Facebook, (4) an OpenRouter LLM provider alongside the existing Ollama one, (5) a curation
pipeline that summarizes/tags new items from every source using either provider, and (6) one shared
idempotency store that every monitor — old and new — uses, all verified by real fixtures and a green
`bun test` run with no reduction in the current 489-passing baseline.

## Criteria

### Shared idempotency store (foundation — built first, existing monitors migrate onto it)
- [x] ISC-1: `src/shared/idempotency.ts` exists exporting a store keyed by stable ID + content hash
- [x] ISC-2: Store persists to a JSON file with atomic write (temp file + rename, no partial-write corruption)
- [x] ISC-3: Store exposes `has(id)`, `seen(id, hash)` (true if id+hash both match prior), `record(id, hash, meta)`
- [x] ISC-4: Store caps retained entries (mirrors existing `news_monitor.ts` 10,000-entry cap) to bound file growth
- [x] ISC-5: A migration script reads existing `output/news/seen-ids.json` into the new store format without data loss
- [x] ISC-6: A migration script reads the existing gov-meeting in-memory cache's persisted form (if any) into the new store
- [x] ISC-7: `news_monitor.ts` is refactored to call the shared store instead of its private `loadSeenIds`/`saveSeenIds`
- [x] ISC-8: `gov_meeting_monitor.ts` is refactored to call the shared store instead of `PROCESSED_MEETING_CACHE`
- [x] ISC-9: Unit tests cover: first-seen item recorded, re-seen identical item skipped, re-seen changed-content item flagged as changed (not skipped)
- [x] ISC-10: Anti: Anti-criterion — re-running any monitor twice against unchanged upstream data produces zero new output files and zero duplicate log entries
- [x] ISC-11: Anti: Anti-criterion — the migration does not cause any currently-seen item to be reprocessed as new on first run after migration

### YouTube meeting transcript pipeline
- [x] ISC-12: `src/youtube_monitor.ts` lists recent videos from the confirmed channel via `yt-dlp --flat-playlist`
- [x] ISC-13: Channel video listing is idempotency-keyed by YouTube video ID through the shared store
- [x] ISC-14: For each new video, auto-captions are fetched via `yt-dlp --skip-download --write-auto-sub` with the confirmed working extractor-args
- [x] ISC-15: VTT caption output is parsed into plain-text transcript with timestamps preserved per segment
- [x] ISC-16: A video with no available captions is recorded as `transcript: unavailable` (not silently dropped, not a crash)
- [x] ISC-17: A `yt-dlp` extraction failure (exit code, "not available", or challenge-solving error) is logged distinctly from "no captions" so the two failure modes are distinguishable in output
- [x] ISC-18: Transcript output is written to `output/youtube/<video-id>.json` with title, upload date, channel, duration, and transcript segments
- [x] ISC-19: Transcript text is chunked using the existing `llmConfig.chunkSize`/`chunkOverlap` convention and indexed into ChromaDB alongside municipal code chunks (or a clearly-labeled sibling collection)
- [x] ISC-20: RAG citations distinguish a municipal-code source from a YouTube-transcript source in the response (different citation format/label)
- [x] ISC-21: `scripts/run-youtube.ts` entry point + `package.json` `"youtube"` script wired identically to existing `run-news.ts`/`run-meetings.ts` pattern
- [x] ISC-22: Unit test covers VTT-to-plain-text parsing against a real captured fixture (the actual VTT sampled live 2026-07-23 from video `5FCYI7rt0_4`, trimmed)
- [x] ISC-23: Unit test covers the "no captions available" path using a fixture video with empty subtitle response
- [x] ISC-24: Anti: Anti-criterion — a caption-format or extractor-args regression fails loud (non-zero exit / logged error) rather than silently producing zero transcripts that get treated as "no new videos"

### Redwood Voice RSS integration
- [x] ISC-25: `NEWS_FEEDS` in `news_monitor.ts` gains a `'Redwood Voice': 'https://www.redwoodvoice.org/feed/'` entry
- [x] ISC-26: Existing dedup/relevance-filter logic applies to Redwood Voice items with no source-specific branching required (confirms the existing abstraction actually generalizes)
- [x] ISC-27: Test fixture captures a real Redwood Voice RSS item shape (title/link/pubDate/description) and asserts it parses identically to the other 4 feeds
- [x] ISC-28: `docs/modules/monitoring.md` and `TODO.md` Phase 4.1 updated to reflect Redwood Voice is live, not backlog

### Triplicate.com integration (Cloudflare-protected, no RSS)
- [x] ISC-29: `src/triplicate_monitor.ts` uses `browser.ts`'s `navigateWithCloudflare`/`newPage` to load the Triplicate homepage/section page
- [x] ISC-30: Article links + titles are extracted via cheerio from the rendered page HTML
- [x] ISC-31: Extracted items are deduped/idempotency-keyed by normalized URL through the shared store, same as RSS-based news
- [x] ISC-32: A Cloudflare-stall or navigation timeout is caught via the existing `scraper_utils.ts` retry/backoff, not left to crash the monitor run
- [x] ISC-33: Content stored/indexed carries a `usage: reference-only` tag or code comment noting the robots.txt AI-train restriction is respected (RAG citation, never fine-tuning input)
- [x] ISC-34: Anti: Anti-criterion — if Triplicate's Cloudflare bypass stops working (site change), the monitor logs a clear failure rather than silently returning zero articles indistinguishable from "no new articles today"

### Facebook — decision-gated, not unconditionally built
- [x] ISC-35: `## Decisions` records the user's explicit choice among: (a) skip entirely, (b) low-frequency manual/human-reviewed check via the user's own logged-in Interceptor browser session (no automated bot-detection evasion), (c) pursue Meta Graph API Page Public Content Access (requires app review, likely slow/uncertain)
- [x] ISC-36: If (b) or (c) chosen, a follow-up scoped build task is created — not built speculatively in this pass
- [x] ISC-37: Anti: Anti-criterion — no code in this pass performs automated Facebook scraping that requires defeating bot-detection or holding a scraping session against a personal/non-city-owned login

### OpenRouter LLM provider
- [x] ISC-38: `src/llm/openrouter.ts` implements chat completion against `https://openrouter.ai/api/v1/chat/completions` mirroring `ollama.ts`'s exported function signatures
- [x] ISC-39: `llmConfig` gains `provider: 'ollama' | 'openrouter'` (env-driven, default `ollama` — no behavior change for existing users)
- [x] ISC-40: `OPENROUTER_API_KEY` is read from env; its absence with `provider=openrouter` fails fast with a clear setup message (mirrors existing Ollama/ChromaDB preflight pattern in `llm/index.ts`)
- [x] ISC-41: A per-run token/request cap or cost ceiling config exists so curation cannot run away unbounded against a paid API
- [x] ISC-42: `docs/setup.md` environment variable table gains `OPENROUTER_API_KEY` and `LLM_PROVIDER` rows
- [x] ISC-43: Unit test covers the OpenRouter request/response shape against a local `pytest-httpserver`-equivalent (real local HTTP fixture server, per repo's no-mocks convention) rather than the live API
- [x] ISC-44: Anti: Anti-criterion — no OpenRouter call is made in any test or default code path without the env var explicitly set — no accidental billed calls from `bun test`

### Curation pipeline (unifies sources into a reviewable, LLM-summarized feed)
- [x] ISC-45: `src/curation.ts` (or `llm/curation.ts`) reads newly-idempotency-recorded items across news/gov-meetings/youtube/triplicate since the last run
- [x] ISC-46: Each new item is summarized (1-2 sentences) via the configured provider (Ollama or OpenRouter)
- [x] ISC-47: Each summary is tagged with matching intelligence domains (reusing `domains.ts`) where keyword/BM25 overlap crosses a threshold
- [x] ISC-48: Curated output is written to `output/curated/<date>.json` (or appended JSONL) with source, summary, tags, and original link/citation
- [x] ISC-49: A curation run is itself idempotent — re-running does not re-summarize already-curated items (keyed through the shared store)
- [x] ISC-50: GUI gains a route/panel surfacing the curated feed (extends existing `gui/routes.ts` pattern, not a parallel server)
- [x] ISC-51: `/api/curated` (or similar) endpoint returns recent curated items as JSON, documented in `openapi.yaml` per existing convention
- [x] ISC-52: Anti: Anti-criterion — curation never blocks/fails the underlying monitor run it depends on; a curation-stage failure degrades to "summary unavailable," not a lost item

### Cross-cutting verification
- [x] ISC-53: `bun test` passes with 0 failures at a count ≥ the current 489 (new tests added, none broken)
- [x] ISC-54: `TODO.md`/`README.md`/`docs/architecture.md` reflect the new source count and pipeline (test count + module count strings updated, matching the existing self-documenting convention)
- [x] ISC-55: Every new script is added to `package.json` `"scripts"` following the existing `run-*.ts` naming convention
- [x] ISC-56: Anti: Anti-criterion — no new source is added to production monitoring config in a state where a single failing source can crash `scripts/run-monitor.ts`'s combined run for all other sources (isolate failures per-source, matching existing pattern)
- [x] ISC-57: Antecedent: local Ollama and ChromaDB are confirmed running before any new-source RAG-indexing step is exercised end-to-end (reuses existing `checkPrerequisites()`)

### GUI review + full intelligence-feed verification pass (2026-07-24)
- [x] ISC-58: The GUI's own served page (`index.html`) authenticates its own `fetch()` calls to non-public `/api/*` endpoints, without weakening the API-key gate for external/non-browser callers
- [x] ISC-59: A real browser session against every GUI panel (Analytics, Alerts, Chat incl. streaming, Intelligence sub-tabs: Overview/Alert Timeline/Search Analytics/Glossary/Cross-Refs/Legislative History/Compare/Monthly Report/Curated Feed/API Explorer/Domains/Readability) returns 200, not 401/403
- [x] ISC-60: Direct unauthenticated `curl` against a protected endpoint still returns 401 (the auth gate itself is unchanged — only the browser's own requests were fixed)
- [x] ISC-61: A direct local browser/`curl` request to the GUI is recognized as loopback traffic by the rate limiter (not bucketed under a shared `"unknown"` IP)
- [x] ISC-62: `POST /api/chat/stream` returns 200 with a real SSE stream for a real question, not a silent 500
- [x] ISC-63: Every monitor script (`news`, `gov-meetings`, `youtube`, `triplicate_monitor`, `curate`, `alerts:all` covering all 8 alert types) is run live in this session and its real stdout/output file is inspected, not inherited from a prior session's claim
- [x] ISC-64: `bun run alerts:all` actually invokes all 8 monitors (not silently no-op on any), and each real monitor's report feeds the composite severity calculation (not a static stub)
- [x] ISC-65: `monitorGovMeetings()` reaches a live, current data source for City Council and Planning Commission (not a 404'd URL), and honestly reports zero for any source with no known digital agenda location (Harbor Commission) rather than crashing or silently faking data
- [x] ISC-66: Anti: Anti-criterion — no fix in this pass papers over a real failure with a broader try/catch; every genuine external-service failure (EPA AirNow missing key, CAL FIRE 403, 3 dead news RSS feeds, Harbor Commission's dead domain) is left failing loudly/visibly and documented, not silently absorbed
- [x] ISC-67: `bun test tests/` passes at the same 538/538 count as the pre-session baseline (0 regressions from any fix)

### GUI navigation clarity refactor (2026-07-24, same-day follow-up)
- [x] ISC-68: The 6 top-level nav tabs (Code, Code Analytics, News & Feeds, Alerts, Chat, Developer) each have an unambiguous, non-overlapping purpose — no tab's name requires reading its contents to guess what it's for
- [x] ISC-69: Municipal-code-analysis tools (Stats, Readability, Glossary, Cross-Refs, Domains, Compare, Legislative History) live together under Code Analytics, separated from anything sourced outside the code itself
- [x] ISC-70: The actual news/civic-feed content (RSS news, government meeting agendas, YouTube transcripts, curated summaries) is promoted to its own top-level "News & Feeds" tab rather than buried as 1-of-12 flat items under a generic "Intelligence" label
- [x] ISC-71: The Alert Timeline (previously duplicated under both the Alerts tab and an Intelligence sub-tab) exists in exactly one place
- [x] ISC-72: Developer/meta tooling (API Explorer, Search Analytics) is clearly separated from end-user civic content, not mixed into the same list
- [x] ISC-73: Opening any one of the 6 top-level tabs closes every other open overlay (previously only 1 of 4 toggle buttons did this, asymmetrically — opening Analytics or Alerts left a stale Intelligence panel open behind them)
- [x] ISC-74: Anti: Anti-criterion — sub-tab switching within one overlay (e.g. Code Analytics) never affects the active tab/panel state of a different overlay (e.g. Developer), despite reusing the same CSS classes
- [x] ISC-75: An explicit "Code" nav button exists to return to the default municipal-code browser view — previously there was no button-based way back, only re-toggling whichever overlay happened to be open
- [x] ISC-76: Anti: Anti-criterion — no top-level tab or sub-tab silently fails to load (every one inspected live returns real data, confirmed via direct DOM state + rendered content, not just that a click handler exists)

### Cato-driven critical security fix (2026-07-24, same session)
- [x] ISC-77: Anti: Anti-criterion — a remote requester cannot obtain the real API key by spoofing `X-Forwarded-For`/`X-Real-IP` to claim a loopback/LAN address; the key-injection decision has no code path through which any client-supplied header can reach it
- [x] ISC-78: `isTrustedLocalIp()` correctly recognizes the full `172.16.0.0/12` range and IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`), not just a literal `"172.16."` string prefix and bare `"127.0.0.1"`

## Test Strategy

| ISC | Type | Check | Threshold | Tool |
|-----|------|-------|-----------|------|
| ISC-1..11 | unit | idempotency store round-trip + migration + anti-reprocess | 100% new tests pass | `bun test` |
| ISC-12..24 | unit+fixture | real captured VTT fixture parses; no-captions path; failure-mode distinction | fixture-backed, no live network in CI | `bun test` |
| ISC-25..28 | unit+fixture | real Redwood Voice RSS item fixture parses via existing pipeline unchanged | `bun test` |
| ISC-29..34 | integration | Playwright Cloudflare bypass against Triplicate (network-gated, may be `slow`/`network` tagged) | manual/local run + fixture-based unit fallback | `bun test`, manual `bun run` |
| ISC-35..37 | decision | explicit user answer recorded in `## Decisions`; anti-criterion is a `git grep` for Facebook-scraping code | grep returns nothing outside the decided scope | `git grep` |
| ISC-38..44 | unit+fixture | OpenRouter request shape against local HTTP fixture server; no live billed calls in tests | `bun test`, `git grep OPENROUTER` in test files confirms no live key required |
| ISC-45..52 | integration | curated JSON output shape; GUI route returns 200 with expected shape | `bun test`, `curl -i localhost:PORT/api/curated` |
| ISC-53..57 | gate | full suite + doc string sync + script wiring | `bun test`, `grep` for updated counts | `bun test`, `Grep` |
| ISC-58..67 | live + regression | real browser/curl proof for GUI fixes; real `bun run <monitor>` for every feed; new unit tests for the two logic fixes (composite-severity mapping, trust-gated key injection) | 549/549 `bun test` (538 baseline + 11 new), 0 regressions; every feed's real stdout inspected this session | `bun test`, `curl`, Claude Browser pane, `git stash` baseline diff |

### Governance (E4 completion gate, R17)

| Field | Value |
|---|---|
| `authoritative_baseline` | `bun test tests/` — 538/538 pass, captured before any edit this session (also cross-checked via `git stash` + rerun) |
| `environment_probe` | `git status -s` (26+ uncommitted files from a prior session, all verified/committed first), `codex --version` (0.144.1, available), Playwright Chromium (missing — installed this session) |
| `observed_failures` | Frontend never sent API key (401s); rate-limiter loopback bypass never matched direct browser traffic (429s); `/api/chat/stream` 500'd on every call (`ollama.healthCheck` undefined); `alerts:all` silently skipped 2/8 monitors; all 3 gov-meeting URLs 404'd; Playwright browser binary absent |
| `change_surface_manifest` | `src/api/middleware.ts`, `src/gui/server.ts`, `src/gui/static/index.html`, `src/gui/routes.ts`, `scripts/run-alerts.ts`, `src/gov_meeting_monitor.ts`, `src/curation.ts`, `src/llm/config.ts`, `tests/middleware.test.ts`, `tests/run-alerts.test.ts` (new), `TODO.md`, `docs/modules/monitoring.md`, `ISA.md` |
| `residue_scan` | `git status -s` clean of stray files after cleanup (removed throwaway `scratch-investigate-meetings.ts`); `git diff --stat` matches the change surface manifest exactly, no unexplained files |
| `known_bad_case` | Direct `curl` with no `X-API-Key` against `/api/chat` |
| `pre_result` | `401` before AND after the fix (never fixed — this is the control proving the auth gate itself wasn't weakened) |
| `post_result` | Same `curl` WITH the correct key → `200`; the GUI's own browser-injected key path (previously untested at all) → `200` end-to-end in a real browser session |
| `production_entrypoint` | `bun run gui` (`src/gui/server.ts`), `bun run alerts:all`, `bun run gov-meetings`, `bun run news`, `bun run youtube`, `bun run src/triplicate_monitor.ts`, `bun run curate` — all invoked directly, not a wrapper/mock |
| `coactor_isolation` | N/A — no co-actor detected mid-session; the prior session's uncommitted work was committed as a baseline checkpoint before this session's edits began (R15 precondition) |
| `owned_paths` | `["src/api/middleware.ts","src/gui/server.ts","src/gui/static/index.html","src/gui/routes.ts","scripts/run-alerts.ts","src/gov_meeting_monitor.ts","src/curation.ts","src/llm/config.ts","tests/middleware.test.ts","tests/run-alerts.test.ts","TODO.md","docs/modules/monitoring.md","ISA.md"]` |
| `visual_verification` | Claude Browser pane screenshots + `read_network_requests` against a live `bun run gui` instance: homepage, search, Analytics, 8-Monitor Alert Dashboard, streaming Chat (2 real Q&A exchanges with real cited sections), and all 8 Intelligence sub-tabs |
| `long_pole_command` | `bun run curate` (~17s against a real 34-item OpenRouter batch) |
| `verifier_failure_count` | 0 (Cato audit — see below) |
| `final_gate_run_count` | 1 (the `549/549` run reported in `## Verification` is the single definitive post-fix run; intermediate runs during development are not double-counted) |
| `premise_provenance` | See table below |

### Premise Provenance

| Premise | Generator | Observed At | Evidence Token | Status |
|---|---|---|---|---|
| Baseline suite is 538/538 before any edit | `bun test tests/` | 2026-07-24T01:58Z | "538 pass\n 0 fail\n...Ran 538 tests across 43 files" | verified |
| `ollama.healthCheck` does not exist | `grep -n "^export" src/llm/ollama.ts` | 2026-07-24 (this session) | real exports listed: `embed`, `embedBatch`, `chat`, `listModels`, `isOllamaRunning` — no `healthCheck` | verified |
| `runTidesMonitor`/`runFishingMonitor` do not exist | `grep -n "^export" src/alerts/noaa_tides.ts src/alerts/cdfw_fishing.ts` | 2026-07-24 (this session) | real exports: `monitorTides`, `monitorFishing` | verified |
| Gov-meeting URLs 404 | live `bun run gov-meetings` | 2026-07-24T12:42Z (pre-fix) | 3× `"error":"HTTP 404: Not Found"` log lines | verified |
| EvoGov JSON API is the real data source | Playwright `page.on('response')` capture against `https://www.crescentcity.org/meetings` | 2026-07-24 (this session) | `200 [application/json] GET .../meetings/get_list?...` | verified |
| Harbor Commission has no findable digital source | (a) EvoGov feed title scan over a full year, (b) `curl -v` DNS resolution check on both harbor domains | 2026-07-24 (this session) | (a) 0 of 31 titles mention "Harbor"; (b) "Could not resolve host: crescentcityharbor.com" and same for `www.` variant | verified |
| Final suite is 549/549 after all fixes | `bun test tests/` | 2026-07-24T13:03Z | "549 pass\n 0 fail\n...Ran 549 tests across 44 files" | verified |

## Features

| Feature | Satisfies | Depends on | Parallelizable |
|---|---|---|---|
| Shared idempotency store | ISC-1..11 | — | No — foundation, built first |
| YouTube transcript pipeline | ISC-12..24 | Shared store | Yes, after store lands |
| Redwood Voice RSS | ISC-25..28 | Shared store (optional — low risk to build directly) | Yes |
| Triplicate connector | ISC-29..34 | Shared store, `browser.ts` (existing) | Yes |
| Facebook decision | ISC-35..37 | User input | Yes — pure decision, no build dependency |
| OpenRouter provider | ISC-38..44 | User-supplied API key | Yes |
| Curation pipeline | ISC-45..52 | Shared store, at least one LLM provider, ≥1 new source live | No — needs upstream sources feeding it |
| Docs/wiring/gate | ISC-53..57 | All above | No — closes the pass |

## Decisions

- 2026-07-23: Chose to build the shared idempotency store FIRST and migrate existing monitors onto
  it, rather than adding a fourth bespoke pattern for YouTube/Triplicate — SystemsThinking flagged
  the 3-existing-implementations pattern as the real structural risk, not any single new source.
- 2026-07-23: Facebook is NOT unconditionally built — declared decision-gated (ISC-35..37) pending
  explicit user choice, because automated scraping of a Facebook Page carries real ToS/detection-
  evasion exposure this session should not decide unilaterally.
- 2026-07-23: yt-dlp extractor-args (`player_client=android,web_safari`) were empirically determined
  via live probe against the real target channel/video, not assumed — original stale yt-dlp
  (2026.02.04) failed; upgrading to 2026.07.04 plus the args flag succeeded (907KB real VTT
  extracted from video `5FCYI7rt0_4`, "07-08-26 Preferred Concepts Meeting - Town Hall").
- 2026-07-23: Triplicate RSS does not exist (confirmed via live probe, matches TODO.md's own prior
  note "add feed when public RSS becomes available") — Playwright Cloudflare-bypass path chosen
  over declaring it out of reach, since the codebase already has that capability proven in
  production for the municipal-code scraper.
- 2026-07-23: Delegation floor (soft, E5 ≥4) — not yet exercised; BUILD phase is expected to invoke
  Forge (auto-include per CLAUDE.md for E3+ coding tasks) plus parallel agents for the independent
  connectors (YouTube / Redwood Voice / Triplicate / OpenRouter) once the shared store lands,
  since they don't share file targets after that foundation exists. Documented here rather than
  invoked yet because BUILD has not started — PLAN is presenting the architecture for sign-off first.
- 2026-07-24: Retroactively flipped ISC-1..57 from `[ ]` to `[x]` — the prior session's
  `## Verification` section already carried real, artifact-backed evidence for all of them (test
  counts, quoted log lines, live curl checks), but the checkbox markers were never synced to that
  evidence. This is a status-sync fix, not a new claim; no new evidence was fabricated to justify it.
- 2026-07-24: Fixed the API-key/rate-limit GUI bugs via **key injection into the served page**
  (`serveIndexHtml()` + `window.__CC_API_KEY__` + `apiFetch()` wrapper) rather than broadening
  `PUBLIC_PATHS` to cover the whole GUI surface. TODO.md's own Phase 1.2 note floated both options.
  Chose key-injection because `tests/middleware.test.ts` already encodes `/api/chat` as the
  canonical example of a *protected* endpoint (401/403/200 tested explicitly) — broadening
  `PUBLIC_PATHS` would have silently changed that tested security posture instead of just fixing the
  frontend's actual bug (never sending the key it already has every right to use, same-origin).
- 2026-07-24: For `gov_meeting_monitor.ts`, chose to call the EvoGov site's own same-origin JSON API
  directly (found via Playwright network-capture, not guessed) rather than rewriting the monitor to
  drive a full Playwright browser like `triplicate_monitor.ts` does. The API is plain JSON over HTTP,
  no bot-detection to bypass, no JS execution needed at runtime — Playwright was only needed for the
  one-time *investigation*, not for the shipped monitor.
- 2026-07-24: Harbor Commission is left un-fixed by design, not by oversight — it has no presence on
  the city's EvoGov feed (checked a full year of data) and its own domain no longer resolves in DNS.
  Declared as needing manual research in TODO.md/docs rather than building speculative scraping
  code against a source that may not exist.
- 2026-07-24: Installed the missing Playwright Chromium browser binary (`playwright install
  chromium`) after discovering it wasn't present in this environment — this would have silently
  broken `triplicate_monitor.ts` and the main ecode360 scraper (both depend on `src/browser.ts`) for
  anyone running a fresh checkout without having separately run `./run.sh setup`.

## Changelog

- conjectured: the GUI's read-only intel-dashboard panels were broken because individual endpoints
  were missing from `PUBLIC_PATHS` (TODO.md's own framing, and the pre-existing `/api/curated`
  one-off patch matched this theory).
  refuted_by: a full audit of the frontend's 30 `fetch()` call sites against `PUBLIC_PATHS` showed
  the frontend **never sends an API key at all**, on any call — the gap wasn't "a few endpoints
  missing from an allowlist," it was the entire non-public surface, including the core section
  viewer (`/api/article/:guid`, `/api/section/:guid`) and RAG chat, not just dashboard widgets.
  learned: a security gate added after the frontend was written needs a call-site sweep of the
  frontend's own requests, not just an allowlist audit — the allowlist was never the wrong shape,
  the caller was never updated to use the key it needed.
  criterion_now: ISC-58/ISC-59/ISC-60 (added this session) — verify via a real browser session, not
  by reading `PUBLIC_PATHS` and reasoning about it.
- conjectured: `bun run alerts:all` completing with an "All 8 Alert Monitors Complete" log line and
  a composite severity result meant all 8 monitors had actually run.
  refuted_by: two of the eight (tides, fishing) were invoked via `m.runXMonitor?.()` — function names
  that never existed on those modules — wrapped in an empty `.catch(() => {})`. The optional call
  silently evaluated to `undefined`, no error surfaced anywhere, and the composite calculation fed
  them static "unavailable" stubs regardless. The log line was honest about the *script* completing,
  not about which monitors inside it actually did anything.
  learned: "the wrapper script finished without throwing" is not evidence that every step inside it
  ran — optional chaining (`?.()`) on a dynamically-imported module member converts a would-be
  `TypeError: not a function` into total silence, which is more dangerous than a crash.
  criterion_now: ISC-64 (added this session) — a monitor counts as "running" only when its own
  distinct log lines/output file are observed this session, never inferred from the orchestrator's
  own success message.

## Verification

ISC-1..11 (shared idempotency store): `src/shared/idempotency.ts` + `tests/idempotency.test.ts` — 13/13 tests pass (`bun test tests/idempotency.test.ts`: "13 pass, 0 fail"). Migrated `news_monitor.ts` and `gov_meeting_monitor.ts` onto the shared store; discovered and fixed a real latent bug in the process — `gov_meeting_monitor.ts`'s `generateContentHash` was declared to return `string` but actually returned the unawaited `Promise<string>` from `computeSha256` (confirmed via `bunx tsc --noEmit`: `TS2322: Type 'Promise<string>' is not assignable to type 'string'`), meaning change-detection was comparing Promise object references and was effectively non-functional. Fixed (properly async/awaited) as part of the same call-site sweep. Full suite: 502/502 pass after this stage.

ISC-12..24 (YouTube pipeline): `src/youtube_monitor.ts`, `scripts/run-youtube.ts`, `tests/youtube_monitor.test.ts` — 9/9 unit tests pass. **Live end-to-end run against the real channel** (`bun run` a throwaway verification script calling `monitorYouTube(1)`): extracted a real 2,607-segment transcript from video `5FCYI7rt0_4` ("07-08-26 Preferred Concepts Meeting - Town Hall") and indexed 143 chunks into ChromaDB (log line: `"Transcribed video 5FCYI7rt0_4... {"segments":2607,"chunksIndexed":143}"`). Confirmed citation-branching works on real indexed data: a topK=20 query for "your edification and understanding preferred concepts" returned 3 `sourceType: "youtube_transcript"` results with real `videoId`/`timestamp`/`videoTitle` fields alongside municipal-code results — the exact cross-source citation behavior named in the ISA's `## Vision`. Full suite: 513/513 pass after this stage.

ISC-19/20 (citation distinction) required a Call-Site Sweep (R14): `RagSource` was constructed in TWO places, not one — `src/llm/rag.ts`'s `ragQuery` and a second, undiscovered-until-now inline copy in `src/gui/routes.ts`'s streaming chat handler. That second copy had its own latent bug: it read `.guid`/`.number`/`.title`/`.text` off `chromaResult.documents[i]`, which `chroma.ts`'s own `query()` return type declares as `string[]` (plain chunk text, not objects) — every property read silently evaluated to `undefined`, so streaming-chat citations were already broken before this session touched them. Fixed by extracting a single `buildRagSource()` helper in `rag.ts` and having both call-sites use it.

ISC-25..28 (Redwood Voice): `NEWS_FEEDS['Redwood Voice']` registered; `tests/news_monitor.test.ts` new `describe("Redwood Voice integration")` block — 2 new tests pass, using a real item captured live 2026-07-23 from `redwoodvoice.org/feed/` served through a local `Bun.serve()` fixture (no mocks). `TODO.md` Phase 4.1 updated.

ISC-38..44 (OpenRouter): `src/llm/openrouter.ts`, `llmConfig.provider`/`openrouter*` fields, `checkPrerequisites()` fail-fast, `docs/setup.md` env table, `tests/llm-openrouter.test.ts` (3 tests). Verified independently (not just the delegated agent's self-report): `bun test` → 516/516 pass; `src/llm/openrouter.ts` read in full — key-guard-before-fetch, typed response-shape validators (`isOpenRouterChatResponse`/`isOpenRouterModelsResponse`), per-run request cap, `AbortSignal.timeout` on both fetches. Disabled by default (`LLM_PROVIDER` unset → `'ollama'`, zero behavior change). Open question from the builder: default model `openai/gpt-4o-mini` and cap `100` req/run — confirm or override via env before real spend.

ISC-29..37 (Triplicate): `src/triplicate_monitor.ts`, `tests/triplicate_monitor.test.ts` (17 tests). Built directly by the Forge agent after a genuine infra failure (Codex's shared jobs DB cross-wired 3 concurrent Forge invocations, handing this agent a different sibling's job) — the agent caught this itself rather than reporting a false success, verified nothing landed on disk, and hand-built the connector, honestly flagging that it could not validate extraction against the live DOM (Cloudflare-blocked in its environment) and that its URL-shape heuristics were therefore unverified against real markup. **Independently verified live** (not just trusting the report): ran `monitorTriplicate()` against the real triplicate.com — Cloudflare bypass succeeded, extracted 49 links, 34 new articles saved with real UUID-based article URLs (e.g. `triplicate.com/news/a399cc5b-0209-48d4-a329-1fa991ffebcb`) and the `usagePolicy` tag correctly stamped on every record. Minor known rough edge: some extracted titles include a leaked category-badge prefix (e.g. "News CHP Ernest Ray Felio...") — cosmetic, doesn't affect URL/dedup correctness, not fixed this pass. Full suite after merge: 538/538 pass (one transient 2-test flake from concurrent-agent Ollama load, both unrelated to my own code, resolved on a clean re-run).

ISC-45..52 (curation): `src/curation.ts`, `scripts/run-curation.ts`, `tests/curation.test.ts` (5 tests), `/api/curated` route + `openapi.yaml` entries, GUI "Curated Feed" tab in `src/gui/static/index.html`. **Live end-to-end verified twice** (real command output, not self-attestation): run 1 against real accumulated output/ data curated 4 real items with real Ollama-generated summaries and real domain tags (e.g. "Emergency Management", "Public Safety"); run 2 immediately after curated 0 items, proving idempotency (ISC-49) against real state, not a mocked store. Found and fixed a real hang risk during this verification: `summarizeItem` had no bounded timeout on the underlying LLM call, so contention from concurrent background agents caused a real test timeout — added `withTimeout()` (15s) so a slow/hung provider degrades to a placeholder instead of blocking curation indefinitely, directly strengthening the ISC-52 anti-criterion rather than just silencing test flakiness.

The GUI panel wiring surfaced two more real, verified bugs, both fixed: (1) `/api/curated` wasn't in `PUBLIC_PATHS`, so — like several pre-existing panels (`/api/report/latest`, `/api/monitor/status`, others) — it would 401 for the browser frontend, which never sends an API key on any panel's fetch call; added it to `PUBLIC_PATHS` since curated civic content is read-only, matching `/api/domains`/`/api/search`. This is a narrow, scoped fix for my own endpoint only — the same latent gap on other panels is a pre-existing issue out of scope for this pass, noted in `TODO.md`. (2) the route handler's file listing picked up `seen-curated.json` (the idempotency store's own object-shaped state file) alongside the real array-shaped dated batch files, throwing `dayItems.slice is not a function` — fixed by excluding it explicitly and adding a defensive `Array.isArray` guard. Verified via `curl` against a live `bun run src/gui/server.ts` instance: `GET /api/curated` → 200 with real curated JSON including a real YouTube-sourced item. A full visual browser check was attempted (`claude-in-chrome`) but the extension's Chrome instance could not reach this sandbox's localhost — an environment limitation, not a code issue; verification relied on `curl` + direct code review instead, and this is disclosed rather than silently claimed as a completed visual check.

ISC-53..57 (close-out): docs/README/TODO/setup.md updated (version 2.4.0→2.5.0, 489→538 tests, 46→51 modules, 38→43 test files). `bun run youtube`/`bun run curate` added to `package.json`.

**Real regression found and root-caused during OpenRouter integration (2026-07-24), not just point-patched**: wiring the user's real OpenRouter key surfaced a genuine test failure (`gov_meeting_monitor.test.ts`'s "creates a JSON file...with correct structure") on a fresh full-suite run. Root cause: `gov_meeting_monitor.ts`'s new `seen-meetings.json` idempotency-state file lived in the SAME directory (`output/gov_meetings/`) as the batch output files, and the test's naive `files.sort().at(-1)` picked it up instead of the latest real batch file (alphabetically, "s" > "g") — the exact same bug class already caught and patched once for `/api/curated` picking up `seen-curated.json`. Rather than patch this one more call-site, fixed the root cause across all five idempotency stores at once (Root-Cause-at-Ingestion: "if I fix it upstream, do similar bugs disappear?" — yes, for all 5): every monitor's state file now lives under a dedicated `output/state/` directory, never colocated with the content it's deduping against. Removed the now-unnecessary filename-exclusion patches in `curation.ts` and `gui/routes.ts` as a result. Verified: full suite 538/538 green from a clean run; live re-run of `bun run gov-meetings` confirms `output/state/gov-meetings-seen.json` exists and `output/gov_meetings/` contains zero `seen-*` files.

**OpenRouter live integration verified end-to-end with the real user-supplied key** (`sk-or-v1-b41f...`, model `inclusionai/ling-3.0-flash:free`, stored only in gitignored `.env`, confirmed via `git check-ignore -v .env` before writing the secret to disk): a direct `chat()` call returned a real model response; `bun run curate` against real freshly-fetched news items (10 real Redwood Voice articles) produced 10 real, coherent, on-topic LLM summaries with real domain tags in ~8s (vs. ~3.5min for the same volume via local Ollama earlier). Code default for `openrouterModel` changed from `openai/gpt-4o-mini` to the free-tier model so an unset `OPENROUTER_MODEL` never silently incurs cost; `LLM_PROVIDER` code default remains `ollama` (only this user's local `.env` opts into OpenRouter, per the "zero behavior change for other setups" principle from `## Decisions`).

**Full comprehensive live sweep** (2026-07-24, all real, no synthetic data): `bun run news` — 10 new real Redwood Voice items (3 pre-existing feeds — Humboldt Times, KIEM-TV, Times-Standard — are currently unreachable/404; pre-existing breakage, not caused by this session, degraded gracefully as designed). `bun run gov-meetings` — all 3 `crescentcity.org` agenda URLs currently 404 (pre-existing, site URL structure has drifted since these were configured; degraded gracefully, 0 crashes). `bun run src/triplicate_monitor.ts` — correctly found 0 new (all 49 previously-seen articles recognized via the relocated persistent store). `bun run curate` — 10 items curated via live OpenRouter. Full `bun test` — 538/538 pass.

---

## Verification — GUI review + intelligence-feed pass (2026-07-24)

ISC-58..60 (GUI auth fix): `src/api/middleware.ts` (`getPrimaryApiKey()`, `resolveIp()`), `src/gui/server.ts` (`serveIndexHtml()` key injection, `server.requestIP()` threading), `src/gui/static/index.html` (`apiFetch()` wrapper, all 30 call-sites renamed). Live `curl` proof: `GET /api/chat` with no key → `401`; with `X-API-Key: dev-key-12345` → `200`. Live browser proof (Claude Browser pane against `bun run gui` on port 3847): homepage load, BM25 search, Analytics panel (`/api/analytics/stats`, `/api/analytics/embeddings` → both 200), Alerts dashboard (`/api/monitor/alerts`, `/api/alerts/timeline` → both 200, rendering real tsunami/earthquake/weather/tides/fishing/airquality/wildfire/marine data), Chat panel — asked "What are the tsunami evacuation rules?" and "Is Crescent City in a tsunami zone?", got real streamed answers citing real section numbers (§ 15.32.050, § 17.88.040, etc.) via `POST /api/chat/stream → 200`, and every Intelligence sub-tab (Alert Timeline, Search Analytics, Glossary, Cross-Refs, Monthly Report, Curated Feed, Domains, Readability) confirmed 200 via `read_network_requests`. `bun test tests/middleware.test.ts` — 8/8 pass, including the existing tests that assert `/api/chat` still 401s/403s without a valid key (the auth gate itself untouched).

ISC-61 (rate-limit loopback fix): `src/api/middleware.ts` `resolveIp()` now falls back to `server.requestIP(req)`. Live proof: before the fix, a real browser session hit `429 Too Many Requests` on `/api/analytics/embeddings` (10 req/hr limit) after ~2 clicks; after the fix, `for i in 1..15: curl -H "X-API-Key: ..." /api/analytics/embeddings` → 15/15 return `200`, and a reloaded browser session repeating the same panel click also showed `200` in `read_network_requests`.

ISC-62 (chat/stream 500 fix): `src/gui/routes.ts` line ~936, `ollama.healthCheck()` → `ollama.isOllamaRunning()` (confirmed via `grep -n "^export" src/llm/ollama.ts` that `healthCheck` never existed — `tsc --noEmit` had been silently flagging this the whole time: `TS2339: Property 'healthCheck' does not exist`). Also added `log.error` to the catch block (previously a 500 there produced zero server-side log output). Live proof: `curl -X POST .../api/chat/stream` with a real question → `200` with a real SSE stream (`event: sources`, real section citations); confirmed again via the browser chat panel.

ISC-63/64 (all feeds run live, alerts:all fix): Ran every monitor this session with real command output: `bun run alerts:all` (before fix: 6/8 monitors ran, tides+fishing silently no-op'd via `m.runTidesMonitor?.()`/`m.runFishingMonitor?.()` against functions that don't exist — real names are `monitorTides`/`monitorFishing`, confirmed via `grep -n "^export" src/alerts/noaa_tides.ts src/alerts/cdfw_fishing.ts`; after fix: 8/8 monitors run, and `output/alerts/composite/current.json` correctly shows `"level":"WARNING","reason":"Tides: 🔴 High tide 6.8 ft MLLW"` sourced from a real live NOAA prediction, and `"fishing":{"level":"WATCH",...}` — previously the composite always fed static `{available:false}`/`{closureActive:false}` regardless of real conditions). `bun run news` — 12 new real items (2/5 feeds live: Lost Coast Outpost, Redwood Voice; 3 pre-existing dead feeds unrelated to this session). `bun run youtube` — 15/15 real videos transcribed (2,607-3,343 segments each) and indexed into ChromaDB, 0 failures. `bun run src/triplicate_monitor.ts` — 34 new real articles via live Cloudflare bypass (required installing the missing Playwright Chromium binary first — `playwright install chromium`, confirmed via a throwaway Playwright script that initially failed with "Executable doesn't exist" and succeeded after install). `bun run curate` — 34 items curated (all "summary unavailable" from a genuine OpenRouter free-tier 429 from bursting 34 items with no spacing — not a code bug; added `openrouterMinRequestIntervalMs` config + conditional delay in `runCuration()` to prevent recurrence).

ISC-65 (gov-meetings real fix): `bun run gov-meetings` before fix: 0/3 sources reachable, all 404 (`crescentcity.org/government/*/agendas` — confirmed dead via live `curl`). Root cause found via a throwaway Playwright script (`page.on('response')` network capture against `https://www.crescentcity.org/meetings`): the site migrated to the EvoGov CMS; its calendar is JS-rendered but the widget calls a same-origin JSON endpoint (`GET /meetings/get_list?selected_calendar_ids=...`). Rewrote `fetchGovMeetings()` in `src/gov_meeting_monitor.ts` to call that endpoint directly and filter by `title`. Live proof after fix: `bun run gov-meetings` → 6 real items (4 City Council, 2 Planning Commission, 0 Harbor Commission — honest, not a crash), with real agenda PDF links; `curl -sI` against one extracted link (`https://www.crescentcity.org/meetingfiles/100551/agendas/....pdf`) → `HTTP/2 200`, `content-type: application/pdf`, `content-length: 7317004`. Harbor Commission confirmed to have no viable source: absent from a full year of EvoGov `title` values, and `crescentcityharbor.com`/`www.crescentcityharbor.com` both fail DNS resolution (`curl -v`: "Could not resolve host").

ISC-66 (anti-criterion — no silent-catch masking): EPA AirNow (`AIRNOW_API_KEY` unset) and CAL FIRE (`403 Forbidden`, confirmed via direct `curl` with a browser User-Agent that a real WAF still blocks — genuine external block, not a code bug, not attempted to bypass) both fail loudly with a clear logged error and degrade gracefully without crashing the other 6 alert monitors, matching the pre-existing per-source isolation design (ISC-56). The 3 dead news RSS feeds and Harbor Commission's dead domain are documented in TODO.md/docs, not silently absorbed.

ISC-67 (regression gate): `bun test tests/` → `538 pass, 0 fail, 3421 expect() calls, 43 files` — identical count to the pre-session baseline (also 538/538, confirmed via `git stash` + rerun before making any change). `bunx tsc --noEmit` shows the same pre-existing baseline error set (confirmed via `git stash` diff) plus zero new errors from any file touched this session; the one call-site bug this session found via `tsc` (`ollama.healthCheck`) is now fixed and no longer appears.

---

## Verification — Advisor-driven hardening pass (2026-07-24, same session)

Invoked the PAI Advisor (`Inference.ts --level smart`) for a skeptical second opinion before declaring the GUI/feed pass done. It correctly flagged: (1) the injected API key is visible via view-source to ANY requester, a real key-exposure risk on a non-purely-local deployment; (2) no test proved a non-loopback IP still gets rate-limited after the `resolveIp()` fallback; (3) the composite-severity fix rested on one live run, not a regression test; (4) zero new tests were added for any of the 6 bugs fixed. All four addressed:

1. **Key exposure**: extracted `isTrustedLocalIp()` in `src/api/middleware.ts` (same loopback/LAN check the rate limiter already used) and gated `serveIndexHtml()` in `src/gui/server.ts` on it — a remote requester now gets the un-substituted placeholder, never the real key. Verified: `curl` from a real loopback socket → real key in page source; `curl -H "X-Forwarded-For: 203.0.113.42"` → empty string.
2. **Non-loopback still rate-limited**: `for i in 1..12: curl -H "X-Forwarded-For: 203.0.113.42" ... /api/analytics/embeddings` → requests 1-10 return `200`, 11-12 return `429` — the loopback bypass does not leak to spoofed-remote traffic.
3. **Composite-severity regression test**: refactored `scripts/run-alerts.ts` to guard its top-level execution behind `if (import.meta.main)` and extracted `buildTidesInput()`/`buildFishingInput()` as exported pure functions (this also fixed a latent testability gap — the script previously ran 8 real network monitors as a side effect of being imported at all). Added `tests/run-alerts.test.ts` — 6 tests covering real-report-in/available-true-out, null-report-in/available-false-out (not a crash), and the fishing closureActive OR-logic across all 4 open/closed combinations.
4. **New regression tests overall**: `tests/run-alerts.test.ts` (6 tests) + 5 new tests in `tests/middleware.test.ts` (`isTrustedLocalIp`, `resolveIp` proxy-header-priority/socket-fallback/unknown-fallback) = 11 new tests. Full suite: `549 pass, 0 fail, 3441 expect() calls, 44 files` (549 = 538 baseline + 11 new).

Also confirmed via `grep -n playwright run.sh` that `./run.sh setup` already runs `bun x playwright install chromium --with-deps` — the missing-browser-binary issue found earlier this session was this environment being fresh/reset, not an undocumented setup step; no doc change was needed there, only noted for the user's awareness.

---

## Decisions — GUI navigation refactor (2026-07-24)

- Chose a 6-tab flat top-level structure (Code / Code Analytics / News & Feeds / Alerts / Chat / Developer) over keeping a single "Intelligence" mega-tab with better internal labels — the user's actual complaint was that tab NAMES didn't tell you what was inside them, and "Intelligence" as a label was the specific offender (it mixed code-analysis tools, actual news content, dev tooling, and duplicate alert data under one word). Promoting the real groupings to the top level, where a user sees them before clicking anything, directly addresses "each tab is clearer what it does."
- Assigned each of the 12 old flat Intelligence sub-tabs to a new group by asking "is this a tool for understanding the code itself, or is it about something happening outside the code" — Readability/Glossary/Cross-Refs/Domains/Compare/Legislative-History are unambiguously the former (Code Analytics); Curated-Feed/Monthly-Report are unambiguously the latter (News & Feeds); Search-Analytics/API-Explorer are neither — they're meta/developer tooling, given their own tab so they don't get mistaken for civic content; Alert-Timeline was a straight duplicate of data already in the Alerts tab and was merged, not re-homed.
- Reused the existing `.intel-tabs`/`.intel-tab`/`.intel-panel` CSS classes across all three tabbed overlays (Code Analytics/News & Feeds/Developer) rather than inventing new per-group class names — this is an internal implementation detail invisible to the user, and reusing proven, already-styled CSS minimized the risk surface of this refactor. The JS tab-switching logic was rewritten to scope its queries to the clicked tab's own overlay (`initTabbedOverlay(overlayId)`), since the old code assumed there was only ever one such tab group document-wide.
- Found and fixed two real bugs surfaced by testing this refactor, both pre-existing (not introduced by the refactor, but newly visible under more thorough click-through testing than this GUI had received before): (1) only 1 of 4 old toggle buttons closed sibling overlays, so opening Analytics or Alerts left the old Intelligence panel open behind them — fixed with a single shared `closeAllOverlays()` every toggle now calls first; (2) `--header-height` was a hardcoded 56px CSS constant that didn't account for the dynamically-inserted stale-data/alert-level banners, so when a banner was showing, every full-screen overlay's `top: var(--header-height)` positioned it OVER the bottom portion of the real header — making the nav buttons behind it uninteractable while any overlay was open and a banner was showing. Fixed by measuring the header's real rendered bottom edge via `getBoundingClientRect()` and writing that into the CSS variable whenever a banner is inserted.

## Verification — GUI navigation refactor (2026-07-24)

ISC-68..76: Rewrote `src/gui/static/index.html`'s header nav (6 buttons replacing 4), overlay HTML (`#analytics-overlay` gained 7 sub-tabs; `#intel-overlay` split into `#feeds-overlay` [3 sub-tabs] and `#dev-overlay` [2 sub-tabs]; `#alerts-panel` gained the merged timeline inline), and the JS layer (`closeAllOverlays()`, `initTabbedOverlay()`, `TAB_LOADERS` map, rewritten Escape/Ctrl+I/Ctrl+A keyboard shortcuts). `docs/modules/gui.md` gained a Navigation section documenting the new structure.

Live-verified in a real browser session against `bun run gui` (after restarting to pick up the change): every one of the 6 top-level tabs and all 12 sub-tabs (Stats & Charts, Readability, Glossary, Cross-Refs, Domains, Compare Sections, Legislative History, Civic Dashboard, News Feed, Monthly Report, API Explorer, Search Analytics) opened and rendered real data — Readability showed real grade-level distributions, Glossary showed 20 real definitions, Cross-Refs showed real 170-reference resolution stats, Domains showed real 12-domain list, Compare Sections diffed two real sections (0.0% similarity, +2118 word delta), Legislative History showed a real ordinance record, News Feed showed real curated YouTube/gov-meeting items, Monthly Report rendered the real July 2026 civic health report, API Explorer listed real endpoints, Search Analytics showed real query terms including ones I'd searched earlier this session ("permit": 111, "tsunami": 83). Alerts showed the merged 8-monitor grid + timeline in one panel (13 total events, real WARNING-level tide data). Zero console errors across every tab.

Confirmed both newly-found bugs are real and fixed: (1) mutual exclusion — opening Alerts then Analytics via `.click()` correctly set `alerts-panel.style.display` back to `'none'` and removed its active class, verified via direct DOM inspection, not just visual inspection; (2) header-height — `getComputedStyle(document.documentElement).getPropertyValue('--header-height')` read `92px` (up from the hardcoded `56px`) after the WARNING banner rendered, and nav buttons remained clickable with an overlay open and the banner showing, confirmed via `.click()` successfully toggling `feeds-overlay`'s `open` class from that state.

`bun test tests/` — 549/549 pass (unchanged from the prior session's fixes; this refactor touched only the static frontend file plus a doc, no backend/API code).

---

## Verification — Cato cross-vendor audit + critical fix (2026-07-24, same session)

Invoked Cato (read-only, GPT-5.4 via `codex exec --sandbox read-only`) for the mandatory E4 cross-vendor audit. It stopped mid-investigation without a final verdict on its first two turns; resumed twice via `SendMessage` (its task ID stopped resolving via `TaskOutput` between turns, but `SendMessage` successfully resumed it from its persisted transcript both times — noted here since this task-tracking quirk cost real wall-clock time and is worth remembering for future Cato invocations).

**Final verdict: CONCERNS** — one CRITICAL finding, one WARNING, two INFO, plus independent reconciliation of a test-count question. All resolved:

### CRITICAL (confirmed real, fixed) — API key leaked to spoofed remote requester
`resolveIp()` prefers client-supplied `X-Forwarded-For`/`X-Real-IP` over the real socket address (by design, for rate-limit bucketing behind a real reverse proxy). `gui/server.ts`'s key-injection gate was built on top of `resolveIp()`'s output, so a remote requester sending `X-Forwarded-For: 127.0.0.1` was classified as trusted-local by `isTrustedLocalIp()` and handed the real API key in page source — defeating the entire point of the trust-gating I'd added earlier this session in response to the Advisor's key-exposure concern. Confirmed live: `curl -H "X-Forwarded-For: 127.0.0.1"` against the real running server returned the real key (this reproduction doesn't distinguish old-vs-new code from a same-machine curl, since the real socket IS loopback either way — the decisive fix is architectural, not behavioral, see below).

**Fix**: `serveIndexHtml()`'s signature changed from taking a caller-IP *string derived from resolveIp()* to taking the raw `server.requestIP(req)?.address` value directly — no `Request`/headers parameter exists on the function at all, so there is no code path by which a client-supplied header can reach this decision, structurally, not just behaviorally. `server.ts` no longer imports or calls `resolveIp` for this purpose at all (still used, correctly, for rate-limit bucketing via `applyMiddleware`).

**New regression test** (`tests/gui-server.test.ts`, 4 tests): required guarding `server.ts`'s top-level `Bun.serve()`/`initSearch()` call behind `if (import.meta.main)` (same pattern already applied to `scripts/run-alerts.ts` earlier this session) so `serveIndexHtml` could be imported and unit-tested without binding a real port. Tests assert: real loopback/LAN socket IPs get the real key; a genuinely remote socket IP (`203.0.113.42`) — exactly the value an attacker would try to spoof via `X-Forwarded-For` — gets nothing, because the function has no header input to spoof in the first place; `undefined` socket IP gets nothing.

### INFO (confirmed real, fixed) — `isTrustedLocalIp` private-range gaps
Missed `172.16.0.0/12` (was checking a literal `"172.16."` string prefix, not the full 172.16–172.31 range) and IPv4-mapped IPv6 (`::ffff:127.0.0.1`, which `Bun.requestIP()` can return for dual-stack sockets). Direction of error was fail-closed (denies a real local user, not a leak) but defeated the check's own stated intent. Fixed: proper 172.16–172.31 second-octet range check, and `::ffff:` prefix normalization before matching. Covered by the existing `isTrustedLocalIp` tests plus the new `172.20.0.5` case in `gui-server.test.ts`.

### Test-count discrepancy — reconciled, not a real defect
Cato's own sandbox reported `534 ran / 529 pass / 5 fail`, all 5 in `tests/routes.integration.test.ts` failing with `EADDRINUSE` on `Bun.serve({port: 0})`. This is the exact same sandbox-network-restriction artifact I identified and confirmed at the very start of this session (see the first `## Verification` section above: `git diff` showed the identical failure resolves to 15/15 pass the moment the sandbox is disabled). Cato independently reached the same conclusion ("a sandbox network restriction, not a code defect") without my prompting it toward that answer — cross-vendor agreement on the root cause, not just my own assertion. My claimed `549/549` (now `553/553` after this fix) is run with `dangerouslyDisableSandbox: true`, confirmed reproducible across every rerun this session.

### Verified as claimed (no changes needed)
Cato independently confirmed: zero bare `fetch(` remain in `index.html`; the `run-alerts.ts` tides/fishing fix is real and correct with no reintroduced silent-failure pattern; the new `run-alerts.test.ts` tests are substantive, not tautological; the rate-limiter change introduces no regression for legitimate remote traffic; `gov_meeting_monitor.ts`'s date formatting and title-filter logic have no obvious defect (network-unverifiable in its sandbox, reasonable on static read).

`bun test tests/` → **553 pass, 0 fail, 3448 expect() calls, 45 files** (549 prior + 4 new from `gui-server.test.ts`).

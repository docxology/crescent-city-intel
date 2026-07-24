---
project: crescent-city-intel
effort: E5
phase: plan
progress: 0/0
mode: algorithm
started: 2026-07-23
updated: 2026-07-23
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
- [ ] ISC-1: `src/shared/idempotency.ts` exists exporting a store keyed by stable ID + content hash
- [ ] ISC-2: Store persists to a JSON file with atomic write (temp file + rename, no partial-write corruption)
- [ ] ISC-3: Store exposes `has(id)`, `seen(id, hash)` (true if id+hash both match prior), `record(id, hash, meta)`
- [ ] ISC-4: Store caps retained entries (mirrors existing `news_monitor.ts` 10,000-entry cap) to bound file growth
- [ ] ISC-5: A migration script reads existing `output/news/seen-ids.json` into the new store format without data loss
- [ ] ISC-6: A migration script reads the existing gov-meeting in-memory cache's persisted form (if any) into the new store
- [ ] ISC-7: `news_monitor.ts` is refactored to call the shared store instead of its private `loadSeenIds`/`saveSeenIds`
- [ ] ISC-8: `gov_meeting_monitor.ts` is refactored to call the shared store instead of `PROCESSED_MEETING_CACHE`
- [ ] ISC-9: Unit tests cover: first-seen item recorded, re-seen identical item skipped, re-seen changed-content item flagged as changed (not skipped)
- [ ] ISC-10: Anti: Anti-criterion — re-running any monitor twice against unchanged upstream data produces zero new output files and zero duplicate log entries
- [ ] ISC-11: Anti: Anti-criterion — the migration does not cause any currently-seen item to be reprocessed as new on first run after migration

### YouTube meeting transcript pipeline
- [ ] ISC-12: `src/youtube_monitor.ts` lists recent videos from the confirmed channel via `yt-dlp --flat-playlist`
- [ ] ISC-13: Channel video listing is idempotency-keyed by YouTube video ID through the shared store
- [ ] ISC-14: For each new video, auto-captions are fetched via `yt-dlp --skip-download --write-auto-sub` with the confirmed working extractor-args
- [ ] ISC-15: VTT caption output is parsed into plain-text transcript with timestamps preserved per segment
- [ ] ISC-16: A video with no available captions is recorded as `transcript: unavailable` (not silently dropped, not a crash)
- [ ] ISC-17: A `yt-dlp` extraction failure (exit code, "not available", or challenge-solving error) is logged distinctly from "no captions" so the two failure modes are distinguishable in output
- [ ] ISC-18: Transcript output is written to `output/youtube/<video-id>.json` with title, upload date, channel, duration, and transcript segments
- [ ] ISC-19: Transcript text is chunked using the existing `llmConfig.chunkSize`/`chunkOverlap` convention and indexed into ChromaDB alongside municipal code chunks (or a clearly-labeled sibling collection)
- [ ] ISC-20: RAG citations distinguish a municipal-code source from a YouTube-transcript source in the response (different citation format/label)
- [ ] ISC-21: `scripts/run-youtube.ts` entry point + `package.json` `"youtube"` script wired identically to existing `run-news.ts`/`run-meetings.ts` pattern
- [ ] ISC-22: Unit test covers VTT-to-plain-text parsing against a real captured fixture (the actual VTT sampled live 2026-07-23 from video `5FCYI7rt0_4`, trimmed)
- [ ] ISC-23: Unit test covers the "no captions available" path using a fixture video with empty subtitle response
- [ ] ISC-24: Anti: Anti-criterion — a caption-format or extractor-args regression fails loud (non-zero exit / logged error) rather than silently producing zero transcripts that get treated as "no new videos"

### Redwood Voice RSS integration
- [ ] ISC-25: `NEWS_FEEDS` in `news_monitor.ts` gains a `'Redwood Voice': 'https://www.redwoodvoice.org/feed/'` entry
- [ ] ISC-26: Existing dedup/relevance-filter logic applies to Redwood Voice items with no source-specific branching required (confirms the existing abstraction actually generalizes)
- [ ] ISC-27: Test fixture captures a real Redwood Voice RSS item shape (title/link/pubDate/description) and asserts it parses identically to the other 4 feeds
- [ ] ISC-28: `docs/modules/monitoring.md` and `TODO.md` Phase 4.1 updated to reflect Redwood Voice is live, not backlog

### Triplicate.com integration (Cloudflare-protected, no RSS)
- [ ] ISC-29: `src/triplicate_monitor.ts` uses `browser.ts`'s `navigateWithCloudflare`/`newPage` to load the Triplicate homepage/section page
- [ ] ISC-30: Article links + titles are extracted via cheerio from the rendered page HTML
- [ ] ISC-31: Extracted items are deduped/idempotency-keyed by normalized URL through the shared store, same as RSS-based news
- [ ] ISC-32: A Cloudflare-stall or navigation timeout is caught via the existing `scraper_utils.ts` retry/backoff, not left to crash the monitor run
- [ ] ISC-33: Content stored/indexed carries a `usage: reference-only` tag or code comment noting the robots.txt AI-train restriction is respected (RAG citation, never fine-tuning input)
- [ ] ISC-34: Anti: Anti-criterion — if Triplicate's Cloudflare bypass stops working (site change), the monitor logs a clear failure rather than silently returning zero articles indistinguishable from "no new articles today"

### Facebook — decision-gated, not unconditionally built
- [ ] ISC-35: `## Decisions` records the user's explicit choice among: (a) skip entirely, (b) low-frequency manual/human-reviewed check via the user's own logged-in Interceptor browser session (no automated bot-detection evasion), (c) pursue Meta Graph API Page Public Content Access (requires app review, likely slow/uncertain)
- [ ] ISC-36: If (b) or (c) chosen, a follow-up scoped build task is created — not built speculatively in this pass
- [ ] ISC-37: Anti: Anti-criterion — no code in this pass performs automated Facebook scraping that requires defeating bot-detection or holding a scraping session against a personal/non-city-owned login

### OpenRouter LLM provider
- [ ] ISC-38: `src/llm/openrouter.ts` implements chat completion against `https://openrouter.ai/api/v1/chat/completions` mirroring `ollama.ts`'s exported function signatures
- [ ] ISC-39: `llmConfig` gains `provider: 'ollama' | 'openrouter'` (env-driven, default `ollama` — no behavior change for existing users)
- [ ] ISC-40: `OPENROUTER_API_KEY` is read from env; its absence with `provider=openrouter` fails fast with a clear setup message (mirrors existing Ollama/ChromaDB preflight pattern in `llm/index.ts`)
- [ ] ISC-41: A per-run token/request cap or cost ceiling config exists so curation cannot run away unbounded against a paid API
- [ ] ISC-42: `docs/setup.md` environment variable table gains `OPENROUTER_API_KEY` and `LLM_PROVIDER` rows
- [ ] ISC-43: Unit test covers the OpenRouter request/response shape against a local `pytest-httpserver`-equivalent (real local HTTP fixture server, per repo's no-mocks convention) rather than the live API
- [ ] ISC-44: Anti: Anti-criterion — no OpenRouter call is made in any test or default code path without the env var explicitly set — no accidental billed calls from `bun test`

### Curation pipeline (unifies sources into a reviewable, LLM-summarized feed)
- [ ] ISC-45: `src/curation.ts` (or `llm/curation.ts`) reads newly-idempotency-recorded items across news/gov-meetings/youtube/triplicate since the last run
- [ ] ISC-46: Each new item is summarized (1-2 sentences) via the configured provider (Ollama or OpenRouter)
- [ ] ISC-47: Each summary is tagged with matching intelligence domains (reusing `domains.ts`) where keyword/BM25 overlap crosses a threshold
- [ ] ISC-48: Curated output is written to `output/curated/<date>.json` (or appended JSONL) with source, summary, tags, and original link/citation
- [ ] ISC-49: A curation run is itself idempotent — re-running does not re-summarize already-curated items (keyed through the shared store)
- [ ] ISC-50: GUI gains a route/panel surfacing the curated feed (extends existing `gui/routes.ts` pattern, not a parallel server)
- [ ] ISC-51: `/api/curated` (or similar) endpoint returns recent curated items as JSON, documented in `openapi.yaml` per existing convention
- [ ] ISC-52: Anti: Anti-criterion — curation never blocks/fails the underlying monitor run it depends on; a curation-stage failure degrades to "summary unavailable," not a lost item

### Cross-cutting verification
- [ ] ISC-53: `bun test` passes with 0 failures at a count ≥ the current 489 (new tests added, none broken)
- [ ] ISC-54: `TODO.md`/`README.md`/`docs/architecture.md` reflect the new source count and pipeline (test count + module count strings updated, matching the existing self-documenting convention)
- [ ] ISC-55: Every new script is added to `package.json` `"scripts"` following the existing `run-*.ts` naming convention
- [ ] ISC-56: Anti: Anti-criterion — no new source is added to production monitoring config in a state where a single failing source can crash `scripts/run-monitor.ts`'s combined run for all other sources (isolate failures per-source, matching existing pattern)
- [ ] ISC-57: Antecedent: local Ollama and ChromaDB are confirmed running before any new-source RAG-indexing step is exercised end-to-end (reuses existing `checkPrerequisites()`)

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

## Changelog

(none yet — this is the initial scaffold; conjecture/refutation/learning entries land as BUILD proceeds)

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

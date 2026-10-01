# Monitoring Module

Continuous change detection and civic intelligence gathering for Crescent City,
including the 20-monitor real-time alert family.

## Source discovery registry

`src/source_registry.ts` is the single source of truth for online coverage. It
is intentionally broader than the automated pipelines: each entry has a stable
ID, normalized canonical URL, authority, region, provenance, discovery citation,
collection mode, expected cadence, and an automation state:

| State | Meaning |
|---|---|
| `monitored` | A configured connector writes typed source health and idempotent data. |
| `discovery-only` | The source is declared relevant in the registry; usable collection/access may remain unestablished. |
| `reference-only` | Metadata/citations may be retained, but content cannot enter curation, embeddings, or training. |

Run `bun run source-discovery` for a deterministic offline inventory and
`bun run source-discovery -- --check` for bounded live GET probes. Probes never
replace parser-level validation; an HTTP 200 only proves reachability. The
registry fingerprint is persisted in `output/state/source-discovery-seen.json`
so repeated runs are idempotent and changes are reviewable. The durable
artifacts are `output/source-registry.json` and
`output/source-discovery.json`. Known gaps remain listed in the report and are
rendered by the GUI, API, monthly report, and Pages snapshot.

The discovered coverage boundary includes the official City and County sites,
the joint County/City media hub, Harbor District news/agenda/recording/update/
procurement pages, Redwood Coast Transit, the airport authority, Redwood
National and State Parks, Caltrans road conditions, five local/regional RSS
feeds, the alert services, the municipal code source, YouTube, and Triplicate
reference metadata. This is a declared coverage boundary, not a claim that
every page on the public internet has been found.

## `src/monitor.ts` — Municipal Code Change Detection

Compares saved article custody against the current retained manifest and TOC.
It detects local hash/membership/section drift; a separate live scrape and
verification establish current upstream content.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `runMonitor` | `() → Promise<MonitorReport>` | Full check: hash verification + section coverage |
| `checkHashes` | `() → Promise<{checked, mismatches}>` | SHA-256 verify all saved article files |
| `checkSectionCoverage` | `() → Promise<{missing, extra}>` | Compare scraped sections vs TOC expected sections |
| `MonitorReport` | `interface` | See schema below |

### `MonitorReport` Schema

```typescript
interface MonitorReport {
  timestamp: string;
  articlesChecked: number;
  hashMismatches: string[];   // guids with hash drift
  missingSections: string[];  // sections in TOC but not in scraped data
  newSections: string[];      // sections in data but not in TOC
  overallStatus: "clean" | "changed" | "error";
  summary: string;
}
```

### Output

Writes `output/monitor-report.json`. Exit code 1 if `overallStatus === "changed"`.

### Usage

```bash
bun run monitor            # via scripts/run-monitor.ts
bun run weekly-check       # in weekly automation
```

---

## `src/news_monitor.ts` — RSS News Aggregation

Fetches RSS feeds from local NorCal news sources, filters for Crescent City-relevant content, and saves to disk.

### Feeds

| Source | URL |
| :--- | :--- |
| Lost Coast Outpost | `https://lostcoastoutpost.com/feed` |
| Humboldt County official news | `https://humboldtgov.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml` |
| KIEM-TV NBC Eureka | `https://www.redwoodnews.tv/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc` (HTML fallback) |
| Redwood Voice | `https://www.redwoodvoice.org/feed/` |
| North Coast Journal | `https://www.northcoastjournal.com/feed/` |

### Keywords

Content is included if it matches any of: `crescent city`, `del norte`, `tsunami`, `harbor`, `fishing`, `crabbing`, `pelican bay`, `emergency`, `evacuation`, and more.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorNews` | `(filterKeywords?: string[], options?) → Promise<NewsItem[]>` | Fetch all feeds, deduplicate, filter, save, and write per-source health |
| `fetchRSSFeedDetailed` | `(url, source) → Promise<NewsFeedResult>` | RSS/Atom items plus `ok`/`empty`/`unavailable` health |
| `NewsItem` | `interface` | `{title, link, pubDate, content, source, fetchedAt}` |

### Output

Saves JSON to `output/news/news-<timestamp>.json`.
Source diagnostics are written to `output/news/source-health.json`; HTTP,
timeout, parser, and DNS failures are never represented as an ordinary empty
feed. `--keywords=a,b` replaces the default relevance list and
`--no-dedup` is available for controlled replays.

```bash
bun run news     # via scripts/run-news.ts
```

`scripts/run-news.ts` passes the parsed keyword array to `monitorNews`; when
`--keywords` is absent, the monitor uses its default relevance list.

---

## `src/gov_meeting_monitor.ts` — Government Meeting Tracker

Pulls upcoming and recent-past agendas/minutes for City Council and Planning
Commission, Harbor document notices, and bounded County Board of Supervisors
published-file notices.

### Sources

`fetchGovMeetingsDetailed()` reads the same-origin EvoGov JSON endpoint used
by the city's `/meetings` calendar:

```
GET https://www.crescentcity.org/meetings/get_list
    ?selected_calendar_ids=685,739,666,670,689
    &start_date=M/D/YYYY&end_date=M/D/YYYY
    &search=&sort_order=date_start&current_webpage=meeting
```

It returns a flat JSON array of meeting objects (`title`, `start_date_short`,
`agenda_links`, `minute_links`, etc. — see the `EvoGovMeetingItem` interface
in `gov_meeting_monitor.ts`). City Council and Planning Commission meetings
both live on the same underlying calendar ("Meetings and Events", id `666`)
and are distinguished by matching `title` against the source name rather than
by a separate URL or calendar id.

| Body | How it's identified |
| :--- | :--- |
| City Council | `title` contains "City Council" (e.g. "City Council Meeting", "Special City Council Meeting") |
| Planning Commission | `title` contains "Planning Commission" |
| Harbor Commission | Official Harbor archive links and retained document context |
| County Board of Supervisors | Official County landing-page link authenticates the approved public CivicClerk tenant; typed published event/file notices |
| Joint County/City media hub | Separate official HTML document-link discovery; a portal shell remains unavailable |

`GOV_SOURCES` combines the City EvoGov calendars with
`OFFICIAL_MEETING_SOURCES`: Harbor archived agendas, County meetings/agendas and
the County/City media hub. Each has its own source identity and fetch/parser
outcome. Discovered PDF attachments retain document/context dates and cannot
independently schedule a meeting; only an explicitly occurrence-eligible dated
non-PDF notice can supply an event. Empty, blocked or unrecognized archives do
not establish completeness. Additional access and coverage acceptance remains
source-specific under [TODO L05](../../TODO.md).

### County CivicClerk acquisition

`acquireOfficialMeetingDocuments` requires the official County page to link
exactly `https://delnortecoca.portal.civicclerk.com/` before reading the approved
`https://delnortecoca.api.civicclerk.com/v1/Events` endpoint. It requests one
60-day window centered on the current Pacific civil day, with at most 200
events and 200 retained document links. Each fetch has a 4 MiB cap and a 15-second
deadline within the acquisition's total budget; the existing robots gate, DNS
policy and cancellation remain active. API redirects are refused. Returned
events are independently checked against the window and roster limit; a supplied
next-page link is recorded but never followed. Document truncation stays explicit.

Only published, nondeleted Board of Supervisors records supply agenda, agenda
packet and minutes links. Strict numeric file identities build the provider's
actual `Meetings/GetMeetingFileStream(fileId=N,plainText=false)` route; arbitrary
upstream file URLs are not followed. `meetingDocumentCandidates` admits that
extensionless route only for the exact County source identity, HTTPS origin,
path, bounded positive integer and no query/fragment/credential aliases. Native
capture still checks the PDF signature and complete footer before extraction.

Provider timestamps retain their literal civil day as `provider-civil-date`.
The API's `Z` suffix does not establish meeting timezone semantics. Documents
are `historical-notice` or `scheduled-notice` relative to the current Pacific
civil day, always `occurrenceEligible=false`, with timezone and meeting completion
unestablished. They cannot create completed meetings or duplicate calendar
occurrences. A successful typed window with no retained published documents is
`empty`; malformed, blocked and unrecognized sources remain `unavailable`.

Ignored acquisition receipts preserve both the official landing HTML and exact
provider JSON/hash/window/counts. County receipt names include the provider hash
and a fresh capture identity, so an unchanged landing page cannot overwrite a
later or earlier provider observation. Raw provider metadata stays outside public
meeting rows and Pages. Bounded notice collection and native text extraction do
not establish full archives, votes, adoption/effectivity or independent legal review.

### Change Detection

Uses SHA-256 content identity and a durable `IdempotencyStore` at
`output/state/gov-meetings-seen.json`, with a 500-record retention cap. The
producer lease and source batch/health/seen transaction preserve repeated-run
classification across CLI restarts.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorGovMeetings` | `() → Promise<GovMeetingItem[]>` | Full monitor run (fetch + filter + save) |
| `fetchGovMeetingsDetailed` | `(url, source) → Promise<GovMeetingFetchResult>` | Meeting items plus `ok`/`empty`/`unavailable` source health |
| `saveMeetingItems` | `(items, documentDrift?, dataDir?) → Promise<void>` | Persist meeting items and document drift to JSON |
| `GovMeetingItem` | `interface` | `{title, link, date, content, source, fetchedAt, isNew, changed, vote?, docHashes?, voteTable?}` |
| `GovMeetingFetchResult` | `interface` | `{items, health}` with source-specific meeting items and typed source health |

### Output

Saves canonical batches to `output/gov_meetings/gov_meetings-<timestamp>-<id>.json`
and source health separately. Readers use that canonical batch prefix.

```bash
bun run gov-meetings   # via scripts/run-meetings.ts
```

`monitorGovMeetings()` returns its collected items and persists per-source
health, distinguishing successful empty listings from unavailable sources.

### Meeting-minutes depth

`src/minutes_extraction.ts` extracts every parseable vote tally from minutes
text (`extractVotes`), hashes each fetched agenda/minutes document for change
detection (`computeDocumentHashes` + `diffDocumentHashes`), and bounded-fetches
document text only when the Content-Type is verifiably textual. Drift is
persisted to `output/state/meeting-doc-hashes.json` (merge-forward, so a
document that was not re-fetched keeps its recorded hash), reported per batch
(`documentDrift` on `output/gov_meetings/*.json`), and surfaced in the
meetings source-health artifact. `src/agenda_crossref.ts` associates agenda
link-item titles with municipal-code sections through the real BM25 index
(`crossReferenceAgendaTopics`). All three surfaces render in the monthly
report's meeting subsections and are covered by
`tests/minutes-depth.test.ts`, `tests/gov-vote-extraction.test.ts`,
`tests/minutes-rollcall.test.ts`, and `tests/agenda-crossref.test.ts`.

Two parsing rules matter for reading the output:

- **Multi-line roll calls are read as one vote.** Minutes render a roll call as
  one `Name - Yea` per line. The block splitter therefore splits on paragraph
  breaks, numbered/lettered item starts, and ALL-CAPS *headings* — not before
  any capitalised line, which shredded every roll call into unusable one-name
  fragments and made the parse depend on indentation.
- **Repeated identical tallies are separate votes.** Collapsing applies only when
  the preceding block is a roll-call line (the one real case where a tally
  legitimately appears twice) or is byte-identical. Adjacency alone is not
  evidence: a consent calendar's items sit in adjacent blocks and routinely pass
  unanimously, each its own vote.

---

## YouTube meeting transcripts

`src/youtube_monitor.ts` lists the official city channel with `yt-dlp`, pulls
English auto-captions for unseen videos, parses rolling VTT captions into
timestamped segments, and indexes successful transcripts in ChromaDB with
`sourceType: "youtube_transcript"`. Listing, timeout, extraction, and indexing
failures remain distinguishable and are written to
`output/youtube/source-health.json` as `unavailable` or `stale`; an empty
successful channel listing is `empty`. Extraction failures remain retryable.

```bash
bun run youtube
```

## Triplicate reference connector

`src/triplicate_monitor.ts` uses the existing Playwright Cloudflare-bypass
browser to collect article metadata from the Del Norte Triplicate. Every item
is stamped `usagePolicy: reference-citation-only; NEVER AI-training input`.
Triplicate is intentionally excluded from LLM curation, embedding indexing, and
training inputs; it is exposed only as reference metadata/citations. Render
failures and selector drift are represented in
`output/triplicate/source-health.json` as `unavailable` or `stale`.

```bash
bun run src/triplicate_monitor.ts
```

## Alert monitors

The real-time hazard family has its own deep-dive in
[alerts.md](alerts.md). `MONITOR_KEYS` defines the roster, and the source-health
denominator includes every monitor in the batch. `scripts/run-alerts.ts`
runs all 20 concurrently and feeds the composite severity. Upstream failures
are reported as typed `unavailable` coverage records. Each batch records its
attempt and per-monitor outcomes; current-cycle CI checks reject child failure,
missing or duplicate roster entries, invalid counts/statuses, and old timestamps.
A source outage remains a coverage fact rather than a successful empty result.
The roster contains:
**8 core** (tsunami, earthquake, weather, tides, fishing, air quality,
wildfire, marine), **7 base extended** (drought, PSPS, smoke, roads, school
closures, marine forecast, USCG broadcasts), and **5 expansion** (permits,
dredging, fuel, PacFIN reports, AIS vessel traffic).

| Module | Source | What it monitors | Artifacts |
| :--- | :--- | :--- | :--- |
| `uscg_broadcasts.ts` | USCG NAVCEN District 11 Broadcast Notice to Mariners listing (no API key) | New/updated BNMs relevant to the North Coast | `output/alerts/uscg/` |

The USCG monitor reads the public District 11 BNM
listing, filters items for North Coast relevance (no API key required),
deduplicates by content hash into `output/alerts/uscg/`, and feeds the 15th
positional input of `computeAlertSeverity` (its findings enter the composite
as ADVISORY, escalating to WATCH). It is wired into the healer roster,
`EXPECTED_SOURCE_HEALTH`, `ALERT_TYPES`, and the GUI trend roster like every
other monitor. Real fixtures live in `tests/fixtures/uscg/`
(`tests/uscg-broadcasts.test.ts`).

## Curation and reporting

`bun run curate` reads only news, government-meeting, and successful YouTube
transcript batches. It records provider/model, source excerpts, citations,
summary status, prompt version, input fingerprints, and retryable provider
failures with atomic writes. The summarizer uses a task-specific
source-grounded system prompt rather than the municipal-code chat prompt,
limits the source excerpt and output length, and aborts hung requests after
`CURATION_SUMMARY_TIMEOUT_MS`. The input fingerprint includes the source ID,
title, text, provider, model, and prompt version, so model/prompt changes are
eligible for re-curation. Duplicate historical records are collapsed
deterministically before LLM work, and changed source content is eligible for
re-curation. `source_only` and `unavailable` results remain retryable and do
not mark the idempotency store complete; the daily output is upserted by
source ID so retries cannot append duplicate visible records. Batch telemetry
is written to `output/state/curation-report.json`.

`bun run report [YYYY-MM]` uses UTC period bounds rather than string-prefix
matching, validates timestamps, and emits both
`output/reports/monthly-YYYY-MM.md` and
`output/reports/monthly-YYYY-MM.json`. The JSON companion contains period
boundaries, numeric metrics, warnings, artifact paths, and a typed aggregate
source-health summary. Malformed records are excluded and reported as
warnings; they never become fabricated activity. The report's meeting
subsection (rendered by `renderMeetingVotesSection` from pure builders
`buildMeetingVoteRows` / `collectDocumentDrift`) surfaces recorded vote
tallies, agenda/minutes SHA-256 drift, and agenda-topic → code-section
cross-references, with explicit empty states when a month has none.

`bun run weekly-check` writes `output/state/latest-pipeline-run.json` with a
stable run ID, runtime/commit metadata, every stage's status/duration/error,
output paths, and aggregate source health. Source health is a coverage
measurement: `ok` and `empty` are present checks, while `unavailable` and
`stale` are missing checks. The summary exposes `present`, `missing`,
`coveragePercent`, `coverageStatus`, and named source lists. A source gap alone
does not produce a nonzero exit. Stage classifiers can report `degraded` for
conditions such as an entirely unavailable alert batch or an honestly empty
calendar; the aggregate run preserves those stage verdicts. Exit code `1`
signals an explicit review condition such as a detected code change; exit
code `2` means a pipeline stage failed.

### Tests

```bash
bun test tests/monitor.test.ts
bun test tests/news_monitor.test.ts
bun test tests/gov_meeting_monitor.test.ts
```

## `src/insights.ts` — Cross-Artifact Civic Insights

Deterministic trend detection over artifacts already recorded under `output/` (alert histories, news, meetings, YouTube uploads, events calendar). The optional LLM pass receives deterministic computed findings and falls back to a template narrative on failure; generated prose remains semantically unverified, and each insight retains evidence source URLs. Served by `GET /api/insights`; CLI `bun run insights`.

## Run ownership, clocks and publication

Municipal/news/government/YouTube/Triplicate entry points capture their output
root and cooperative parent signal before I/O and hold producer-specific leases.
News, government and Triplicate publish batch, current health and seen records
through one recoverable exact-byte replacement. Government meeting batches keep
the canonical `gov_meetings-` prefix used by Pages, document acquisition and the
private digest; custom Triplicate health files have distinct history paths.
Bounded malformed/oversized/linked document hash baselines remain retained and
cannot become empty first-observation history. JSONL history follows the
committed source publication rather than claiming a transaction over all history.

New health envelopes declare `crescent-city-source-health/v1`. Retrieval clocks
remain separate from source observation/product clocks and validity. Primary
clock policies are applied at consumption, so fresh acquisition cannot revive
expired observations or conceal parser/coverage failures. Reachability probes
are a separate evidence plane.

Weekly execution inherits one deadline (default one hour, maximum 24 hours),
retains per-step/running/interrupted archives and closes owned browser groups
before releasing its lease. Completed summary/run/attempt bytes publish together;
restart preserves the prior completion while recovering an interrupted attempt.
Curation publishes report/attempt evidence even for a genuine empty batch and
keeps failed/source-only generation retryable.

`collectActivityEvidence` exposes missing/malformed input, duplicate snapshot,
revision and undated-record diagnostics. `trend_sampling.ts` defines current/
previous windows and expected sampling slots. Missing checks, changed source
sets or inadequate history make trends explicitly noncomparable; activity and
collection frequency cannot establish civic or hazard incidence. Events,
analytics and monthly reports retain exact captured input/transform/output
custody separately from their interpretation.

# Monitoring Module

Continuous change detection and civic intelligence gathering for Crescent City.

## `src/monitor.ts` — Municipal Code Change Detection

Compares saved scraped data against manifest hashes and TOC section counts to detect upstream changes on ecode360.com.

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
| Times-Standard | `https://www.times-standard.com/news/rss.xml` |
| Lost Coast Outpost | `https://lostcoastoutpost.com/feed` |
| Humboldt Times | `https://www.humboldtcountynews.com/feed` |
| KIEM-TV NBC Eureka | `https://www.kiemtv.com/feed/` |
| Redwood Voice | `https://www.redwoodvoice.org/feed/` |

### Keywords

Content is included if it matches any of: `crescent city`, `del norte`, `tsunami`, `harbor`, `fishing`, `crabbing`, `pelican bay`, `emergency`, `evacuation`, and more.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorNews` | `(filterKeywords?: string[], options?) → Promise<NewsItem[]>` | Fetch all feeds, deduplicate, filter, save, and write per-source health |
| `fetchRSSFeedDetailed` | `(url, source) → Promise<NewsFeedResult>` | RSS/Atom items plus `ok`/`empty`/`unavailable` health |
| `fetchRSSFeed` | `(source, url) → Promise<NewsItem[]>` | Parse one RSS feed |
| `NewsItem` | `interface` | `{id, title, link, pubDate, source, description, fetchedAt}` |

### Output

Saves JSON to `output/news/news-<timestamp>.json`.
Source diagnostics are written to `output/news/source-health.json`; HTTP,
timeout, parser, and DNS failures are never represented as an ordinary empty
feed. `--keywords=a,b` replaces the default relevance list and
`--no-dedup` is available for controlled replays.

```bash
bun run news     # via scripts/run-news.ts
```

**Fixed 2026-07-23**: `scripts/run-news.ts` previously called `monitorNews`
with an object instead of the `string[] | undefined` array `monitorNews`
actually expects, which broke the news monitor completely in normal use (no
`--keywords` flag). It now passes the parsed keyword array correctly.

---

## `src/gov_meeting_monitor.ts` — Government Meeting Tracker

Pulls upcoming and recent-past agendas/minutes for City Council, Planning
Commission, and (when a source exists — see below) Harbor Commission.

### Sources (fixed 2026-07-24)

The old `crescentcity.org/government/{city-council,planning-commission,
harbor-commission}/agendas` URLs 404 — the city migrated `crescentcity.org`
to the EvoGov CMS at some point after this module was originally written.
EvoGov's `/meetings` calendar is rendered client-side (the initial HTML
contains no meeting data at all), but the widget itself calls a same-origin
JSON endpoint to populate it. That endpoint — found by capturing real network
traffic with Playwright against `https://www.crescentcity.org/meetings` — is
what `fetchGovMeetings()` now calls directly:

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
and are distinguished only by matching `title` against the source name, not
by a separate URL or calendar id — confirmed against a full year of real
response data.

| Body | How it's identified |
| :--- | :--- |
| City Council | `title` contains "City Council" (e.g. "City Council Meeting", "Special City Council Meeting") |
| Planning Commission | `title` contains "Planning Commission" |
| Harbor Commission | not present on this endpoint at all — see below |

> **Harbor Commission has no known digital agenda source right now**
> (confirmed 2026-07-24). It doesn't appear anywhere in a full year of the
> EvoGov feed's `title` values, and its own domain
> (`crescentcityharbor.com` / `www.crescentcityharbor.com`, linked from this
> project's own README) no longer resolves in DNS at all. `GOV_SOURCES`
> keeps a "Harbor Commission" entry pointed at the same EvoGov endpoint so
> the monitor honestly reports 0 matches every run rather than 404ing —
> finding a real source (a successor domain, a county/harbor-district
> portal) needs manual research, not more scraping code.

### Change Detection

Uses SHA-256 hashing of each meeting item to detect new or changed content. In-process LRU cache (500 entries) prevents reprocessing.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorGovMeetings` | `() → Promise<MeetingItem[]>` | Full monitor run (fetch + filter + save) |
| `fetchGovMeetings` | `(name, url) → Promise<MeetingItem[]>` | Scrape one meeting source |
| `saveMeetingItems` | `(items) → Promise<void>` | Persist to `output/gov_meetings/` |
| `MeetingItem` | `interface` | `{id, title, body, source, url, fetchedAt, hash}` |

### Output

Saves to `output/gov_meetings/meetings-<timestamp>.json`.

```bash
bun run gov-meetings   # via scripts/run-meetings.ts
```

**Fixed 2026-07-24**: `monitorGovMeetings()` returns its collected items and
persists per-source health. The live EvoGov endpoint currently returns City
Council and Planning Commission records; Harbor Commission is retained as an
explicit `empty` source until a real agenda feed is found.

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

## Curation and reporting

`bun run curate` reads only news, government-meeting, and successful YouTube
transcript batches. It records provider/model, source excerpts, citations,
summary status, and domain tags with atomic writes and retryable provider
failures. `bun run report [YYYY-MM]` uses period-filtered batches and includes
news, meeting, YouTube, Triplicate, and alert source-health summaries. Neither
command re-fetches upstream sources.

### Tests

```bash
bun test tests/monitor.test.ts
bun test tests/news_monitor.test.ts
bun test tests/gov_meeting_monitor.test.ts
```

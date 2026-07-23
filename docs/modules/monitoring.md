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
| Times-Standard | `times-standard.com/news/rss.xml` |
| Lost Coast Outpost | `lostcoastoutpost.com/feed` |
| Humboldt Times | `humboldtcountynews.com/feed` |

### Keywords

Content is included if it matches any of: `crescent city`, `del norte`, `tsunami`, `harbor`, `fishing`, `crabbing`, `pelican bay`, `emergency`, `evacuation`, and more.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorNews` | `(filterKeywords?: string[]) → Promise<NewsItem[]>` | Fetch all feeds, deduplicate, filter, save |
| `fetchRSSFeed` | `(source, url) → Promise<NewsItem[]>` | Parse one RSS feed |
| `NewsItem` | `interface` | `{id, title, link, pubDate, source, description, fetchedAt}` |

### Output

Saves JSON to `output/news/news-<timestamp>.json`.

```bash
bun run news     # via scripts/run-news.ts
```

**Fixed 2026-07-23**: `scripts/run-news.ts` previously called `monitorNews`
with an object instead of the `string[] | undefined` array `monitorNews`
actually expects, which broke the news monitor completely in normal use (no
`--keywords` flag). It now passes the parsed keyword array correctly.

---

## `src/gov_meeting_monitor.ts` — Government Meeting Tracker

Scrapes city government website for upcoming agendas and meeting minutes from City Council, Planning Commission, and Harbor Commission.

### Sources

| Body | URL |
| :--- | :--- |
| City Council | `crescentcity.org/government/city-council/agendas` |
| Planning Commission | `crescentcity.org/government/planning-commission/agendas` |
| Harbor Commission | `crescentcity.org/government/harbor-commission/agendas` |

> **Known limitation (confirmed 2026-07-23)**: all three source URLs above
> currently 404. The City of Crescent City migrated `crescentcity.org` to a
> new CMS (evogov.com-based) at some point after this scraper module was
> written, and the old `/government/*/agendas` URL scheme no longer exists.
> A live check of `www.crescentcity.org` did not turn up an obvious
> replacement agenda-portal URL — the one `evogov.com` subdomain link found
> on the site, `crescentcityca.evogov.com`, does not resolve in DNS and
> appears to be a dead link on the city's own site too. This is not
> code-fixable without discovering the city's new agenda-portal URL; until
> then `monitorGovMeetings()` runs cleanly but returns `[]` (see fix below —
> it used to crash the caller instead).

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

**Fixed 2026-07-23**: `monitorGovMeetings()` previously declared
`Promise<void>` and never returned its collected items, while
`scripts/run-meetings.ts` expected an array back — this crashed every run. It
now correctly returns `Promise<MeetingItem[]>` (gracefully `[]` given the
source-URL 404s noted above, instead of crashing).

### Tests

```bash
bun test tests/monitor.test.ts              # 3 tests
bun test tests/news_monitor.test.ts         # 3 tests
bun test tests/gov_meeting_monitor.test.ts  # 3 tests
```

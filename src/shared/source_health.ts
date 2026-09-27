import { mkdir, rename, open, appendFile, readFile } from "fs/promises";
import { dirname } from "path";
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "fs";
import type { SourceHealth, SourceHealthStatus, SourceHealthSummary } from "../types.js";

/**
 * Default cap for the on-disk JSONL history files (alert history.jsonl, etc).
 * Without a cap these files grew without bound and were fully re-read every
 * run (R7). Runs are bounded, but a long-lived deployment still accumulates one
 * line per run/event; this tail-trim keeps the file bounded while preserving
 * the most-recent records that analytics actually reads.
 */
export const JSONL_HISTORY_MAX_LINES = 10_000;

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const SOURCE_FETCH_TIMEOUT_MS = positiveEnvNumber("SOURCE_FETCH_TIMEOUT_MS", 10000);
export const DEFAULT_FRESHNESS_WINDOW_MS = positiveEnvNumber("SOURCE_FRESHNESS_WINDOW_MS", 24 * 60 * 60 * 1000);

/**
 * The operational source-health contract is larger than the set of files that
 * happen to exist after a run.  Keeping the expected names here lets every
 * consumer distinguish "the monitor emitted an empty result" from "the
 * monitor emitted no result at all".  The latter is represented as a named
 * unavailable coverage record rather than silently shrinking the denominator.
 */
export const EXPECTED_SOURCE_HEALTH: ReadonlyArray<{ source: string; url: string; monitor: string }> = [
  { source: "Lost Coast Outpost", url: "https://lostcoastoutpost.com/feed", monitor: "news" },
  { source: "Humboldt County official news", url: "https://humboldtgov.org/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml", monitor: "news" },
  { source: "KIEM-TV NBC Eureka", url: "https://www.redwoodnews.tv/search/?f=rss&t=article&c=news&l=50&s=start_time&sd=desc", monitor: "news" },
  { source: "Redwood Voice", url: "https://www.redwoodvoice.org/feed", monitor: "news" },
  { source: "North Coast Journal", url: "https://www.northcoastjournal.com/feed", monitor: "news" },
  { source: "City Council", url: "https://www.crescentcity.org/meetings/get_list", monitor: "meetings" },
  { source: "Planning Commission", url: "https://www.crescentcity.org/meetings/get_list", monitor: "meetings" },
  { source: "Harbor Commission", url: "https://www.crescentcity.org/meetings/get_list", monitor: "meetings" },
  { source: "YouTube", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCc8LIkDxscuciAFNB9yEEMA", monitor: "youtube" },
  { source: "Del Norte Triplicate", url: "https://www.triplicate.com/rss.xml", monitor: "news:Del Norte Triplicate" },
  { source: "Del Norte Triplicate deep content", url: "https://www.triplicate.com/news/", monitor: "triplicate" },
  { source: "NOAA Tsunami", url: "https://api.weather.gov/alerts/active?area=CA", monitor: "alerts" },
  { source: "USGS Earthquake", url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson", monitor: "alerts" },
  { source: "NWS Weather", url: "https://api.weather.gov/alerts/active?zone=CAZ006", monitor: "alerts" },
  { source: "NOAA Tides", url: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9419750", monitor: "alerts" },
  { source: "CDFW Fishing", url: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins", monitor: "alerts" },
  { source: "EPA AirNow", url: "https://files.airnowtech.org/airnow/today/airnowlatest_pm25aqi.kml", monitor: "alerts" },
  { source: "CAL FIRE Wildfire", url: "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false", monitor: "alerts" },
  { source: "NDBC Marine", url: "https://www.ndbc.noaa.gov/data/realtime2", monitor: "alerts" },
  // The extended monitors. The alert runner emits a SourceHealth record for
  // every monitor, but this coverage contract listed only the eight core ones,
  // so the denominator was 8: `completeSourceHealth` could never synthesize an
  // "expected monitor output was absent" marker for the rest, and a skipped or
  // crashed alert run shrank coverage invisibly instead of showing gaps. Both
  // gates only assert a superset, so the omission could not fail CI.
  //
  // Each `url` names the endpoint the monitor ACTUALLY calls, not a legacy
  // constant it no longer uses: PG&E's exported JSON now 404s (the monitor reads
  // the event page), AirFire's 404s (NOAA HMS is primary), and QuickMap's serves
  // an SPA shell (per-route roads text is primary). Source names must match
  // ALERT_MONITOR_SOURCE_NAMES in alerts/composite.ts.
  { source: "USDM Drought", url: "https://usdmapi.cpc.ncep.noaa.gov/api/StateDroughtMonitor/GetDroughtSeverity/Drought/06015", monitor: "alerts" },
  { source: "PG&E PSPS", url: "https://pgealerts.alerts.pge.com/pg-e-partners/psps-events/", monitor: "alerts" },
  { source: "HRRR Smoke", url: "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/Shapefile/", monitor: "alerts" },
  { source: "Caltrans Roads", url: "https://roads.dot.ca.gov/?roadnumber=", monitor: "alerts" },
  { source: "DUSD Schools", url: "https://www.dnusd.org/news", monitor: "alerts" },
  { source: "NWS Marine Forecast", url: "https://api.weather.gov/products/types/CWF/locations/EKA", monitor: "alerts" },
  { source: "USCG Broadcast Notice to Mariners", url: "https://www.navcen.uscg.gov/broadcast-notice-to-mariners-search-results?district=11&sector=0", monitor: "alerts" },
];

export function sourceHealth(
  source: string,
  status: SourceHealthStatus,
  checkedAt: string,
  details: Omit<Partial<SourceHealth>, "source" | "status" | "checkedAt"> = {},
): SourceHealth {
  const health: SourceHealth = {
    source,
    status,
    checkedAt,
    itemCount: details.itemCount ?? 0,
    ...details,
  };
  if (health.fetchedAt) {
    const ageMs = Date.parse(health.fetchedAt);
    if (Number.isFinite(ageMs)) {
      health.ageMs = Math.max(0, Date.now() - ageMs);
      health.freshness = health.ageMs <= (health.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS) ? "fresh" : "stale";
    } else {
      health.freshness = "unknown";
    }
  } else {
    health.freshness = "unknown";
  }
  return health;
}

/**
 * Aggregate source states without turning ordinary coverage gaps into a
 * pipeline failure. `degraded` remains as a compatibility alias for older
 * consumers; new surfaces should use `present`, `missing`, and coveragePercent.
 */
export function summarizeSourceHealth(
  sources: SourceHealth[],
  checkedAt = new Date().toISOString(),
): SourceHealthSummary {
  const counts = { ok: 0, empty: 0, unavailable: 0, stale: 0 };
  for (const source of sources) {
    if (source.status in counts) counts[source.status] += 1;
  }
  const presentSources = sources
    .filter(source => source.status === "ok" || source.status === "empty")
    .map(source => source.source)
    .sort();
  const missingSources = sources
    .filter(source => source.status === "unavailable" || source.status === "stale")
    .map(source => source.source)
    .sort();
  const present = presentSources.length;
  const missing = missingSources.length;
  return {
    checkedAt,
    total: sources.length,
    ...counts,
    present,
    missing,
    coveragePercent: sources.length === 0 ? 0 : Math.round((present / sources.length) * 1000) / 10,
    coverageStatus: sources.length === 0 ? "none" : missing === 0 ? "complete" : present === 0 ? "none" : "partial",
    presentSources,
    missingSources,
    degraded: missing,
    sources: sources.map(source => source.source).sort(),
  };
}

/**
 * Fill absent adapter records with explicit unavailable markers.  Existing
 * records are never overwritten, so a successful empty check stays present
 * and a real adapter error retains its original diagnostics.
 */
export function completeSourceHealth(
  sources: SourceHealth[],
  checkedAt = new Date().toISOString(),
): SourceHealth[] {
  const observed = new Set(sources.map(source => source.source));
  const missing = EXPECTED_SOURCE_HEALTH
    .filter(expected => !observed.has(expected.source))
    .map(expected => sourceHealth(expected.source, "unavailable", checkedAt, {
      itemCount: 0,
      url: expected.url,
      error: `No ${expected.monitor} source-health record was emitted for this run`,
      provenance: "Synthetic coverage marker: expected monitor output was absent; availability and calmness are unknown.",
    }));
  return [...sources, ...missing].sort((a, b) => a.source.localeCompare(b.source));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Flip a fully-written temp file into place after fsync, so a crash between
 * write and rename cannot leave a partially-written artifact under the real
 * path (which downstream `JSON.parse` would treat as corrupt and, for
 * idempotency stores, silently start over from empty). */
async function writeFileSynced(path: string, data: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write a JSON artifact atomically so concurrent runs cannot truncate it. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFileSynced(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFileSynced(temporary, value);
  await rename(temporary, path);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedTail(lines: string[], maxLines: number): string {
  const trimmed = lines.filter(Boolean);
  return trimmed.slice(-maxLines).join("\n") + "\n";
}

function toJsonLine(record: string | unknown): string {
  return (typeof record === "string" ? record : JSON.stringify(record)) + "\n";
}

/**
 * Amortised trim thresholds.
 *
 * Trimming to exactly `maxLines` leaves the very next append over the cap
 * again, so a full-file rewrite (read + temp + fsync + rename) happened on
 * *every* append once the cap was reached. That is not the low-frequency case
 * the original comment assumed: `hrrr_smoke` appends one line per forecast
 * hour (up to 48 in a run) and `caltrans_roads` one per incident, so a single
 * run could trigger dozens of full-file rewrites.
 *
 * Trim when the file reaches `maxLines`, and trim down to `maxLines *
 * RETAIN_RATIO` — so the next ~10% of appends are free. Retention is
 * deliberately *less* than the cap, never more: a reader must never be able to
 * see a file that violates the documented bound.
 */
const RETAIN_RATIO = 0.9;

/** Below this cap, trimming to a ratio would save nothing measurable, so the
 * trim target is the cap itself and the "at most maxLines" contract reads back
 * exactly. It also keeps the amortisation from degenerating on tiny caps used
 * by tests (`floor(2 * 0.9)` is 1 — a 50% drop, not a 10% one). */
const AMORTISE_MIN_LINES = 100;

/** The number of lines a trim keeps: the cap itself for small caps, else the
 * cap scaled by RETAIN_RATIO. Never exceeds `maxLines`. */
function trimTarget(maxLines: number): number {
  return maxLines < AMORTISE_MIN_LINES ? maxLines : Math.floor(maxLines * RETAIN_RATIO);
}

/** Async bounded JSONL appender: appends one record and, when the file
 * reaches `maxLines`, atomically trims it to the most-recent tail. */
export async function appendBoundedJsonl(
  path: string,
  record: string | unknown,
  maxLines = JSONL_HISTORY_MAX_LINES,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, toJsonLine(record));
  try {
    const lines = (await readFile(path, "utf-8")).split("\n");
    if (lines.filter(Boolean).length >= maxLines) {
      await writeTextAtomic(path, boundedTail(lines, trimTarget(maxLines)));
    }
  } catch {
    // A failed trim must never break an alert run; the file just stays unbounded.
  }
}

/** Synchronous bounded JSONL appender for monitors that persist with fs sync
 * APIs. Same cap/tail semantics as appendBoundedJsonl. */
export function appendBoundedJsonlSync(
  path: string,
  record: string | unknown,
  maxLines = JSONL_HISTORY_MAX_LINES,
): void {
  appendFileSync(path, toJsonLine(record));
  try {
    const lines = readFileSync(path, "utf-8").split("\n");
    if (lines.filter(Boolean).length >= maxLines) {
      // Synchronous crash-safe trim: temp file + rename, so a partial write
      // cannot corrupt the live history under the real path. Same amortised
      // down-trim as the async appender — see RETAIN_RATIO.
      const tmp = `${path}.${process.pid}.${Date.now()}.trim`;
      writeFileSync(tmp, boundedTail(lines, trimTarget(maxLines)));
      renameSync(tmp, path);
    }
  } catch {
    // non-fatal
  }
}

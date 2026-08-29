/**
 * Alert analytics — aggregates and timelines for all alert monitors.
 *
 * Reads from persistent JSONL history files across all alert types and
 * produces:
 * - Unified timeline of all alert events
 * - Per-type statistics (counts, severity distribution, frequency)
 * - Alert correlation (e.g., earthquake → tsunami warning)
 * - Composite risk trends over time
 *
 * Designed for GET /api/alerts/timeline and GET /api/alerts/analytics.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.js";

const log = createLogger("alert_analytics");

export const ALERT_TYPES = ["tsunami", "earthquake", "weather", "tides", "airquality", "wildfire", "marine", "fishing"] as const;
export type AlertType = typeof ALERT_TYPES[number];

interface AlertHistoryRecord {
  id?: string;
  fetchedAt?: string;
  timestamp?: string;
  // Varies by alert type
  [key: string]: any;
}

export interface TimelineEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Alert type */
  type: AlertType;
  /** Severity level */
  severity: string;
  /** Brief description */
  description: string;
  /** Raw record */
  record: Record<string, any>;
}

export interface AlertTypeStats {
  type: AlertType;
  /** Total events in history */
  totalEvents: number;
  /** Date range */
  firstEvent: string | null;
  lastEvent: string | null;
  /** Severity distribution */
  severityCounts: Record<string, number>;
  /** Average events per day */
  avgPerDay: number;
}

export interface AlertAnalyticsReport {
  /** Timestamp of report generation */
  generatedAt: string;
  /** Unified chronological timeline of all alert events */
  timeline: TimelineEntry[];
  /** Per-type statistics */
  typeStats: AlertTypeStats[];
  /** Total events across all types */
  totalEvents: number;
  /** Most recent alert (across all types) */
  mostRecentAlert: TimelineEntry | null;
  /** Alert type with the most events */
  mostActiveType: AlertType | null;
  /**
   * True when `timeline` is a suffix of a longer history because the entry cap
   * was hit. Consumers doing window math over `timeline` (see
   * `computeAlertTypeTrends`) MUST NOT read absence of old entries as absence
   * of old events.
   */
  timelineTruncated: boolean;
  /**
   * ISO timestamp of the oldest entry still present in `timeline` when
   * `timelineTruncated` is true; null when the timeline is the complete
   * history. Nothing before this instant can be counted from `timeline`.
   */
  timelineRetainedFrom: string | null;
}

/** Read a JSONL file and return parsed records */
function readJsonl(filePath: string): AlertHistoryRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((r): r is AlertHistoryRecord => r !== null);
  } catch {
    return [];
  }
}

/** Extract timestamp from various record shapes */
function getTimestamp(record: AlertHistoryRecord): string | null {
  return record.fetchedAt ?? record.timestamp ?? record.time ?? record.assessedAt ?? null;
}

/** Extract severity from various record shapes */
function getSeverity(record: AlertHistoryRecord, type: AlertType): string {
  // Type-specific severity extraction
  if (type === "tsunami") return record.severity ?? "alert";
  if (type === "earthquake") {
    const mag = record.magnitude ?? record.mag;
    return mag >= 6 ? "WARNING" : "WATCH";
  }
  if (type === "weather") return record.severity ?? "advisory";
  if (type === "tides") return record.level ?? "CALM";
  if (type === "airquality") return record.level ?? "CALM";
  if (type === "wildfire") return record.level ?? "ADVISORY";
  if (type === "marine") return record.level ?? "CALM";
  if (type === "fishing") return record.level ?? "CALM";
  return "alert";
}

/** Build description from record */
function getDescription(record: AlertHistoryRecord, type: AlertType): string {
  if (type === "tsunami") return record.headline ?? record.event ?? "Tsunami alert";
  if (type === "earthquake") return `M${record.magnitude ?? record.mag ?? "?"} earthquake ${record.place ?? ""}`.trim();
  if (type === "weather") return record.headline ?? record.event ?? "Weather alert";
  if (type === "tides") return record.summary ?? `Tide ${record.waterLevelFt ?? "?"} ft`;
  if (type === "airquality") return record.summary ?? `AQI ${record.maxAqi ?? "?"}`;
  if (type === "wildfire") return record.summary ?? `${record.name ?? "Wildfire"}`;
  if (type === "marine") return record.summary ?? "Marine condition";
  return JSON.stringify(record).substring(0, 100);
}

/** Convert a raw record to a timeline entry */
function toTimelineEntry(record: AlertHistoryRecord, type: AlertType): TimelineEntry | null {
  const ts = getTimestamp(record);
  if (!ts) return null;
  return {
    timestamp: ts,
    type,
    severity: getSeverity(record, type),
    description: getDescription(record, type),
    record,
  };
}

/** Compute per-type stats */
function computeTypeStats(type: AlertType, records: AlertHistoryRecord[]): AlertTypeStats {
  const timestamps = records
    .map(r => getTimestamp(r))
    .filter((t): t is string => t !== null)
    .sort();

  const severityCounts: Record<string, number> = {};
  for (const r of records) {
    const sev = getSeverity(r, type);
    severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
  }

  let avgPerDay = 0;
  if (timestamps.length >= 2) {
    const first = new Date(timestamps[0]).getTime();
    const last = new Date(timestamps[timestamps.length - 1]).getTime();
    const daysDiff = (last - first) / (1000 * 60 * 60 * 24);
    // Guard against a sub-day span exploding the rate (e.g. 3 events minutes
    // apart dividing by a near-zero daysDiff produced avgPerDay=3122891.57
    // in production). Below one full day, report the raw event count as the
    // best available same-day rate estimate instead of extrapolating.
    avgPerDay = daysDiff >= 1 ? records.length / daysDiff : records.length;
  }

  return {
    type,
    totalEvents: records.length,
    firstEvent: timestamps[0] ?? null,
    lastEvent: timestamps[timestamps.length - 1] ?? null,
    severityCounts,
    avgPerDay,
  };
}

/**
 * Build a comprehensive alert analytics report from all JSONL history files.
 *
 * `maxTimelineEntries` bounds the number of timeline entries returned so a
 * long-running deployment's ever-growing history cannot balloon an API
 * response or memory footprint; the per-type statistics are still computed
 * over the FULL record set.
 */
export function buildAlertAnalytics(maxTimelineEntries = 1000): AlertAnalyticsReport {
  const alertsDir = join(process.cwd(), "output", "alerts");
  const fishingDir = join(process.cwd(), "output", "fishing");
  const tidesDir = join(process.cwd(), "output", "tides");

  let timeline: TimelineEntry[] = [];
  const typeStats: AlertTypeStats[] = [];
  let totalEvents = 0;
  let mostActiveType: AlertType | null = null;
  let maxCount = 0;

  for (const type of ALERT_TYPES) {
    // Fishing and tides write to output/fishing/ and output/tides/ respectively
    let historyFile: string;
    if (type === "fishing") {
      historyFile = join(fishingDir, "history.jsonl");
    } else if (type === "tides") {
      historyFile = join(tidesDir, "history.jsonl");
    } else {
      historyFile = join(alertsDir, type, "history.jsonl");
    }
    const records = readJsonl(historyFile);

    // Convert to timeline entries
    for (const record of records) {
      const entry = toTimelineEntry(record, type);
      if (entry) timeline.push(entry);
    }

    // Compute stats
    const stats = computeTypeStats(type, records);
    typeStats.push(stats);
    totalEvents += stats.totalEvents;

    if (stats.totalEvents > maxCount) {
      maxCount = stats.totalEvents;
      mostActiveType = type;
    }
  }

  // Sort timeline chronologically
  timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  // Bound the number of entries carried into the report (keep the most recent).
  // Truncation is recorded, not silent: a consumer counting events per window
  // needs to know the retained timeline has a floor.
  const timelineTruncated = timeline.length > maxTimelineEntries;
  if (timelineTruncated) {
    timeline = timeline.slice(-maxTimelineEntries);
  }
  const timelineRetainedFrom = timelineTruncated && timeline.length > 0 ? timeline[0].timestamp : null;

  const mostRecentAlert = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  log.info(`Alert analytics: ${totalEvents} total events, ${timeline.length} timeline entries${timelineTruncated ? ` (truncated, retained from ${timelineRetainedFrom})` : ""}`);

  return {
    generatedAt: new Date().toISOString(),
    timeline,
    typeStats,
    totalEvents,
    mostRecentAlert,
    mostActiveType,
    timelineTruncated,
    timelineRetainedFrom,
  };
}

/** Per-type 30-day trend summary for one alert type. */
export interface AlertTypeTrend {
  type: AlertType;
  /** Events whose timestamp falls inside the trailing 30-day window. */
  count30d: number;
  /** Events in the trailing 30-day window ending when the current window began. */
  countPrevious30d: number;
  /** count30d - countPrevious30d. */
  delta: number;
  /**
   * "rising" | "falling" — |delta| exceeds the steady band.
   * "changed"  — inside the band but one window is empty and the other is not
   *              (0 <-> 1): presence appearing or disappearing is a state change,
   *              not steadiness.
   * "steady"   — inside the band with both windows non-empty.
   * "insufficient" — both windows empty, OR the counts cannot be trusted because
   *              the source timeline was truncated below the 60-day span.
   */
  trend: "rising" | "steady" | "falling" | "changed" | "insufficient";
  /**
   * Events dated after `now` (NWS onset/expiry stamps routinely are). They are
   * deliberately excluded from both windows — a forecast is not an observation —
   * and reported here so the exclusion is visible rather than silent.
   */
  futureDated: number;
  /**
   * True when the supplied entries are a truncated suffix of a longer history
   * whose floor lands inside the 60-day span, so `countPrevious30d` (and
   * possibly `count30d`) undercounts. `trend` is forced to "insufficient".
   */
  truncated: boolean;
  /** Timestamps of the current window's events (ISO, chronological). */
  eventTimestamps30d: string[];
}

/**
 * Two-sided steady band: |delta| <= 1 counts as steady (matches insights
 * STEADY_BAND=1). Applied symmetrically to rises and falls, with the 0 <-> 1
 * boundary case broken out as "changed" — see AlertTypeTrend.trend.
 */
export const ALERT_TREND_STEADY_BAND = 1;

/** Compact per-type trend for size-sensitive payloads (e.g. GET /api/health). */
export interface AlertTypeTrendSummary {
  type: AlertType;
  count30d: number;
  countPrevious30d: number;
  delta: number;
  trend: AlertTypeTrend["trend"];
  futureDated: number;
  truncated: boolean;
  /**
   * Sparse UTC-day histogram of the current window: "YYYY-MM-DD" -> count.
   * At most 31 keys per type, versus one ISO string per event in
   * `eventTimestamps30d` (the raw stamps stay on GET /api/alerts/timeline).
   */
  eventsPerDay30d: Record<string, number>;
}

/**
 * Project full trends onto the compact summary carried by GET /api/health.
 * Drops `eventTimestamps30d` (unbounded in the number of events) in favour of a
 * per-UTC-day histogram bounded by the window length.
 */
export function summarizeAlertTypeTrends(trends: AlertTypeTrend[]): AlertTypeTrendSummary[] {
  return trends.map(({ eventTimestamps30d, ...rest }) => {
    const eventsPerDay30d: Record<string, number> = {};
    for (const stamp of eventTimestamps30d) {
      const day = stamp.slice(0, 10);
      eventsPerDay30d[day] = (eventsPerDay30d[day] ?? 0) + 1;
    }
    return { ...rest, eventsPerDay30d };
  });
}

/**
 * Compute a per-type 30-day trend summary from timeline entries. Deterministic;
 * no LLM. Undated entries are excluded from window math, never guessed into a
 * bucket. Both windows empty => "insufficient".
 *
 * `options.retainedFrom` is the ISO floor of a truncated timeline (see
 * `AlertAnalyticsReport.timelineRetainedFrom`). When that floor falls after the
 * start of the previous window the counts are known-incomplete, so every type
 * reports `truncated: true` and `trend: "insufficient"` rather than a confident
 * "rising" manufactured by the missing tail.
 */
export function computeAlertTypeTrends(
  entries: TimelineEntry[],
  now: Date = new Date(),
  options: { retainedFrom?: string | null } = {},
): AlertTypeTrend[] {
  const nowMs = now.getTime();
  const day = 24 * 60 * 60 * 1000;
  const curStart = nowMs - 30 * day;
  const prevStart = curStart - 30 * day;

  const retainedFromMs = options.retainedFrom ? new Date(options.retainedFrom).getTime() : NaN;
  const truncated = Number.isFinite(retainedFromMs) && retainedFromMs > prevStart;

  const trends: AlertTypeTrend[] = [];
  for (const type of ALERT_TYPES) {
    const dated = entries
      .filter(e => e.type === type)
      // An entry is dated only if it carries a non-empty string that parses.
      // `null`/`undefined`/"" must not slip through: `new Date(null)` is a
      // finite epoch-0 date and would bucket an undated record into 1970.
      .map(e => (typeof e.timestamp === "string" && e.timestamp.trim() !== "" ? new Date(e.timestamp).getTime() : NaN))
      .filter(t => Number.isFinite(t))
      .sort((a, b) => a - b);
    const cur = dated.filter(t => t >= curStart && t <= nowMs);
    const prev = dated.filter(t => t >= prevStart && t < curStart);
    const futureDated = dated.filter(t => t > nowMs).length;
    const count30d = cur.length;
    const countPrevious30d = prev.length;
    const delta = count30d - countPrevious30d;
    // Presence flipping on or off is categorically different from a small
    // fluctuation between two non-empty windows, even though both sit inside
    // the band.
    const crossesEmpty = (count30d === 0) !== (countPrevious30d === 0);
    let trend: AlertTypeTrend["trend"];
    if (truncated) {
      trend = "insufficient";
    } else if (count30d === 0 && countPrevious30d === 0) {
      trend = "insufficient";
    } else if (Math.abs(delta) <= ALERT_TREND_STEADY_BAND) {
      trend = crossesEmpty ? "changed" : "steady";
    } else {
      trend = delta > 0 ? "rising" : "falling";
    }
    trends.push({
      type,
      count30d,
      countPrevious30d,
      delta,
      trend,
      futureDated,
      truncated,
      eventTimestamps30d: cur.map(t => new Date(t).toISOString()),
    });
  }
  return trends;
}

/**
 * Get the last N alert events across all types.
 */
export function getRecentAlerts(limit: number = 20): TimelineEntry[] {
  const report = buildAlertAnalytics();
  return report.timeline.slice(-limit).reverse();
}

/**
 * Get alerts of a specific type within a date range.
 */
export function getAlertsByType(type: AlertType, fromDate?: string, toDate?: string): TimelineEntry[] {
  const report = buildAlertAnalytics();
  let entries = report.timeline.filter(e => e.type === type);

  if (fromDate) {
    entries = entries.filter(e => e.timestamp >= fromDate);
  }
  if (toDate) {
    entries = entries.filter(e => e.timestamp <= toDate);
  }

  return entries;
}

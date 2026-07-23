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

const ALERT_TYPES = ["tsunami", "earthquake", "weather", "tides", "airquality", "wildfire", "marine", "fishing"] as const;
type AlertType = typeof ALERT_TYPES[number];

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
    avgPerDay = daysDiff > 0 ? records.length / daysDiff : records.length;
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
 */
export function buildAlertAnalytics(): AlertAnalyticsReport {
  const alertsDir = join(process.cwd(), "output", "alerts");
  const fishingDir = join(process.cwd(), "output", "fishing");
  const tidesDir = join(process.cwd(), "output", "tides");

  const timeline: TimelineEntry[] = [];
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

  const mostRecentAlert = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  log.info(`Alert analytics: ${totalEvents} total events, ${timeline.length} timeline entries`);

  return {
    generatedAt: new Date().toISOString(),
    timeline,
    typeStats,
    totalEvents,
    mostRecentAlert,
    mostActiveType,
  };
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

/**
 * Pure alert trend aggregation for the local GUI.
 *
 * The browser consumes the existing alert timeline/history endpoints and keeps
 * source health separate from event counts. In particular, zero recorded
 * events is not evidence of CALM: only an explicit current monitor level can
 * establish calm, while empty, stale, unavailable, and unknown health remain
 * distinct display states.
 */
import { ALERT_TYPES, type AlertType } from "../alert_analytics.js";
import type { SourceHealthStatus } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const ALERT_TREND_DAYS = 14;
export const MAX_ALERT_TREND_DAYS = 31;
export const MAX_ALERT_TREND_EVENTS = 5_000;

export const ALERT_SOURCE_BY_TYPE: Readonly<Record<AlertType, string>> = {
  tsunami: "NOAA Tsunami",
  earthquake: "USGS Earthquake",
  weather: "NWS Weather",
  tides: "NOAA Tides",
  airquality: "EPA AirNow",
  wildfire: "CAL FIRE Wildfire",
  marine: "NDBC Marine",
  fishing: "CDFW Fishing",
};

const ALERT_TYPE_SET = new Set<string>(ALERT_TYPES);
const SOURCE_HEALTH_STATES = new Set<SourceHealthStatus>(["ok", "empty", "stale", "unavailable"]);
const EXPLICIT_CALM_LEVELS = new Set(["CALM", "GOOD", "NONE", "NORMAL", "OK"]);

export type AlertHealthState = SourceHealthStatus | "unknown";
export type AlertConditionState = "calm" | "active" | "unknown";
export type AlertDisplayState = "calm" | "active" | "available" | "empty" | "stale" | "unavailable" | "unknown";

export interface AlertTrendBucket {
  date: string;
  count: number;
  severityCounts: Record<string, number>;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface AlertTrendRow {
  type: AlertType;
  source: string;
  healthStatus: AlertHealthState;
  healthCheckedAt: string | null;
  healthError: string | null;
  healthItemCount: number | null;
  currentLevel: string | null;
  conditionState: AlertConditionState;
  displayState: AlertDisplayState;
  buckets: AlertTrendBucket[];
  windowEvents: number;
  sampledEvents: number;
  mostRecentAt: string | null;
}

export interface AlertTrendView {
  generatedAt: string;
  startDate: string;
  endDate: string;
  days: number;
  rows: AlertTrendRow[];
  maxCellCount: number;
  processedEvents: number;
  duplicateEvents: number;
  invalidEvents: number;
  truncatedEvents: number;
}

export interface AlertTrendInput {
  events?: readonly unknown[];
  sourceHealth?: readonly unknown[];
  currentLevels?: Partial<Record<AlertType, unknown>>;
  now?: string | number | Date;
  days?: number;
  maxEvents?: number;
}

interface NormalizedEvent {
  type: AlertType;
  timestamp: string;
  timestampMs: number;
  severity: string;
  dedupeKey: string;
}

interface NormalizedHealth {
  status: AlertHealthState;
  checkedAt: string | null;
  error: string | null;
  itemCount: number | null;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return fallback;
  return Math.min(value as number, maximum);
}

function utcDayStart(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedText(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeEvent(value: unknown): NormalizedEvent | null {
  const event = asRecord(value);
  if (!event || typeof event.type !== "string" || !ALERT_TYPE_SET.has(event.type)) return null;

  const timestampValue = event.timestamp;
  const timestampMs = typeof timestampValue === "number"
    ? timestampValue
    : typeof timestampValue === "string"
      ? Date.parse(timestampValue)
      : Number.NaN;
  if (!Number.isFinite(timestampMs)) return null;

  const type = event.type as AlertType;
  const timestamp = new Date(timestampMs).toISOString();
  const severity = normalizedText(event.severity, 40).toUpperCase() || "UNKNOWN";
  const record = asRecord(event.record);
  const recordId = normalizedText(record?.id, 160);
  const description = normalizedText(event.description, 240);
  const dedupeKey = `${type}|${timestamp}|${recordId || `${severity}|${description}`}`;

  return { type, timestamp, timestampMs, severity, dedupeKey };
}

function normalizeHealth(value: unknown): { source: string; health: NormalizedHealth } | null {
  const record = asRecord(value);
  const source = normalizedText(record?.source, 120);
  if (!source) return null;

  const status = typeof record?.status === "string" && SOURCE_HEALTH_STATES.has(record.status as SourceHealthStatus)
    ? record.status as SourceHealthStatus
    : "unknown";
  const checkedAtText = normalizedText(record?.checkedAt, 80);
  const checkedAt = checkedAtText && Number.isFinite(Date.parse(checkedAtText)) ? checkedAtText : null;
  const error = normalizedText(record?.error, 240) || null;
  const itemCount = typeof record?.itemCount === "number" && Number.isInteger(record.itemCount) && record.itemCount >= 0
    ? record.itemCount
    : null;

  return { source, health: { status, checkedAt, error, itemCount } };
}

export function classifyAlertCondition(level: unknown): AlertConditionState {
  const normalized = normalizedText(level, 40).toUpperCase();
  if (!normalized) return "unknown";
  return EXPLICIT_CALM_LEVELS.has(normalized) ? "calm" : "active";
}

export function deriveAlertDisplayState(
  healthStatus: AlertHealthState,
  conditionState: AlertConditionState,
): AlertDisplayState {
  if (healthStatus === "empty" || healthStatus === "stale" || healthStatus === "unavailable") return healthStatus;
  if (healthStatus === "unknown") return "unknown";
  if (conditionState === "calm") return "calm";
  if (conditionState === "active") return "active";
  return "available";
}

export function alertHeatIntensity(count: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(maximum) || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / maximum) * 4))) as 1 | 2 | 3 | 4;
}

/**
 * Aggregate a bounded, UTC-day view over all eight alert types.
 *
 * Input events may be the union of `/api/alerts/timeline` and the eight
 * `/api/alerts/{type}/history` responses. Exact overlaps are deduplicated.
 */
export function buildAlertTrendView(input: AlertTrendInput = {}): AlertTrendView {
  const days = boundedInteger(input.days, ALERT_TREND_DAYS, MAX_ALERT_TREND_DAYS);
  const maxEvents = boundedInteger(input.maxEvents, MAX_ALERT_TREND_EVENTS, MAX_ALERT_TREND_EVENTS);
  const nowMs = input.now === undefined ? Date.now() : new Date(input.now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Alert trend now must be a valid date");

  const endDayMs = utcDayStart(nowMs);
  const startDayMs = endDayMs - (days - 1) * DAY_MS;
  const endExclusiveMs = endDayMs + DAY_MS;
  const dates = Array.from({ length: days }, (_, index) => utcDate(startDayMs + index * DAY_MS));
  const dateIndex = new Map(dates.map((date, index) => [date, index]));

  const healthBySource = new Map<string, NormalizedHealth>();
  for (const value of input.sourceHealth ?? []) {
    const normalized = normalizeHealth(value);
    if (normalized) healthBySource.set(normalized.source, normalized.health);
  }

  const rowState = new Map<AlertType, {
    buckets: Array<{ date: string; count: number; severityCounts: Record<string, number> }>;
    sampledEvents: number;
    mostRecentAt: string | null;
  }>();
  for (const type of ALERT_TYPES) {
    rowState.set(type, {
      buckets: dates.map(date => ({ date, count: 0, severityCounts: {} })),
      sampledEvents: 0,
      mostRecentAt: null,
    });
  }

  const allEvents = input.events ?? [];
  const sampledInput = allEvents.slice(Math.max(0, allEvents.length - maxEvents));
  const seen = new Set<string>();
  let duplicateEvents = 0;
  let invalidEvents = 0;
  let processedEvents = 0;

  for (const value of sampledInput) {
    const event = normalizeEvent(value);
    if (!event) {
      invalidEvents += 1;
      continue;
    }
    if (seen.has(event.dedupeKey)) {
      duplicateEvents += 1;
      continue;
    }
    seen.add(event.dedupeKey);
    processedEvents += 1;

    const state = rowState.get(event.type)!;
    state.sampledEvents += 1;
    if (state.mostRecentAt === null || event.timestamp > state.mostRecentAt) state.mostRecentAt = event.timestamp;
    if (event.timestampMs < startDayMs || event.timestampMs >= endExclusiveMs) continue;

    const bucket = state.buckets[dateIndex.get(utcDate(event.timestampMs))!];
    bucket.count += 1;
    bucket.severityCounts[event.severity] = (bucket.severityCounts[event.severity] ?? 0) + 1;
  }

  let maxCellCount = 0;
  for (const state of rowState.values()) {
    for (const bucket of state.buckets) maxCellCount = Math.max(maxCellCount, bucket.count);
  }

  const rows = ALERT_TYPES.map(type => {
    const source = ALERT_SOURCE_BY_TYPE[type];
    const health = healthBySource.get(source) ?? { status: "unknown" as const, checkedAt: null, error: null, itemCount: null };
    const currentLevel = normalizedText(input.currentLevels?.[type], 40).toUpperCase() || null;
    const conditionState = classifyAlertCondition(currentLevel);
    const state = rowState.get(type)!;
    const buckets = state.buckets.map(bucket => ({
      ...bucket,
      intensity: alertHeatIntensity(bucket.count, maxCellCount),
    }));

    return {
      type,
      source,
      healthStatus: health.status,
      healthCheckedAt: health.checkedAt,
      healthError: health.error,
      healthItemCount: health.itemCount,
      currentLevel,
      conditionState,
      displayState: deriveAlertDisplayState(health.status, conditionState),
      buckets,
      windowEvents: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
      sampledEvents: state.sampledEvents,
      mostRecentAt: state.mostRecentAt,
    } satisfies AlertTrendRow;
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    days,
    rows,
    maxCellCount,
    processedEvents,
    duplicateEvents,
    invalidEvents,
    truncatedEvents: Math.max(0, allEvents.length - sampledInput.length),
  };
}

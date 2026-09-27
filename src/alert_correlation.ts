#!/usr/bin/env bun
/**
 * Alert correlation engine — cross-monitor co-occurrence analysis.
 *
 * Extracted from the inline logic that lived in the
 * GET /api/alerts/correlation route (two hardcoded pattern pairs, untyped
 * arrays). This module:
 *
 * - scans the persisted history.jsonl of every monitor that keeps one
 *   (8 core + the Phase-12 extended monitors that write histories);
 * - evaluates a small set of EVIDENCE-BASED directional pair specs
 *   (the effect must FOLLOW the cause inside the window, never precede it);
 * - reports observed vs. uniform-rate-expected pair counts (lift), median
 *   lag, and a cadence-sensitivity flag so monitor run cadence cannot
 *   masquerade as a finding;
 * - is deterministic, offline, and LLM-free.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { outputRoot } from "./shared/paths.js";
import { createLogger } from "./logger.js";

const log = createLogger("alert_correlation");

export const CORRELATION_SCHEMA = "crescent-city-alert-correlations/v1" as const;

/**
 * Every monitor source that keeps (or may keep) a history.jsonl.
 *
 * `marinezone` is included: `nws_marine.ts` writes
 * `output/alerts/marinezone/history.jsonl` with a `fetchedAt` stamp and a
 * `worstLevel` tier, so it is analytics-shaped like the rest. Omitting it
 * under-reported `sourcesScanned` and made the `weather-marine` pair read the
 * buoy monitor only, never the zone forecast product.
 */
export const CORRELATION_SOURCES = [
  "tsunami", "earthquake", "weather", "airquality", "wildfire", "marine", "marinezone",
  "tides", "fishing", "drought", "psps", "smoke", "roads", "schools", "uscg",
] as const;
export type CorrelationSource = (typeof CORRELATION_SOURCES)[number];

/**
 * History paths match the runners: extended monitors live under output/alerts,
 * tides/fishing under output/.
 *
 * Every branch resolves through `outputRoot()`. The eleven alert branches used
 * to hardcode `process.cwd()/output`, so with `CC_OUTPUT_DIR` set one report
 * read two different trees — and any process whose cwd was not the repo root
 * silently got `hasHistory: false` for every monitor. `outputRoot()` is the
 * documented artifact-root seam (see `src/shared/paths.ts`).
 */
function historyPathFor(source: CorrelationSource): string {
  if (source === "fishing") return join(outputRoot(), "fishing", "history.jsonl");
  if (source === "tides") return join(outputRoot(), "tides", "history.jsonl");
  return join(outputRoot(), "alerts", source, "history.jsonl");
}

/** One normalized monitor event. */
export interface CorrelationEvent {
  source: CorrelationSource;
  /** ISO timestamp (record's fetchedAt/timestamp/time — first present). */
  timestamp: string;
  severity: string;
  description: string;
  record: Record<string, unknown>;
}

function readHistory(source: CorrelationSource): CorrelationEvent[] {
  const file = historyPathFor(source);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const events: CorrelationEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a corrupt row is skipped, never fatal
    }
    const stamp = record.fetchedAt ?? record.timestamp ?? record.time ?? record.assessedAt;
    if (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp))) continue;
    events.push({
      source,
      timestamp: stamp,
      severity: severityFor(source, record),
      description: describe(source, record),
      record,
    });
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

/** Per-source severity, covering the extended monitors the analytics layer does not know. */
function severityFor(source: CorrelationSource, r: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (source) {
    case "tsunami": return str(r.severity) || "alert";
    case "earthquake": {
      const mag = typeof r.magnitude === "number" ? r.magnitude : typeof r.mag === "number" ? r.mag : 0;
      return mag >= 6 ? "WARNING" : "WATCH";
    }
    case "weather": return str(r.severity) || "advisory";
    case "airquality": return str(r.level) || "CALM";
    case "wildfire": return str(r.level) || (r.hasEvacuationOrders === true ? "WARNING" : "ADVISORY");
    case "marine": return str(r.level) || "CALM";
    // The CWF monitor persists `worstLevel` (its tier), not `level`.
    case "marinezone": return str(r.worstLevel) || "CALM";
    case "tides":
    case "fishing": return str(r.level) || "CALM";
    case "drought": return str(r.severity) || "NONE";
    case "smoke": return str(r.level) || "UNKNOWN";
    case "roads":
    case "schools": return str(r.severity) || "ADVISORY";
    // The monitor persists `level` (its classified criticality) per broadcast.
    case "uscg": return str(r.level) || "CALM";
    case "psps": return str(r.level) || str(r.severity) || "alert";
  }
}

/** Highest AQI on an air-quality row, robust to both persisted shapes. */
export function maxAqiOf(record: Record<string, unknown>): number | null {
  if (typeof record.maxAqi === "number") return record.maxAqi;
  if (Array.isArray(record.readings)) {
    const values = record.readings
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>).aqi : undefined))
      .filter((v): v is number => typeof v === "number");
    if (values.length > 0) return Math.max(...values);
  }
  return null;
}

function describe(source: CorrelationSource, r: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (source) {
    case "earthquake": return `M${typeof r.magnitude === "number" ? r.magnitude : "?"} earthquake ${str(r.place)}`.trim();
    case "drought": return `${str(r.county)} drought ${str(r.severity)} (affected area ${typeof r.percent === "number" ? r.percent : "?"}%)`;
    case "smoke": return `Smoke ${str(r.level)} (AQI ${typeof r.aqi === "number" ? r.aqi : "?"})`;
    case "roads": return `${str(r.route)}: ${str(r.description)}`;
    case "wildfire": return `${str(r.name) || "Wildfire"} (${typeof r.acres === "number" ? r.acres : "?"} acres, ${str(r.county)})`;
    case "airquality": return `AQI ${maxAqiOf(r) ?? "?"}`;
    case "marine": return str(r.stationName) ? `Marine ${str(r.stationName)}` : "Marine condition";
    case "marinezone": return str(r.summary) || `Coastal waters forecast ${str(r.worstLevel)}`;
    case "tsunami": return str(r.headline) || str(r.event) || "Tsunami alert";
    case "weather": return str(r.headline) || str(r.event) || "Weather alert";
    case "tides": return str(r.summary) || "Tide reading";
    case "fishing": return str(r.summary) || "Fishing report";
    case "psps": return str(r.summary) || "PSPS status";
    case "schools": return str(r.summary) || "School status";
    case "uscg": return str(r.summary) || str(r.descriptor) || `USCG broadcast ${str(r.msgId)}`;
  }
}

/** A directional pair hypothesis: B events within `windowMinutes` AFTER A. */
export interface CorrelationPairSpec {
  id: string;
  typeA: CorrelationSource;
  typeB: CorrelationSource;
  windowMinutes: number;
  rationale: string;
  /** Gate on the A (cause) event. */
  relevantA: (event: CorrelationEvent) => boolean;
  /** Gate on the B (effect) event. */
  relevantB: (event: CorrelationEvent) => boolean;
}

const isDroughtEmergency = (e: CorrelationEvent): boolean =>
  ["D2", "D3", "D4"].includes(e.severity);
const isAqSpike = (e: CorrelationEvent): boolean => {
  const aqi = maxAqiOf(e.record);
  return (aqi !== null && aqi >= 100) || e.severity === "WARNING" || e.severity === "EMERGENCY";
};
const isSignificantWildfire = (e: CorrelationEvent): boolean =>
  e.record.hasEvacuationOrders === true ||
  (typeof e.record.acres === "number" && e.record.acres >= 100);

/**
 * The evaluated pair set. Windows follow the physical story: tsunamis trail
 * quakes within the hour, smoke-driven AQI spikes trail fire reports within
 * hours, marine advisories trail severe coastal weather within a day, and
 * elevated fire activity trails severe drought by weeks.
 */
export const CORRELATION_PAIR_SPECS: readonly CorrelationPairSpec[] = [
  {
    id: "earthquake-tsunami",
    typeA: "earthquake", typeB: "tsunami", windowMinutes: 60,
    rationale: "A M6+ earthquake may precede a tsunami alert within the hour",
    relevantA: (e) => e.severity === "WARNING" || e.severity === "EMERGENCY",
    relevantB: () => true,
  },
  {
    id: "wildfire-airquality",
    typeA: "wildfire", typeB: "airquality", windowMinutes: 360,
    rationale: "A significant wildfire incident may drive an unhealthy AQI spike within hours",
    relevantA: isSignificantWildfire,
    relevantB: isAqSpike,
  },
  {
    id: "weather-marine",
    typeA: "weather", typeB: "marine", windowMinutes: 1440,
    rationale: "Severe coastal weather often precedes elevated marine conditions within a day",
    relevantA: (e) => e.severity === "WARNING" || e.severity === "EMERGENCY",
    relevantB: (e) => e.severity !== "CALM",
  },
  {
    id: "drought-wildfire",
    typeA: "drought", typeB: "wildfire", windowMinutes: 43200,
    rationale: "Severe drought (D2+) precedes elevated wildfire activity by weeks",
    relevantA: isDroughtEmergency,
    relevantB: () => true,
  },
];

export interface CorrelationPairReport {
  id: string;
  typeA: CorrelationSource;
  typeB: CorrelationSource;
  windowMinutes: number;
  rationale: string;
  /** Relevant A events in the analyzed span. */
  eventsA: number;
  /** Relevant B events in the analyzed span. */
  eventsB: number;
  /** (A, B) pairs with 0 <= lag <= window. */
  observedPairs: number;
  /** Uniform-rate expectation: eventsA * eventsB * window / spanMinutes. */
  expectedPairs: number;
  /** observed / expected; null when there is nothing to compare. */
  lift: number | null;
  medianLagMinutes: number | null;
  firstCoOccurrence: string | null;
  lastCoOccurrence: string | null;
  /**
   * True when A or B writes more often than the window — co-occurrence is
   * then near-guaranteed by run cadence and must not be read as a finding.
   */
  cadenceSensitive: boolean;
  samples: Array<{ aTimestamp: string; aDescription: string; bTimestamp: string; bDescription: string; lagMinutes: number }>;
}

export interface AlertCorrelationReport {
  schemaVersion: typeof CORRELATION_SCHEMA;
  generatedAt: string;
  /** Events successfully parsed per source (sources with no history report 0). */
  sourcesScanned: Array<{ source: CorrelationSource; events: number; hasHistory: boolean }>;
  analyzedSpan: { start: string; end: string } | null;
  totalEventsScanned: number;
  pairs: CorrelationPairReport[];
  /** Sample-level detections in the legacy route shape ({type, description, events}). */
  correlations: Array<{ type: string; description: string; events: Array<Record<string, unknown>>; pairIndex: number }>;
  totalCorrelations: number;
  notes: string[];
}

/** Median of a numeric list; null for empty input. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median gap between consecutive events of one source (minutes). */
function medianCadenceMinutes(events: CorrelationEvent[]): number | null {
  if (events.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < events.length; i++) {
    gaps.push((Date.parse(events[i]!.timestamp) - Date.parse(events[i - 1]!.timestamp)) / 60000);
  }
  return median(gaps);
}

/**
 * Build the correlation report. `eventsBySource` may be injected for tests;
 * when omitted, every source's persisted history is read. A supplied map is
 * whole-world: it replaces disk for EVERY source, and its events are
 * normalized through the same severity/description rules as disk reads.
 */
export function buildAlertCorrelations(
  eventsBySource?: Partial<Record<CorrelationSource, CorrelationEvent[]>>,
): AlertCorrelationReport {
  const scanned: AlertCorrelationReport["sourcesScanned"] = [];
  const bySource = new Map<CorrelationSource, CorrelationEvent[]>();
  for (const source of CORRELATION_SOURCES) {
    const raw = eventsBySource ? (eventsBySource[source] ?? []) : readHistory(source);
    // Sort unconditionally. `medianCadenceMinutes` differences consecutive
    // timestamps, and the disk path already sorted; the injected path did not,
    // so injecting two out-of-order events produced a negative cadence, which
    // then tripped the cadence-sensitivity gate and sorted the pair last
    // despite real co-occurrences.
    const events = raw
      .map((e) => ({ ...e, severity: severityFor(source, e.record), description: describe(source, e.record) }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    bySource.set(source, events);
    // An injected map replaces disk for every source, so `existsSync` is not
    // consulted on that path: it made the report cwd-dependent (the same input
    // reported hasHistory true from the repo root and false elsewhere) and
    // contradicted this module's own "no filesystem" test contract.
    scanned.push({
      source,
      events: events.length,
      hasHistory: events.length > 0 || (!eventsBySource && existsSync(historyPathFor(source))),
    });
  }

  const allStamps = [...bySource.values()].flat().map((e) => e.timestamp).sort();
  const analyzedSpan = allStamps.length > 0
    ? { start: allStamps[0]!, end: allStamps[allStamps.length - 1]! }
    : null;
  const spanMinutes = analyzedSpan
    ? Math.max((Date.parse(analyzedSpan.end) - Date.parse(analyzedSpan.start)) / 60000, 1)
    : 0;

  const pairs: CorrelationPairReport[] = [];
  const correlations: AlertCorrelationReport["correlations"] = [];
  const notes: string[] = [];
  /** Final sort position per note, filled after `pairs` is reordered. */
  const notePairIndex = new Map<string, number>();

  for (const spec of CORRELATION_PAIR_SPECS) {
    const aEvents = (bySource.get(spec.typeA) ?? []).filter(spec.relevantA);
    const bEvents = (bySource.get(spec.typeB) ?? []).filter(spec.relevantB);
    const samples: CorrelationPairReport["samples"] = [];
    const lags: number[] = [];
    let first: string | null = null;
    let last: string | null = null;

    // Both event lists are sorted by timestamp (see the sort in the scan loop),
    // so the inner scan can stop at the first event past the window instead of
    // testing every remaining pair. Without this the 30-day drought->wildfire
    // spec runs a full A x B cross product — every pair in-window on sub-daily
    // cron histories — parsing each timestamp twice and retaining every lag in
    // memory, synchronously on a plain GET request.
    const aParsed = aEvents.map((e) => ({ event: e, ms: Date.parse(e.timestamp) }));
    const bParsed = bEvents.map((e) => ({ event: e, ms: Date.parse(e.timestamp) }));

    for (const a of aParsed) {
      for (const b of bParsed) {
        const lag = (b.ms - a.ms) / 60000;
        if (lag < 0) continue;
        if (lag > spec.windowMinutes) break;
        lags.push(lag);
        if (first === null || a.event.timestamp < first) first = a.event.timestamp;
        if (last === null || a.event.timestamp > last) last = a.event.timestamp;
        if (samples.length < 3) {
          samples.push({
            aTimestamp: a.event.timestamp, aDescription: a.event.description,
            bTimestamp: b.event.timestamp, bDescription: b.event.description,
            lagMinutes: Math.round(lag * 10) / 10,
          });
          correlations.push({
            type: spec.id,
            // Placeholder; rewritten to the final `pairs` index after the sort.
            pairIndex: 0,
            description: `${a.event.description} then ${b.event.description} (${lag.toFixed(0)} min later)`,
            events: [
              { source: a.event.source, timestamp: a.event.timestamp, severity: a.event.severity, description: a.event.description },
              { source: b.event.source, timestamp: b.event.timestamp, severity: b.event.severity, description: b.event.description },
            ],
          });
        }
      }
    }

    // Uniform-rate expectation. The probability that a given B lands inside a
    // window of width w is min(w, span)/span, not w/span: the window cannot
    // extend past the span being analysed. Without the clamp, a spec whose
    // window exceeds the observed history (the 30-day drought->wildfire window
    // over ~12,400 minutes of history) over-counts its expectation, and since
    // observed <= A*B always, lift is mathematically capped below 1 — a perfect
    // relationship reads as 0.29 next to a coincidental 60-minute pair at 200.
    const effectiveWindow = Math.min(spec.windowMinutes, spanMinutes);
    const expected = analyzedSpan && aEvents.length > 0 && bEvents.length > 0
      ? (aEvents.length * bEvents.length * effectiveWindow) / spanMinutes
      : 0;
    const windowExceedsSpan = analyzedSpan !== null && spec.windowMinutes > spanMinutes;
    const cadenceA = medianCadenceMinutes(aEvents);
    const cadenceB = medianCadenceMinutes(bEvents);
    const cadenceSensitive =
      (cadenceA !== null && cadenceA < spec.windowMinutes) ||
      (cadenceB !== null && cadenceB < spec.windowMinutes);

    pairs.push({
      id: spec.id,
      typeA: spec.typeA,
      typeB: spec.typeB,
      windowMinutes: spec.windowMinutes,
      rationale: spec.rationale,
      eventsA: aEvents.length,
      eventsB: bEvents.length,
      observedPairs: lags.length,
      expectedPairs: Math.round(expected * 100) / 100,
      lift: expected > 0 && lags.length > 0 ? Math.round((lags.length / expected) * 100) / 100 : null,
      medianLagMinutes: median(lags),
      firstCoOccurrence: first,
      lastCoOccurrence: last,
      cadenceSensitive,
      samples,
    });

    if (lags.length > 0 && cadenceSensitive) {
      notes.push(`${spec.id}: A or B writes more often than the ${spec.windowMinutes}-minute window — treat the co-occurrence as cadence, not causation.`);
    }
    if (windowExceedsSpan) {
      notes.push(`${spec.id}: its ${spec.windowMinutes}-minute window is wider than the ${Math.round(spanMinutes)}-minute history analysed, so the window is not testable over this span — lift is computed against the clamped window.`);
    }
  }

  const totalEvents = [...bySource.values()].flat().length;
  log.info(`Alert correlations: ${totalEvents} events scanned, ${pairs.reduce((sum, p) => sum + p.observedPairs, 0)} co-occurring pairs`);

  // Informative pairs first (non-cadence, by lift), cadence artifacts last.
  //
  // `correlations` and `notes` are built in CORRELATION_PAIR_SPECS order while
  // this sort reorders `pairs`, so a consumer that matched `correlations[i].type`
  // to `pairs[i].id` — or `notes[i]` to `pairs[i].id` — read the wrong pair.
  // Re-keying both by pair id makes the index correspondence hold for any
  // consumer, sorted or not.
  pairs.sort((a, b) => {
    if (a.cadenceSensitive !== b.cadenceSensitive) return a.cadenceSensitive ? 1 : -1;
    return (b.lift ?? -1) - (a.lift ?? -1);
  });
  for (const [index, pair] of pairs.entries()) {
    for (const correlation of correlations) {
      if (correlation.type === pair.id) correlation.pairIndex = index;
    }
    for (const note of notes) {
      if (note.startsWith(`${pair.id}:`)) notePairIndex.set(note, index);
    }
  }
  const orderedNotes = notes
    .map(note => ({ note, index: notePairIndex.get(note) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.note);

  return {
    schemaVersion: CORRELATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourcesScanned: scanned,
    analyzedSpan,
    totalEventsScanned: totalEvents,
    pairs,
    correlations,
    totalCorrelations: correlations.length,
    notes: orderedNotes,
  };
}

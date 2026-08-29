/**
 * Composite alert-input shaping and source-health classification.
 *
 * All the DOMAIN logic the alert orchestrator needs to (a) shape the 8
 * monitors' reports into the inputs `computeAlertSeverity` expects, and (b)
 * turn each monitor's run outcome into a typed `SourceHealth` record. These
 * live in `src/` (not in the orchestration script) so they are pure, unit
 * testable, and shared — `scripts/run-alerts.ts` only triggers the monitors
 * and persists artifacts.
 *
 * No network or filesystem side effects here; the freshness check is pure over
 * the report's own timestamp.
 */
import type { TideReport } from "./noaa_tides.js";
import type { FishingReport } from "./cdfw_fishing.js";
import type { SourceHealth, SourceHealthStatus } from "../types.js";
// Each monitor owns its endpoint constant. The spec table below references
// them rather than restating the literals, so a URL can only be changed in one
// place and the health record can never name an endpoint the monitor no longer
// calls.
import { USDM_API_URL } from "./usdm_drought.js";
import { PGE_PSPS_API_URL } from "./pge_psps.js";
import { HRRR_SMOKE_API_URL } from "./hrrr_smoke.js";
import { CALTRANS_API_D1_URL } from "./caltrans_roads.js";
import { DUSD_ALERTS_URL } from "./dusd_schools.js";

/** A single monitor's run outcome + the metadata needed to classify it. */
/**
 * The monitors the alert runner starts, in batch order, each with a stable key.
 *
 * A monitor's identity used to be its POSITION in the runner's Promise.allSettled
 * array, re-declared by hand as a literal index in five places across three
 * files. Inserting a monitor mid-list would have silently handed one monitor's
 * result to another's health record — and the same positional thinking is how
 * five monitors' reports went missing from the composite severity entirely.
 * The key is the contract now; the order is just how they are launched.
 */
export const MONITOR_KEYS = [
  "tsunami", "earthquake", "weather", "airquality", "wildfire", "marine",
  "tides", "fishing", "drought", "psps", "smoke", "roads", "schools",
] as const;

export type MonitorKey = typeof MONITOR_KEYS[number];

/**
 * Monitors that answer a failure with `null` rather than throwing. For these, a
 * null result is an unavailable source; for the others it would be a real empty
 * report. Membership is by key, not by position in the runner's batch.
 */
export const NULL_ON_FAILURE_MONITORS = new Set<MonitorKey>([
  "airquality", "wildfire", "marine", "tides", "fishing",
  "drought", "psps", "smoke", "roads", "schools",
]);

export interface AlertMonitorDefinition {
  source: string;
  key: MonitorKey;
  report: unknown | null;
  itemCount: number;
  url: string;
  provenance: string;
}

/** Payloads available to shape the composite severity inputs. */
export interface CompositePayload {
  tsunami: unknown | null;
  earthquake: unknown | null;
  weather: unknown | null;
  airquality: unknown | null;
  wildfire: unknown | null;
  marine: unknown | null;
  tidesReport: TideReport | null;
  fishingReport: FishingReport | null;
  now?: number;
}

/** Read plain fields off an unknown report object whatever its shape. */
function asRecord(value: unknown): Record<string, any> {
  return (value && typeof value === "object" ? value : {}) as Record<string, any>;
}

const FRESHNESS_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * A monitor report is "fresh" only if its fetchedAt/timestamp is within the
 * last hour. Anything else is treated as absent so a stale snapshot is not
 * presented as current.
 */
export function isFreshReport(report: unknown, now = Date.now()): boolean {
  const record = asRecord(report);
  const timestamp = record.fetchedAt ?? record.timestamp;
  if (typeof timestamp !== "string") return false;
  const ageMs = now - Date.parse(timestamp);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= FRESHNESS_WINDOW_MS;
}

/** Shaping for the tides monitor: prefer the current observed level. */
export function buildTidesInput(report: TideReport | null): {
  waterLevelFt: number | null;
  available: boolean;
} {
  const observed = Number(report?.waterLevel?.v);
  return {
    waterLevelFt: report
      ? (Number.isFinite(observed) ? observed : (report.maxPredictedLevel ?? null))
      : null,
    available: !!report,
  };
}

/** Shaping for the fishing/crab-closure monitor. */
export function buildFishingInput(report: FishingReport | null): {
  closureActive: boolean;
  closureMessage?: string;
  available: boolean;
} {
  return {
    closureActive: report
      ? !report.crabStatus.commercialOpen || !report.crabStatus.recreationalOpen
      : false,
    closureMessage: report?.crabStatus.statusNote,
    available: !!report,
  };
}

/**
 * Shape all 8 monitors' reports into the exact input object
 * `computeAlertSeverity` expects (tsunami/earthquake/weather/tides/fishing/
 * airQuality/wildfire/marine).
 */
export function buildCompositeInput(payload: CompositePayload): Record<string, any> {
  const { tsunami, earthquake, weather, airquality, wildfire, marine, tidesReport, fishingReport, now } = payload;
  const tsunamiR = asRecord(tsunami);
  const weatherR = asRecord(weather);
  const earthquakeR = asRecord(earthquake);
  const airR = asRecord(airquality);
  const wildfireR = asRecord(wildfire);
  const marineR = asRecord(marine);

  const tidesInput = buildTidesInput(tidesReport);
  const fishingInput = buildFishingInput(fishingReport);
  // Availability is freshness-gated here (consistent with air/wildfire/marine):
  // a stale snapshot must not be presented as a current reading. The orchestrator
  // always passes a just-generated report, so `now` defaults to Date.now().
  const tides = { ...tidesInput, available: tidesInput.available && isFreshReport(tidesReport, now) };
  const fishing = { ...fishingInput, available: fishingInput.available && isFreshReport(fishingReport, now) };

  // Tsunami: read the monitor's OWN threatLevel (warning/watch/advisory),
  // NOT the CAP `severity` enum (Minor/Moderate/Severe/Extreme).
  const tsunamiAlerts = Array.isArray(tsunamiR.alerts) ? tsunamiR.alerts : [];
  const weatherAlerts = Array.isArray(weatherR.alerts) ? weatherR.alerts : [];

  return {
    tsunami: {
      warningCount: tsunamiAlerts.filter((a: any) => a.threatLevel === "warning").length,
      watchCount: tsunamiAlerts.filter((a: any) => a.threatLevel === "watch" || a.threatLevel === "advisory").length,
      available: isFreshReport(tsunami, now),
    },
    earthquake: {
      events: (Array.isArray(earthquakeR.events) ? earthquakeR.events : []).map((e: any) => ({
        magnitude: e.magnitude ?? e.mag ?? 0,
        distanceKm: e.distanceKm ?? 200,
        tsunami: e.tsunami ?? 0,
        place: e.place ?? "",
      })),
      available: isFreshReport(earthquake, now),
    },
    weather: {
      severities: weatherAlerts.map((a: any) => a.severityLevel ?? "advisory"),
      count: weatherAlerts.length,
      available: isFreshReport(weather, now),
    },
    tides,
    fishing,
    airQuality: {
      maxAqi: airR.maxAqi ?? 0,
      available: isFreshReport(airquality, now) && Array.isArray(airR.readings) && airR.readings.length > 0,
    },
    wildfire: {
      incidentCount: wildfireR.totalIncidents ?? 0,
      hasEvacuationOrders: (Array.isArray(wildfireR.incidents) ? wildfireR.incidents : []).some((i: any) => i.hasEvacuationOrders),
      // Match classifyWildfireSeverity's distance rule (large fire nearby = a
      // 1000+ acre fire with <50% containment within 50 km), so the composite
      // WARNING tier never disagrees with the monitor's own ADVISORY for a
      // large fire that is far away (e.g. interior Humboldt, ~130 km out).
      hasLargeFireNearby: (Array.isArray(wildfireR.incidents) ? wildfireR.incidents : []).some((i: any) =>
        i.acres >= 1000 && i.containmentPercent < 50 && i.distanceKm !== null && i.distanceKm <= 50),
      available: isFreshReport(wildfire, now),
    },
    marine: {
      // Prefer the primary buoy (46027) exactly as ndbc_marine.ts does —
      // `observations[0]` can be a far-field station when 46027 is down.
      waveHeightFt: (Array.isArray(marineR.observations) ? marineR.observations : []).find((o: any) => o.stationId === "46027")?.waveHeightFt
        ?? marineR.observations?.[0]?.waveHeightFt ?? null,
      windSpeedKt: (Array.isArray(marineR.observations) ? marineR.observations : []).find((o: any) => o.stationId === "46027")?.windSpeedKt
        ?? marineR.observations?.[0]?.windSpeedKt ?? null,
      available: isFreshReport(marine, now) && Array.isArray(marineR.observations) && marineR.observations.length > 0,
    },
  };
}


/**
 * The five Phase-12 monitors' reports, mapped onto the severity inputs they
 * feed. Until this existed the runner passed eight of the thirteen monitors
 * into computeAlertSeverity and let the other five fall back to their
 * "nothing happening, not available" defaults — so road closures, school
 * closures, PSPS, smoke and drought were collected, published as their own
 * artifacts, and then silently excluded from the composite level the front page
 * presents as the county's alert state.
 *
 * `available` is the honest question "did this monitor produce a report in this
 * run?", not "is anything wrong?" — an unavailable monitor must not read as calm.
 */
export function buildExtendedCompositeInput(reports: {
  drought?: unknown;
  psps?: unknown;
  smoke?: unknown;
  roads?: unknown;
  schools?: unknown;
}): Record<string, unknown> {
  const drought = asRecord(reports.drought);
  const psps = asRecord(reports.psps);
  const smoke = asRecord(reports.smoke);
  const roads = asRecord(reports.roads);
  const schools = asRecord(reports.schools);
  return {
    drought: {
      severity: (drought.compositeSeverity as string) ?? "NONE",
      severeDroughtPercent: typeof drought.severeDroughtPercent === "number" ? drought.severeDroughtPercent : 0,
      available: reports.drought != null,
    },
    psps: {
      status: (psps.overallStatus as string) ?? "NONE",
      eventCount: typeof psps.totalEvents === "number" ? psps.totalEvents : 0,
      delNorteAffected: psps.delNorteAffected === true,
      available: reports.psps != null,
    },
    smoke: {
      peakLevel: (smoke.peakLevel as string) ?? "GOOD",
      peakAqi: typeof smoke.peakAqi === "number" ? smoke.peakAqi : null,
      maxPm25: typeof smoke.maxPm25 === "number" ? smoke.maxPm25 : null,
      available: reports.smoke != null,
    },
    roads: {
      severity: (roads.overallSeverity as string) ?? "NONE",
      hasMajorClosure: roads.hasMajorClosure === true,
      incidentCount: typeof roads.totalIncidents === "number" ? roads.totalIncidents : 0,
      available: reports.roads != null,
    },
    schools: {
      status: (schools.districtStatus as string) ?? "OPEN",
      hasActiveClosure: schools.hasActiveClosure === true,
      hasActiveDelay: schools.hasActiveDelay === true,
      eventCount: typeof schools.totalEvents === "number" ? schools.totalEvents : 0,
      available: reports.schools != null,
    },
  };
}

/** The five Phase-12 extended monitors, by stable index in the runner batch. */
export type ExtendedMonitorSpec = readonly [
  source: string,
  key: MonitorKey,
  listField: string,
  url: string,
  provenance: string,
];

export const EXTENDED_MONITOR_SPECS: readonly ExtendedMonitorSpec[] = [
  ["USDM Drought", "drought", "readings", USDM_API_URL, "US Drought Monitor west-region JSON (Del Norte FIPS 06015)"],
  ["PG&E PSPS", "psps", "events", PGE_PSPS_API_URL, "PG&E PSPS events JSON"],
  ["HRRR Smoke", "smoke", "forecast", HRRR_SMOKE_API_URL, "AirFire HRRR smoke PM2.5 forecast"],
  ["Caltrans Roads", "roads", "incidents", CALTRANS_API_D1_URL, "Caltrans QuickMap District 1 incidents"],
  ["DUSD Schools", "schools", "items", DUSD_ALERTS_URL, "Del Norte USD announcements"],
];

/**
 * Build the SourceHealth definitions for the extended (index >= 8) monitors
 * from the runner's settled results. Pure: takes the settled-result array and
 * returns definitions ready for classifySourceHealth. The itemCount derives
 * from the report's list field (arrays count elements; a non-array truthy
 * value like the smoke `forecast` object counts as 1).
 */
export function buildExtendedMonitorDefinitions(
  results: Partial<Record<MonitorKey, PromiseSettledResult<unknown>>>,
): AlertMonitorDefinition[] {
  return EXTENDED_MONITOR_SPECS.map(([source, key, listField, url, provenance]): AlertMonitorDefinition => {
    const result = results[key];
    const report = result && result.status === "fulfilled" ? result.value : null;
    const count = (report as Record<string, any> | null)?.[listField];
    return {
      source,
      key,
      report,
      itemCount: Array.isArray(count) ? count.length : count ? 1 : 0,
      url,
      provenance,
    };
  });
}

/**
 * Classify one monitor run into a typed SourceHealth record.
 * `result` is the PromiseSettledResult for that monitor's index;
 * `monitorErrors` carries the runNullableMonitor last-error messages for
 * monitors that return null (rather than throwing) when degraded.
 */
export function classifySourceHealth(
  definition: AlertMonitorDefinition,
  result: PromiseSettledResult<unknown>,
  monitorErrors: Map<MonitorKey, string>,
  checkedAt = new Date().toISOString(),
): SourceHealth {
  const fetchedAt = (() => {
    const r = asRecord(definition.report);
    return r.fetchedAt ?? r.timestamp;
  })();
  const fresh = isFreshReport(definition.report);
  // The "null-report on failure" family: for these monitors a null value means
  // the monitor failed to produce a report, not that it produced an empty one.
  // This used to read `index >= 3`, so the family was defined by where a monitor
  // happened to sit in the runner's array.
  const failed = result.status === "rejected" ||
    (result.status === "fulfilled" && NULL_ON_FAILURE_MONITORS.has(definition.key) && result.value === null);

  let status: SourceHealthStatus = failed
    ? "unavailable"
    : !fresh
      ? "stale"
      : definition.itemCount === 0 ? "empty" : "ok";

  const error = result.status === "rejected"
    ? String(result.reason instanceof Error ? result.reason.message : result.reason)
    : failed ? (monitorErrors.get(definition.key) ?? "Monitor returned no report") : undefined;

  const health: SourceHealth = {
    source: definition.source,
    status,
    checkedAt,
    ...(fetchedAt ? { fetchedAt } : {}),
    itemCount: definition.itemCount,
    url: definition.url,
    ...(error ? { error } : {}),
    provenance: definition.provenance,
  };
  if (fetchedAt) {
    const ageMs = Date.parse(fetchedAt);
    if (Number.isFinite(ageMs)) health.ageMs = Math.max(0, Date.now() - ageMs);
  }
  return health;
}

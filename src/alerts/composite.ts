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
// The health record names the endpoint the monitor ACTUALLY calls. PG&E's
// exported JSON constant still exists (retained as the documented dead path)
// but 404s, AirFire's constant likewise, and QuickMap's serves an SPA shell —
// so naming them pointed an auditor at three dead or wrong endpoints.
import { PGE_PSPS_PAGE_URL } from "./pge_psps.js";
import { HMS_SMOKE_URL } from "./hrrr_smoke.js";
import { CALTRANS_ROADS_TEXT_URL } from "./caltrans_roads.js";
import { DUSD_ALERTS_URL } from "./dusd_schools.js";
import { NWS_CWF_LIST_URL } from "./nws_marine.js";
import { USCG_BNM_LIST_URL } from "./uscg_broadcasts.js";
import { MYGOV_PERMITS_URL } from "./permits.js";
import { CCHARBOR_SITEMAP_URL } from "./dredging.js";
import { EIA_CA_RETAIL_GAS_URL } from "./fuel.js";
import { PACFIN_DASHBOARD_URL } from "./pacfin.js";
import { DIGITRAFFIC_AIS_URL } from "./ais.js";

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
  "tsunami", "earthquake", "weather", "airquality", "wildfire", "marine", "marinezone",
  "tides", "fishing", "drought", "psps", "smoke", "roads", "schools", "uscg",
  "permits", "dredging", "fuel", "pacfin", "ais",
] as const;

export type MonitorKey = typeof MONITOR_KEYS[number];

/**
 * Monitors that answer a failure with `null` rather than throwing. For these, a
 * null result is an unavailable source; for the others it would be a real empty
 * report. Membership is by key, not by position in the runner's batch.
 */
export const NULL_ON_FAILURE_MONITORS = new Set<MonitorKey>([
  "airquality", "wildfire", "marine", "marinezone", "tides", "fishing",
  "drought", "psps", "smoke", "roads", "schools", "uscg",
  "permits", "dredging", "fuel", "pacfin", "ais",
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
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= alertFreshnessWindowMs();
}

/**
 * The extended monitors report `available: reports.X != null` — "did this monitor
 * produce a report in this run?" — with no freshness gate, unlike the eight core
 * monitors, which are gated through `isFreshReport`. Two windows then govern the
 * alert layer: `FRESHNESS_WINDOW_MS` here (1 hour, hardcoded) and
 * `DEFAULT_FRESHNESS_WINDOW_MS` in `shared/source_health.ts` (24 hours,
 * env-overridable). The same report can be `ok` under one and `stale` under the
 * other, and `SOURCE_FRESHNESS_WINDOW_MS` has no effect on alerts at all, so the
 * stricter of the two policies is not the one an operator can tune.
 *
 * One window, one place. `ALERT_FRESHNESS_WINDOW_MS` overrides it; unparseable or
 * non-positive values fall back to the 1-hour default rather than disabling the
 * gate, because a gate that silently turns off is how a stale snapshot starts
 * being presented as a current reading.
 */
function alertFreshnessWindowMs(): number {
  const parsed = Number((process.env.ALERT_FRESHNESS_WINDOW_MS ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 1000;
}

/**
 * Shaping for the tides monitor: report the OBSERVED level only.
 *
 * A dead sensor used to be silently replaced with `maxPredictedLevel` — the
 * maximum over the next 48 hours — and published as a current water level
 * ("Water level 7.1 ft MLLW (significant exceedance)") while the input report's
 * own summary said "max *predicted* water level". A routine sensor outage
 * therefore produced a real-sounding warning on a value that is a forecast, and
 * the monitor still reported healthy (`ok`, itemCount 72). A missing reading is
 * now `null` → `available: false` → "unavailable", never a plausible number.
 */
export function buildTidesInput(report: TideReport | null): {
  waterLevelFt: number | null;
  available: boolean;
} {
  const observed = Number(report?.waterLevel?.v);
  return {
    waterLevelFt: report && Number.isFinite(observed) ? observed : null,
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
      // `observations[0]` can be a far-field station (Eel River, 120 NM south)
      // when 46027 is down. The fallback applies to the *observation*, not to
      // the individual field: it used to `??` each field separately, so a
      // present-but-missing WVHT ("MM"/"--", routine for wave height) on 46027
      // silently pulled a 120 NM-distant buoy's reading into 46027's slot.
      ...(() => {
        const observations = Array.isArray(marineR.observations) ? marineR.observations : [];
        const primary = observations.find((o: any) => o.stationId === "46027") ?? observations[0];
        return {
          waveHeightFt: primary?.waveHeightFt ?? null,
          windSpeedKt: primary?.windSpeedKt ?? null,
        };
      })(),
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
 *
 * Availability is freshness-gated through the same `isFreshReport` as the eight
 * core monitors. It previously read `reports.X != null` alone, so a day-old
 * snapshot of an extended monitor was scored as a current reading while the
 * core monitors went stale after an hour.
 */
export function buildExtendedCompositeInput(
  reports: {
    drought?: unknown;
    psps?: unknown;
    smoke?: unknown;
    roads?: unknown;
    schools?: unknown;
    marinezone?: unknown;
    uscg?: unknown;
    permits?: unknown;
    dredging?: unknown;
    fuel?: unknown;
    pacfin?: unknown;
    ais?: unknown;
  },
  now = Date.now(),
): Record<string, unknown> {
  const drought = asRecord(reports.drought);
  const psps = asRecord(reports.psps);
  const smoke = asRecord(reports.smoke);
  const roads = asRecord(reports.roads);
  const schools = asRecord(reports.schools);
  const marinezone = asRecord(reports.marinezone);
  const uscg = asRecord(reports.uscg);
  const permits = asRecord(reports.permits);
  const dredging = asRecord(reports.dredging);
  const fuel = asRecord(reports.fuel);
  const pacfin = asRecord(reports.pacfin);
  const ais = asRecord(reports.ais);
  return {
    drought: {
      severity: (drought.compositeSeverity as string) ?? "NONE",
      severeDroughtPercent: typeof drought.severeDroughtPercent === "number" ? drought.severeDroughtPercent : 0,
      available: isFreshReport(reports.drought, now),
    },
    psps: {
      status: (psps.overallStatus as string) ?? "NONE",
      eventCount: typeof psps.totalEvents === "number" ? psps.totalEvents : 0,
      delNorteAffected: psps.delNorteAffected === true,
      available: isFreshReport(reports.psps, now),
    },
    smoke: {
      peakLevel: (smoke.peakLevel as string) ?? "GOOD",
      peakAqi: typeof smoke.peakAqi === "number" ? smoke.peakAqi : null,
      maxPm25: typeof smoke.maxPm25 === "number" ? smoke.maxPm25 : null,
      available: isFreshReport(reports.smoke, now),
    },
    roads: {
      severity: (roads.overallSeverity as string) ?? "NONE",
      hasMajorClosure: roads.hasMajorClosure === true,
      incidentCount: typeof roads.totalIncidents === "number" ? roads.totalIncidents : 0,
      available: isFreshReport(reports.roads, now),
    },
    schools: {
      status: (schools.districtStatus as string) ?? "OPEN",
      hasActiveClosure: schools.hasActiveClosure === true,
      hasActiveDelay: schools.hasActiveDelay === true,
      eventCount: typeof schools.totalEvents === "number" ? schools.totalEvents : 0,
      available: isFreshReport(reports.schools, now),
    },
    marinezone: {
      worstLevel: (marinezone.worstLevel as string) ?? "CALM",
      peakWindKt: typeof marinezone.peakWindKt === "number" ? marinezone.peakWindKt : null,
      available: isFreshReport(reports.marinezone, now),
    },
    uscg: {
      totalBroadcasts: typeof uscg.totalBroadcasts === "number" ? uscg.totalBroadcasts : 0,
      relevantCount: typeof uscg.relevantCount === "number" ? uscg.relevantCount : 0,
      worstLevel: (uscg.worstLevel as string) ?? "CALM",
      available: reports.uscg != null,
    },
    permits: {
      catalogSize: typeof permits.catalogSize === "number" ? permits.catalogSize : 0,
      changeCount: Array.isArray(permits.changedEntries) ? permits.changedEntries.length : 0,
      worstLevel: (permits.worstLevel as string) ?? "CALM",
      available: reports.permits != null,
    },
    dredging: {
      totalUrls: typeof dredging.totalUrls === "number" ? dredging.totalUrls : 0,
      relevantCount: typeof dredging.relevantCount === "number" ? dredging.relevantCount : 0,
      worstLevel: (dredging.worstLevel as string) ?? "CALM",
      available: reports.dredging != null,
    },
    fuel: {
      latestPrice: typeof fuel.latest?.pricePerGallon === "number" ? fuel.latest.pricePerGallon : null,
      deltaVsMedian: typeof fuel.deltaVsMedian === "number" ? fuel.deltaVsMedian : null,
      worstLevel: (fuel.worstLevel as string) ?? "CALM",
      available: reports.fuel != null,
    },
    pacfin: {
      reportCount: typeof pacfin.reportCount === "number" ? pacfin.reportCount : 0,
      changeCount: Array.isArray(pacfin.changedReports) ? pacfin.changedReports.length : 0,
      landingDataAvailable: pacfin.landingDataAvailable === true,
      worstLevel: (pacfin.worstLevel as string) ?? "CALM",
      available: reports.pacfin != null,
    },
    ais: {
      vesselsObserved: typeof ais.vesselsObserved === "number" ? ais.vesselsObserved : 0,
      vesselsInWatchArea: Array.isArray(ais.vesselsInWatchArea) ? ais.vesselsInWatchArea.length : 0,
      worstLevel: (ais.worstLevel as string) ?? "CALM",
      available: reports.ais != null,
    },
  };
}

/** The extended monitors (five Phase-12 + the NWS marine forecast + USCG broadcasts + the 2026-09-28 civic/marine expansion), by stable key. */
export type ExtendedMonitorSpec = readonly [
  source: string,
  key: MonitorKey,
  listField: string,
  url: string,
  provenance: string,
];

export const EXTENDED_MONITOR_SPECS: readonly ExtendedMonitorSpec[] = [
  ["USDM Drought", "drought", "readings", USDM_API_URL, "US Drought Monitor west-region JSON (Del Norte FIPS 06015)"],
  // PG&E's named JSON endpoint now 404s; the monitor reads the browser-rendered
  // event page. Name the endpoint actually called, so an auditor following this
  // health record is not sent to a dead URL.
  ["PG&E PSPS", "psps", "events", PGE_PSPS_PAGE_URL, "PG&E PSPS events (event page; the legacy JSON endpoint 404s)"],
  ["HRRR Smoke", "smoke", "forecasts", HMS_SMOKE_URL, "NOAA HMS smoke polygons (AirFire PM2.5 JSON is the fallback; the named AirFire URL 404s)"],
  ["Caltrans Roads", "roads", "incidents", CALTRANS_ROADS_TEXT_URL, "Caltrans per-route road conditions text (QuickMap JSON serves an SPA shell; legacy fallback)"],
  ["DUSD Schools", "schools", "events", DUSD_ALERTS_URL, "Del Norte USD announcements"],
  ["NWS Marine Forecast", "marinezone", "periods", NWS_CWF_LIST_URL, "NWS Coastal Waters Forecast text product (KEKA CWF, zone PZZ450)"],
  ["USCG Broadcast Notice to Mariners", "uscg", "items", USCG_BNM_LIST_URL, "USCG NAVCEN District 11 Broadcast Notice to Mariners listing"],
  ["Crescent City Permits Portal", "permits", "permits", MYGOV_PERMITS_URL, "City of Crescent City MyGov public portal permit catalog (module=pi); issued-permit register is login-gated and is NOT read"],
  ["Crescent City Harbor District", "dredging", "items", CCHARBOR_SITEMAP_URL, "Crescent City Harbor District sitemap.xml with a dredging / marine-construction keyword filter (no RSS exists; wp-json and /feed/ are disabled)"],
  ["EIA California Fuel", "fuel", "previousWeeks", EIA_CA_RETAIL_GAS_URL, "EIA weekly California all-grades all-formulations retail gasoline price (statewide observed average, not a station-level reading)"],
  ["PacFIN Reports Dashboard", "pacfin", "reports", PACFIN_DASHBOARD_URL, "PSMFC PacFIN APEX public report catalog (embedded tree JSON); landing figures are credential-gated and are NOT read"],
  ["AIS Vessel Traffic", "ais", "vesselsInWatchArea", DIGITRAFFIC_AIS_URL, "Open-AIS FeatureCollection feed (AIS_FEED_URL env; default keyless digitraffic) filtered to the Del Norte watch box"],
];

/**
 * The 8 core alert-monitor source names, in MONITOR_KEYS position order.
 * This is the canonical roster: the runner's health definitions and the
 * healer's tracked-monitor set must both derive from (or agree with) this
 * list, never re-declare a private copy of it.
 */
export const CORE_MONITOR_SOURCE_NAMES: readonly string[] = [
  "NOAA Tsunami",      // tsunami
  "USGS Earthquake",   // earthquake
  "NWS Weather",       // weather
  "EPA AirNow",        // airquality
  "CAL FIRE Wildfire", // wildfire
  "NDBC Marine",       // marine
  "NOAA Tides",        // tides
  "CDFW Fishing",      // fishing
] as const;

/**
 * All alert-monitor source names (8 core + 7 base extended + the five
 * 2026-09-28 expansion monitors), in MONITOR_KEYS order.
 */
export const ALERT_MONITOR_SOURCE_NAMES: readonly string[] = [
  ...CORE_MONITOR_SOURCE_NAMES.slice(0, 6), // tsunami..marine
  ...CORE_MONITOR_SOURCE_NAMES.slice(6),    // tides, fishing
  ...EXTENDED_MONITOR_SPECS.map(([source]) => source),
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
    // A FUTURE stamp is not "brand new": `isFreshReport` rejects it (ageMs < 0),
    // so the status above is `stale`, and clamping the same timestamp to 0 would
    // publish `ageMs: 0` next to `status: "stale"` — claiming fresh data that is
    // not usable. Omit the age instead and let the status carry the truth.
    if (Number.isFinite(ageMs) && ageMs >= 0) health.ageMs = ageMs;
  }
  return health;
}

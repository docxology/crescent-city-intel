/**
 * Composite alert severity scoring for Crescent City.
 * Aggregates input from all 20 alert monitors and returns a single
 * standardised composite status: CALM | WATCH | WARNING | EMERGENCY.
 *
 * Rules (applied in MONITOR_PRIORITY order, then tier; the implementation is
 * authoritative where this summary has drifted, and the two are reconciled here):
 *   EMERGENCY — active Tsunami Warning; USGS tsunami flag >= 2; a marine
 *               forecast reporting EMERGENCY (STORM WARNING / HURRICANE FORCE /
 *               sustained >= 48 kt)
 *   WARNING   — active Earthquake M>=6 within 200 km or a possible tsunami
 *               (USGS flag 1), NWS warning, tidal water level >= 7.0 ft MLLW
 *               (significant exceedance), hazardous marine conditions,
 *               wildfire evacuation orders, school closure, or an ACTIVE PSPS
 *               event affecting Del Norte
 *   WATCH     — Earthquake M4-6 within 200 km, NWS watch/advisory, CDFW fishing
 *               closure, tidal level >= 6.0 ft MLLW, elevated seas, a
 *               gale/hazardous-seas marine forecast, air quality AQI > 100,
 *               road incident or closure, school schedule change, HRRR smoke
 *               UNHEALTHY+, D0+ drought (D3/D4 reach WARNING), or a USCG
 *               Broadcast Notice to Mariners advisory (worst broadcast level ADVISORY)
 *   CALM      — no active alerts meeting the above thresholds
 *
 * Two things this block previously got wrong, both now fixed and noted in place:
 * the marine forecast's EMERGENCY tier was flattened to WARNING, and the drought
 * tiers were documented as "D3+ -> WATCH" while the code ran the opposite
 * (D3/D4 -> WARNING, D0 -> WATCH). The implemented mapping is the one above:
 * D0 is USDM's mildest category ("abnormally dry"), and holding a county at
 * WATCH for it would leave the composite permanently escalated by a condition
 * that most Del Norte residents would not call a drought, which is worse than
 * useless for a headline signal.
 *
 * Designed to be called by GET /api/monitor/alerts and the GUI dashboard.
 */

export type AlertSeverity = "CALM" | "WATCH" | "WARNING" | "EMERGENCY";

export interface AlertSeverityReport {
  /** Composite severity level */
  level: AlertSeverity;
  /** ISO-8601 timestamp of this assessment */
  assessedAt: string;
  /** One-line human-readable reason for the current level */
  reason: string;
  /** True when one or more source feeds could not be checked. */
  hasUnavailableMonitors: boolean;
  /** Optional self-healing state summary (populated by run-alerts orchestrator). */
  healer?: {
    lastCycleRun: string;
    monitorsRetried: string[];
    monitorsRecovered: string[];
    monitorsWithFailures: number;
  };
  /** Per-monitor breakdown */
  monitors: {
    tsunami: MonitorStatus;
    earthquake: MonitorStatus;
    weather: MonitorStatus;
    tides: MonitorStatus;
    fishing: MonitorStatus;
    airQuality: MonitorStatus;
    wildfire: MonitorStatus;
    marine: MonitorStatus;
    drought: MonitorStatus;
    psps: MonitorStatus;
    smoke: MonitorStatus;
    roads: MonitorStatus;
    schools: MonitorStatus;
    marinezone: MonitorStatus;
    uscg: MonitorStatus;
  };
}

export interface MonitorStatus {
  /** CALM | WATCH | WARNING | EMERGENCY */
  level: AlertSeverity;
  /** Short human-readable status */
  summary: string;
  /** Number of active alerts/events this monitor found */
  count: number;
  /** Availability is distinct from a calm reading. */
  availability?: "available" | "unavailable";
}

export interface TsunamiInput {
  /** Number of active Tsunami Warning CAP events */
  warningCount: number;
  /** Number of active Tsunami Watch/Advisory CAP events */
  watchCount: number;
  /** false when the feed could not be checked */
  available?: boolean;
}

export interface EarthquakeInput {
  /** Array of nearby earthquakes with magnitude + USGS tsunami flag */
  events: Array<{ magnitude: number; distanceKm: number; tsunami: number; place: string }>;
  /** false when the feed could not be checked */
  available?: boolean;
}

export interface WeatherInput {
  /** Active NWS severity levels for Crescent City zone */
  severities: Array<"advisory" | "watch" | "warning">;
  /** Number of active events */
  count: number;
  /** false when the feed could not be checked */
  available?: boolean;
}

export interface TidesInput {
  /** Current or most recent predicted water level in feet MLLW */
  waterLevelFt: number | null;
  /** true if tide data fetch succeeded */
  available: boolean;
}

export interface FishingInput {
  /** true if a fishery closure or conditional opening is in effect */
  closureActive: boolean;
  /** Optional closure message */
  closureMessage?: string;
  /** false when the feed could not be checked */
  available?: boolean;
}

export interface AirQualityInput {
  /** Max AQI value across all parameters (0-500) */
  maxAqi: number;
  /** Whether data was available */
  available: boolean;
}

export interface WildfireInput {
  /** Number of active incidents in Del Norte region */
  incidentCount: number;
  /** Whether any incident has active evacuation orders */
  hasEvacuationOrders: boolean;
  /** Whether any large fire (>1000 acres, <50% contained) exists nearby */
  hasLargeFireNearby: boolean;
  /** false when the feed could not be checked */
  available?: boolean;
}

export interface MarineInput {
  /** Wave height in feet at primary buoy (null if unavailable) */
  waveHeightFt: number | null;
  /** Wind speed in knots at primary buoy (null if unavailable) */
  windSpeedKt: number | null;
  /** Whether buoy data was available */
  available: boolean;
}

/** USDM Drought Monitor input. */
export interface DroughtInput {
  /** Composite drought severity (NONE, D0-D4) */
  severity: "NONE" | "D0" | "D1" | "D2" | "D3" | "D4";
  /** Percentage of county in D2-D4 (severe-extreme) */
  severeDroughtPercent: number;
  /** Whether data was available */
  available: boolean;
}

/** PG&E PSPS input. */
export interface PspsInput {
  /** Overall PSPS status */
  status: "NONE" | "MONITORED" | "PLANNED" | "ACTIVE" | "RESTORATION";
  /** Number of active events */
  eventCount: number;
  /** Whether Del Norte County is affected */
  delNorteAffected: boolean;
  /** Whether data was available */
  available: boolean;
}

/** Qualitative HMS mapped-plume input; surface exposure remains unknown. */
export interface SmokeInput {
  sourceProduct: "noaa-hms";
  density: "light" | "moderate" | "heavy" | "none" | "unknown";
  peakLevel: "UNKNOWN";
  peakAqi: null;
  maxPm25: null;
  /** Whether data was available */
  available: boolean;
}

/** Caltrans Road Closure input. */
export interface RoadClosureInput {
  /** Overall road closure severity */
  severity: "NONE" | "ADVISORY" | "WARNING" | "CLOSURE";
  /** Whether a major Del Norte route has a full closure */
  hasMajorClosure: boolean;
  /** Incident count */
  incidentCount: number;
  /** Whether data was available */
  available: boolean;
}

/** DUSD School Closure input. */
export interface SchoolClosureInput {
  /** Overall district status */
  status: "OPEN" | "DELAYED" | "EARLY_RELEASE" | "CLOSED" | "PARTIAL_CLOSURE";
  /** Whether any closure is active */
  hasActiveClosure: boolean;
  /** Whether any delay is active */
  hasActiveDelay: boolean;
  /** Event count */
  eventCount: number;
  /** Whether data was available */
  available: boolean;
}

/**
 * Assess tsunami monitor severity.
 */

function assessTsunami(input: TsunamiInput): MonitorStatus {
  if (input.available === false) {
    return { level: "CALM", summary: "Tsunami data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.warningCount > 0) {
    return {
      level: "EMERGENCY",
      summary: `\u26a0\ufe0f ${input.warningCount} active Tsunami Warning(s)`,
      count: input.warningCount + input.watchCount,
    };
  }
  if (input.watchCount > 0) {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} ${input.watchCount} active Tsunami Watch/Advisory`,
      count: input.watchCount,
    };
  }
  return { level: "CALM", summary: "No active tsunami alerts", count: 0 };
}

/**
 * Assess earthquake monitor severity.
 */
function assessEarthquake(input: EarthquakeInput): MonitorStatus {
  if (input.available === false) {
    return { level: "CALM", summary: "Earthquake data unavailable", count: 0, availability: "unavailable" };
  }
  const nearbyEvents = input.events.filter((e) => e.distanceKm <= 200);
  if (nearbyEvents.length === 0) {
    return { level: "CALM", summary: "No qualifying earthquakes nearby", count: 0 };
  }

  // USGS tsunami flag 2 = tsunami generated, 1 = possible tsunami. The monitor
  // sorts events by distance, so the array order is nearest-first and the first
  // element is not necessarily the most significant. Rank by magnitude (then
  // distance) so the headline names the worst event, not the closest one — an
  // M7.4 at 180 km was previously invisible behind an M6.3 at 50 km.
  const bySignificance = (a: typeof nearbyEvents[number], b: typeof nearbyEvents[number]): number =>
    b.magnitude - a.magnitude || a.distanceKm - b.distanceKm;
  const ranked = [...nearbyEvents].sort(bySignificance);

  // USGS tsunami flag 2 = tsunami generated
  const tsunamiEvents = ranked.filter((e) => e.tsunami >= 2);
  if (tsunamiEvents.length > 0) {
    return {
      level: "EMERGENCY",
      summary: `\u{1f6a8} Earthquake M${tsunamiEvents[0].magnitude} with tsunami generated`,
      count: nearbyEvents.length,
    };
  }

  // Flag 1 = "possible tsunami". The monitor records it as TSUNAMI_WATCH and
  // logs it at warn level; the composite used to mention tsunamis only for
  // flag >= 2, so a flagged possible tsunami produced no tsunami wording at all.
  const possibleTsunami = ranked.filter((e) => e.tsunami === 1);
  if (possibleTsunami.length > 0) {
    const top = possibleTsunami[0];
    return {
      level: "WARNING",
      summary: `\u{1f6a8} M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away — possible tsunami`,
      count: nearbyEvents.length,
    };
  }

  const severe = ranked.filter((e) => e.magnitude >= 6.0);
  if (severe.length > 0) {
    const top = severe[0];
    return {
      level: "WARNING",
      summary: `\u{1f534} M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away`,
      count: nearbyEvents.length,
    };
  }

  // M4.0-5.9 in range
  const top = ranked[0];
  return {
    level: "WATCH",
    summary: `\u{1f7e1} M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away`,
    count: nearbyEvents.length,
  };
}

/**
 * Assess NWS weather monitor severity.
 */
function assessWeather(input: WeatherInput): MonitorStatus {
  if (input.available === false) {
    return { level: "CALM", summary: "Weather data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.count === 0) {
    return { level: "CALM", summary: "No active weather alerts", count: 0 };
  }

  // The summary must count the alerts *in the tier that matched*, not every
  // active alert: `input.count` is the total, so one warning plus three
  // advisories rendered "4 active NWS Warning(s)". `count` on the returned
  // status stays the total, which is its documented meaning.
  const tierCount = (tier: string): number => input.severities.filter(s => s === tier).length;

  if (input.severities.includes("warning")) {
    const n = tierCount("warning");
    return {
      level: "WARNING",
      summary: `\u{1f534} ${n} active NWS Warning(s)`,
      count: input.count,
    };
  }
  if (input.severities.includes("watch")) {
    const n = tierCount("watch");
    return {
      level: "WATCH",
      summary: `\u{1f7e1} ${n} active NWS Watch(es)`,
      count: input.count,
    };
  }
  return {
    level: "WATCH",
    summary: `\u{1f535} ${tierCount("advisory")} active NWS Advisory(ies)`,
    count: input.count,
  };
}

/**
 * Assess NOAA tides severity based on the water level (observed, or predicted
 * max as a fallback) in feet MLLW.
 *
 * Thresholds are set ABOVE Crescent City's typical maximum high tide (~6.2 ft
 * MLLW) so a normal astronomical high tide does NOT raise the composite.
 * WATCH means the level is at/above the normal max (risk of minor coastal
 * flooding); WARNING means a genuine significant exceedance (storm surge).
 */
function assessTides(input: TidesInput): MonitorStatus {
  if (!input.available || input.waterLevelFt === null) {
    return { level: "CALM", summary: "Tides data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.waterLevelFt >= 7.0) {
    return {
      level: "WARNING",
      summary: `\u{1f534} Water level ${input.waterLevelFt.toFixed(1)} ft MLLW (significant exceedance)`,
      count: 1,
    };
  }
  if (input.waterLevelFt >= 6.0) {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} Elevated water level ${input.waterLevelFt.toFixed(1)} ft MLLW (at/above normal max high tide)`,
      count: 1,
    };
  }
  return {
    level: "CALM",
    summary: `Normal water level ${input.waterLevelFt.toFixed(1)} ft MLLW`,
    count: 0,
  };
}

/**
 * Assess CDFW fishing monitor severity.
 */
function assessFishing(input: FishingInput): MonitorStatus {
  if (input.available === false) {
    return { level: "CALM", summary: "Fishing data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.closureActive) {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} Fishery closure in effect${input.closureMessage ? ": " + input.closureMessage : ""}`,
      count: 1,
    };
  }
  return { level: "CALM", summary: "No active fishery closures", count: 0 };
}

/**
 * Assess EPA air quality monitor severity.
 */
function assessAirQuality(input: AirQualityInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Air quality data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.maxAqi > 200) {
    return {
      level: "WARNING",
      summary: `\u{1f534} Air quality AQI ${input.maxAqi} (Very Unhealthy)`,
      count: 1,
    };
  }
  if (input.maxAqi > 100) {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} Air quality AQI ${input.maxAqi} (Unhealthy for Sensitive Groups)`,
      count: 1,
    };
  }
  return {
    level: "CALM",
    summary: `Air quality AQI ${input.maxAqi} (Good/Moderate)`,
    count: 0,
  };
}

/**
 * Assess CAL FIRE wildfire monitor severity.
 */
function assessWildfire(input: WildfireInput): MonitorStatus {
  if (input.available === false) {
    return { level: "CALM", summary: "Wildfire data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.incidentCount === 0) {
    return { level: "CALM", summary: "No active wildfires in region", count: 0 };
  }
  if (input.hasEvacuationOrders) {
    return {
      level: "EMERGENCY",
      summary: `\u{1f6a8} Wildfire evacuation orders active (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  if (input.hasLargeFireNearby) {
    return {
      level: "WARNING",
      summary: `\u{1f534} Large active wildfire nearby (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  return {
    level: "WATCH",
    summary: `\u{1f7e1} ${input.incidentCount} active wildfire(s) in region`,
    count: input.incidentCount,
  };
}

/**
 * Assess NDBC marine weather monitor severity.
 */
function assessMarine(input: MarineInput): MonitorStatus {
  if (!input.available || (input.waveHeightFt === null && input.windSpeedKt === null)) {
    return { level: "CALM", summary: "Marine buoy data unavailable", count: 0, availability: "unavailable" };
  }
  if ((input.waveHeightFt ?? 0) >= 15 || (input.windSpeedKt ?? 0) >= 34) {
    return {
      level: "WARNING",
      summary: `\u{1f534} Hazardous marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "\u2014"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "\u2014"}kt wind`,
      count: 1,
    };
  }
  if ((input.waveHeightFt ?? 0) >= 10 || (input.windSpeedKt ?? 0) >= 22) {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} Elevated marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "\u2014"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "\u2014"}kt wind`,
      count: 1,
    };
  }
  return {
    level: "CALM",
    summary: `Normal marine conditions: ${(() => {
        // Data honesty: omit missing readings instead of publishing em-dash
        // placeholder glyphs in the public composite summary.
        const parts = [
          input.waveHeightFt != null ? `${input.waveHeightFt.toFixed(1)}ft waves` : null,
          input.windSpeedKt != null ? `${input.windSpeedKt.toFixed(0)}kt wind` : null,
        ].filter((value): value is string => value !== null);
        return parts.length > 0 ? parts.join(", ") : "no wave or wind reading recorded";
      })()}`,
    count: 0,
  };
}

// ─── New monitors (v2.5+) ──────────────────────────────────────────

/**
 * Assess USDM drought monitor severity.
 */
function assessDrought(input: DroughtInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Drought data unavailable", count: 0, availability: "unavailable" };
  }
  const scores: Record<string, number> = { NONE: 0, D0: 1, D1: 2, D2: 3, D3: 4, D4: 5 };
  if (scores[input.severity] >= 4) {
    return {
      level: "WARNING",
      summary: `\u{1f534} Extreme drought (${input.severity}): ${input.severeDroughtPercent.toFixed(1)}% severe-extreme`,
      count: 1,
    };
  }
  if (scores[input.severity] >= 3) {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} Severe drought (${input.severity}): ${input.severeDroughtPercent.toFixed(1)}% D2-D4`,
      count: 1,
    };
  }
  if (scores[input.severity] >= 1) {
    return {
      level: "WATCH",
      summary: `\u{1f535} Dry conditions (${input.severity})`,
      count: 1,
    };
  }
  return { level: "CALM", summary: "No drought conditions", count: 0 };
}

/**
 * Assess PG&E PSPS monitor severity.
 */
function assessPsps(input: PspsInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "PSPS data unavailable", count: 0, availability: "unavailable" };
  }
  // Both conditions are required, and `delNorteAffected` is derived from the
  // event page's county list. If PG&E's page stops naming counties, this branch
  // is unreachable and an ACTIVE PSPS falls to the WATCH branch below, which
  // renders as "0 event(s) (regionally)" — a mis-report rather than a gap, so
  // the region-wide branch reports the real count.
  if (input.delNorteAffected && input.status === "ACTIVE") {
    return {
      level: "WARNING",
      summary: `\u{1f534} Active PSPS in Del Norte County (${input.eventCount} event(s))`,
      count: input.eventCount,
    };
  }
  if (input.status === "PLANNED" || input.status === "ACTIVE") {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} PSPS ${input.status}: ${input.eventCount} event(s) (${input.delNorteAffected ? "Del Norte affected" : "regionally"})`,
      count: input.eventCount,
    };
  }
  if (input.status === "MONITORED" || input.status === "RESTORATION") {
    return {
      level: "WATCH",
      summary: `\u{1f535} PSPS ${input.status}: ${input.eventCount} event(s) monitored`,
      count: input.eventCount,
    };
  }
  return { level: "CALM", summary: "No PSPS events", count: 0 };
}

/**
 * Assess a mapped HMS plume without inferring numeric surface air quality.
 */
function assessSmoke(input: SmokeInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "HMS smoke-map data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.sourceProduct === "noaa-hms") {
    if (!input.density || input.density === "unknown") return { level: "CALM", summary: "HMS plume density unknown", count: 0, availability: "unavailable" };
    return { level: input.density === "none" ? "CALM" : "WATCH",
      summary: input.density === "none" ? "No mapped HMS plume; surface air quality not measured"
        : `HMS ${input.density}-density mapped plume; surface PM2.5/AQI unknown`, count: input.density === "none" ? 0 : 1 };
  }
  return { level: "CALM", summary: "Unsupported smoke evidence; surface air quality unknown", count: 0, availability: "unavailable" };
}

/**
 * Assess Caltrans road closure severity.
 */
function assessRoads(input: RoadClosureInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Road closure data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.incidentCount === 0) {
    return { level: "CALM", summary: "No road incidents on Del Norte routes", count: 0 };
  }
  if (input.hasMajorClosure) {
    return {
      level: "WARNING",
      summary: `\u{1f534} Major road closure active on Del Norte route (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  if (input.severity === "WARNING") {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} Road hazard warning: ${input.incidentCount} incident(s)`,
      count: input.incidentCount,
    };
  }
  return {
    level: "WATCH",
    summary: `\u{1f535} Road advisory: ${input.incidentCount} incident(s)`,
    count: input.incidentCount,
  };
}

/**
 * Assess DUSD school closure severity.
 */
function assessSchools(input: SchoolClosureInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "School closure data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.eventCount === 0) {
    return { level: "CALM", summary: "No school closures or delays", count: 0 };
  }
  if (input.hasActiveClosure) {
    return {
      level: "WARNING",
      summary: `\u{1f534} School closure active (${input.status}): ${input.eventCount} event(s)`,
      count: input.eventCount,
    };
  }
  if (input.hasActiveDelay || input.status !== "OPEN") {
    return {
      level: "WATCH",
      summary: `\u{1f7e1} School schedule change (${input.status}): ${input.eventCount} event(s)`,
      count: input.eventCount,
    };
  }
  return { level: "CALM", summary: "No school closures", count: 0 };
}

/** Priority ordering for severity levels */
const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  CALM: 0,
  WATCH: 1,
  WARNING: 2,
  EMERGENCY: 3,
};

/**
 * Hazard priority for choosing the single headline `reason`, most urgent first.
 * Two monitors at the same tier must not be decided by object-literal order:
 * the operator-visible one-liner is the only summary on the dashboard, so a
 * school closure losing the slot to a long-running drought was a real
 * mis-report. Immediate life-safety and same-day-disruption sources lead;
 * chronic background conditions (drought, air quality, tides) come last
 * because they are the ones most likely to sit at WARNING for weeks.
 *
 * Unlike the rosters, this list is NOT derived from `MONITOR_KEYS` and cannot
 * be: the order encodes a judgement about consequence, which no mechanical
 * derivation carries. What IS mechanical is the invariant it must satisfy —
 * every monitor appears exactly once — so it is exported and
 * `tests/alert-source-roster.test.ts` asserts coverage. That converts "somebody
 * remember to append the new monitor here" from a silent behaviour change (an
 * unlisted monitor sorts last, which is usually benign but is never deliberate)
 * into a test failure.
 */
export const MONITOR_PRIORITY: readonly string[] = [
  "tsunami",      // highest consequence, rare
  "earthquake",   // sudden, life-safety
  "wildfire",     // evacuation orders
  "weather",      // NWS warnings/watches
  "marinezone",   // gale/storm warning forecast for the nearshore zone
  "roads",        // US-101 closure — the region's one artery
  "schools",      // same-day civic impact
  "psps",         // power loss
  "marine",       // buoy conditions
  "tides",        // chronic, but flood-relevant at the extremes
  "smoke",        // air quality
  "fishing",      // seasonal economic impact
  "airQuality",   // NB: camelCase — see SEVERITY_MONITOR_KEYS
  "drought",      // multi-year background state
  "uscg",         // Broadcast Notice to Mariners; advisory-class at most
  "permits",      // civic permitting news; advisory-class
  "dredging",     // harbor marine-construction news; advisory-class
  "fuel",         // statewide retail price; economic background
  "pacfin",       // fisheries catalog; advisory-class
  "ais",          // vessel traffic; advisory-class
];

/**
 * The keys of the `monitors` record, which is the vocabulary the priority
 * lookup actually receives.
 *
 * Exported so `tests/alert-source-roster.test.ts` can assert the priority list
 * against the consumer rather than against `MONITOR_KEYS`. They are NOT the
 * same vocabulary: `MONITOR_KEYS` says `airquality` and this record says
 * `airQuality`, because the composite input field is camelCase while every
 * monitor key, history directory and health-record name is lowercase. The two
 * spellings have always agreed in practice, so the mismatch was invisible —
 * but a priority list written against either vocabulary silently demotes air
 * quality to LAST rank, which is a behaviour change nobody would notice in
 * review. Naming the mismatch here is what makes it a checkable fact.
 */
export const SEVERITY_MONITOR_KEYS: readonly string[] = [
  "tsunami", "earthquake", "weather", "tides", "fishing", "airQuality", "wildfire",
  "marine", "drought", "psps", "smoke", "roads", "schools", "marinezone", "uscg",
  "permits", "dredging", "fuel", "pacfin", "ais",
];

/** Rank of a monitor in `MONITOR_PRIORITY`; unknown names sort last. */
export function priorityRank(name: string): number {
  const index = MONITOR_PRIORITY.indexOf(name);
  return index === -1 ? MONITOR_PRIORITY.length : index;
}

/**
 * Marine zone forecast input (NWS CWF PZZ450, src/alerts/nws_marine.ts).
 */
export interface MarineZoneInput {
  /** Worst CWF period level: CALM | WATCH | ADVISORY | WARNING | EMERGENCY */
  worstLevel: string;
  /** Highest forecast wind across periods (kt). */
  peakWindKt: number | null;
  available: boolean;
}

/**
 * Assess the NWS Coastal Waters Forecast for the Crescent City nearshore zone.
 * The monitor's own level mapping (gale >= 34 kt, small-craft >= 21 kt) is
 * authoritative; this assessment guards the unavailable state and normalizes
 * unknown levels to a visible WATCH rather than a fake CALM.
 */
function assessMarineZone(input: MarineZoneInput): MonitorStatus {
  if (!input.available) {
    return {
      level: "CALM",
      summary: "Marine forecast unavailable",
      count: 0,
      availability: "unavailable",
    };
  }
  const level = input.worstLevel;
  const wind = input.peakWindKt !== null ? `peak wind ${input.peakWindKt} kt` : "peak wind unknown";
  if (level === "EMERGENCY") {
    // Pass the top tier through. `classifyMarineForecastPeriod` returns
    // EMERGENCY for STORM WARNING, HURRICANE FORCE, or sustained >= 48 kt —
    // the strongest nearshore condition this system can detect — and the
    // comment above this branch claimed the monitor's own mapping was
    // "authoritative" while flattening that one tier. A hurricane-force
    // forecast read as WARNING. Tsunami and wildfire both reach EMERGENCY, so
    // this was the only real EMERGENCY being silently dropped.
    return { level: "EMERGENCY", summary: `\u{1f6a8} Marine forecast ${level} (${wind})`, count: 1 };
  }
  if (level === "WARNING") {
    return { level: "WARNING", summary: `\u{1f534} Marine forecast ${level} (${wind})`, count: 1 };
  }
  if (level === "ADVISORY" || level === "WATCH") {
    return { level: "WATCH", summary: `\u{1f7e1} Marine forecast ${level} (${wind})`, count: 1 };
  }
  if (level === "CALM") {
    return { level: "CALM", summary: `Marine forecast calm (${wind})`, count: 0 };
  }
  // Unknown level string: visible WATCH, never a fabricated CALM.
  return { level: "WATCH", summary: `Marine forecast level "${level}" unrecognized — treat as elevated`, count: 1 };
}

/**
 * USCG Broadcast Notice to Mariners input (src/alerts/uscg_broadcasts.ts).
 * The monitor's two-level scale (classifyUscgBroadcast) is authoritative:
 * hazard/closure/ATON traffic → ADVISORY, housekeeping → CALM.
 */
export interface UscgBroadcastInput {
  /** Worst classified broadcast level across relevant BNMs: CALM | ADVISORY. */
  worstLevel: string;
  /** Broadcasts scanned in the run window. */
  totalBroadcasts: number;
  /** North-coast-relevant broadcasts behind the worst level. */
  relevantCount: number;
  available: boolean;
}

/**
 * Assess the USCG Broadcast Notice to Mariners monitor. BNM traffic is
 * informational, so its worst ADVISORY broadcast maps onto the composite's
 * advisory-class WATCH exactly like the other advisory-class inputs (NWS
 * advisories, marinezone ADVISORY); unknown levels surface as a visible WATCH
 * rather than a fabricated CALM.
 *
 * Capped at WATCH by design, which is why "uscg" sits last in `MONITOR_PRIORITY`:
 * it should never take the headline slot from a monitor that can reach WARNING.
 */
function assessUscg(input: UscgBroadcastInput): MonitorStatus {
  if (!input.available) {
    return {
      level: "CALM",
      summary: "USCG broadcast data unavailable",
      count: 0,
      availability: "unavailable",
    };
  }
  const level = input.worstLevel;
  const scope = input.totalBroadcasts > 0 ? `${input.totalBroadcasts} broadcast(s) scanned` : "no broadcasts scanned";
  if (level === "ADVISORY") {
    return { level: "WATCH", summary: `\u{1f7e1} USCG broadcast advisory (${input.relevantCount} relevant, ${scope})`, count: input.relevantCount };
  }
  if (level === "CALM") {
    return { level: "CALM", summary: `No active USCG broadcasts (${scope})`, count: 0 };
  }
  // Unknown level string: visible WATCH, never a fabricated CALM.
  return { level: "WATCH", summary: `USCG broadcast level "${level}" unrecognized — treat as elevated`, count: input.relevantCount };
}

/**
 * City permit-portal input (src/alerts/permits.ts). The MyGov public catalog
 * is informational: catalog changes surface as a visible WATCH, an unchanged
 * catalog is CALM with the catalog size as scope.
 */
export interface PermitsInput {
  /** Worst classified catalog state: CALM | ADVISORY. */
  worstLevel: string;
  /** Published permit application types on the public portal. */
  catalogSize: number;
  /** New or edited permit types behind the worst level. */
  changeCount: number;
  available: boolean;
}

function assessPermits(input: PermitsInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Permit portal data unavailable", count: 0, availability: "unavailable" };
  }
  const scope = input.catalogSize > 0 ? `${input.catalogSize} permit type(s) published` : "no permit types published";
  if (input.worstLevel === "ADVISORY") {
    return { level: "WATCH", summary: `\u{1f7e1} Permit catalog changes (${input.changeCount} changed, ${scope})`, count: input.changeCount };
  }
  if (input.worstLevel === "CALM") {
    return { level: "CALM", summary: `Permit catalog unchanged (${scope})`, count: 0 };
  }
  return { level: "WATCH", summary: `Permit portal level "${input.worstLevel}" unrecognized — treat as elevated`, count: input.changeCount };
}

/**
 * Harbor dredging input (src/alerts/dredging.ts). Marine-construction posts
 * on the harbor's public sitemap are advisory-class.
 */
export interface DredgingInput {
  /** Worst classified harbor-post state: CALM | ADVISORY. */
  worstLevel: string;
  /** Sitemap URLs scanned. */
  totalUrls: number;
  /** In-window dredging / marine-construction posts behind the worst level. */
  relevantCount: number;
  available: boolean;
}

function assessDredging(input: DredgingInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Harbor dredging data unavailable", count: 0, availability: "unavailable" };
  }
  const scope = input.totalUrls > 0 ? `${input.totalUrls} harbor URLs scanned` : "no harbor URLs scanned";
  if (input.worstLevel === "ADVISORY") {
    return { level: "WATCH", summary: `\u{1f7e1} Harbor marine-work posts (${input.relevantCount} relevant, ${scope})`, count: input.relevantCount };
  }
  if (input.worstLevel === "CALM") {
    return { level: "CALM", summary: `No harbor marine-work posts (${scope})`, count: 0 };
  }
  return { level: "WATCH", summary: `Harbor dredging level "${input.worstLevel}" unrecognized — treat as elevated`, count: input.relevantCount };
}

/**
 * Fuel-price input (src/alerts/fuel.ts). The observed statewide weekly
 * average is advisory-class; only a spike above the monitor's own band
 * raises it. A missing observed week is a gap, never a fabricated price.
 */
export interface FuelInput {
  /** Worst classified price state: CALM | ADVISORY. */
  worstLevel: string;
  /** Latest OBSERVED weekly price ($/gal), or null when the feed carried none. */
  latestPrice: number | null;
  /** Latest vs trailing median, as a fraction. */
  deltaVsMedian: number | null;
  available: boolean;
}

function assessFuel(input: FuelInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Fuel price data unavailable", count: 0, availability: "unavailable" };
  }
  const price = input.latestPrice !== null ? `$${input.latestPrice.toFixed(2)}/gal` : "no observed week";
  const delta = input.deltaVsMedian !== null ? ` (${input.deltaVsMedian >= 0 ? "+" : ""}${(input.deltaVsMedian * 100).toFixed(1)}% vs median)` : "";
  if (input.worstLevel === "ADVISORY") {
    return { level: "WATCH", summary: `\u{1f7e1} Fuel price spike ${price}${delta}`, count: 1 };
  }
  if (input.worstLevel === "CALM") {
    return { level: "CALM", summary: `Fuel price nominal: ${price}${delta}`, count: 0 };
  }
  return { level: "WATCH", summary: `Fuel level "${input.worstLevel}" unrecognized — treat as elevated`, count: 1 };
}

/**
 * PacFIN input (src/alerts/pacfin.ts). The public report catalog is
 * informational; landing figures are credential-gated and never read.
 */
export interface PacfinInput {
  /** Worst classified catalog state: CALM | ADVISORY. */
  worstLevel: string;
  /** Public reports in the catalog. */
  reportCount: number;
  /** New or edited public reports behind the worst level. */
  changeCount: number;
  /** False until a credentialed connector reads landing figures. */
  landingDataAvailable: boolean;
  available: boolean;
}

function assessPacfin(input: PacfinInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "PacFIN catalog data unavailable", count: 0, availability: "unavailable" };
  }
  const gate = input.landingDataAvailable ? "" : "; landings credential-gated";
  const scope = input.reportCount > 0 ? `${input.reportCount} public report(s)${gate}` : `no public reports${gate}`;
  if (input.worstLevel === "ADVISORY") {
    return { level: "WATCH", summary: `\u{1f7e1} PacFIN catalog changes (${input.changeCount} changed, ${scope})`, count: input.changeCount };
  }
  if (input.worstLevel === "CALM") {
    return { level: "CALM", summary: `PacFIN catalog unchanged (${scope})`, count: 0 };
  }
  return { level: "WATCH", summary: `PacFIN level "${input.worstLevel}" unrecognized — treat as elevated`, count: input.changeCount };
}

/**
 * AIS vessel-traffic input (src/alerts/ais.ts). Vessels inside the Del Norte
 * watch box are advisory-class context; an empty box is a calm day, not an
 * outage, and the feed's coverage scope is carried in the monitor itself.
 */
export interface AisInput {
  /** Worst classified vessel state: CALM | ADVISORY. */
  worstLevel: string;
  /** Vessels in the upstream feed this run. */
  vesselsObserved: number;
  /** Vessels inside the Del Norte watch box behind the worst level. */
  vesselsInWatchArea: number;
  available: boolean;
}

function assessAis(input: AisInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "AIS vessel data unavailable", count: 0, availability: "unavailable" };
  }
  const scope = `${input.vesselsObserved} vessel(s) in feed`;
  if (input.worstLevel === "ADVISORY") {
    return { level: "WATCH", summary: `\u{1f7e1} AIS traffic in the watch box (${input.vesselsInWatchArea} vessel(s), ${scope})`, count: input.vesselsInWatchArea };
  }
  if (input.worstLevel === "CALM") {
    return { level: "CALM", summary: `No AIS vessels in the watch box (${scope})`, count: 0 };
  }
  return { level: "WATCH", summary: `AIS level "${input.worstLevel}" unrecognized — treat as elevated`, count: input.vesselsInWatchArea };
}

/**
 * Compute composite alert severity from all 20 monitor inputs.
 *
 * @returns AlertSeverityReport with composite level and per-monitor breakdown.
 */
export function computeAlertSeverity(
  tsunami: TsunamiInput,
  earthquake: EarthquakeInput,
  weather: WeatherInput,
  tides: TidesInput,
  fishing: FishingInput,
  airQuality: AirQualityInput = { maxAqi: 0, available: false },
  wildfire: WildfireInput = { incidentCount: 0, hasEvacuationOrders: false, hasLargeFireNearby: false },
  marine: MarineInput = { waveHeightFt: null, windSpeedKt: null, available: false },
  drought: DroughtInput = { severity: "NONE", severeDroughtPercent: 0, available: false },
  psps: PspsInput = { status: "NONE", eventCount: 0, delNorteAffected: false, available: false },
  smoke: SmokeInput = { sourceProduct: "noaa-hms", density: "unknown", peakLevel: "UNKNOWN", peakAqi: null, maxPm25: null, available: false },
  roads: RoadClosureInput = { severity: "NONE", hasMajorClosure: false, incidentCount: 0, available: false },
  schools: SchoolClosureInput = { status: "OPEN", hasActiveClosure: false, hasActiveDelay: false, eventCount: 0, available: false },
  marinezone: MarineZoneInput = { worstLevel: "CALM", peakWindKt: null, available: false },
  uscg: UscgBroadcastInput = { worstLevel: "CALM", totalBroadcasts: 0, relevantCount: 0, available: false },
  permits: PermitsInput = { worstLevel: "CALM", catalogSize: 0, changeCount: 0, available: false },
  dredging: DredgingInput = { worstLevel: "CALM", totalUrls: 0, relevantCount: 0, available: false },
  fuel: FuelInput = { worstLevel: "CALM", latestPrice: null, deltaVsMedian: null, available: false },
  pacfin: PacfinInput = { worstLevel: "CALM", reportCount: 0, changeCount: 0, landingDataAvailable: false, available: false },
  ais: AisInput = { worstLevel: "CALM", vesselsObserved: 0, vesselsInWatchArea: 0, available: false },
): AlertSeverityReport {
  const monitors = {
    tsunami: assessTsunami(tsunami),
    earthquake: assessEarthquake(earthquake),
    weather: assessWeather(weather),
    tides: assessTides(tides),
    fishing: assessFishing(fishing),
    airQuality: assessAirQuality(airQuality),
    wildfire: assessWildfire(wildfire),
    marine: assessMarine(marine),
    drought: assessDrought(drought),
    psps: assessPsps(psps),
    smoke: assessSmoke(smoke),
    roads: assessRoads(roads),
    schools: assessSchools(schools),
    marinezone: assessMarineZone(marinezone),
    uscg: assessUscg(uscg),
    permits: assessPermits(permits),
    dredging: assessDredging(dredging),
    fuel: assessFuel(fuel),
    pacfin: assessPacfin(pacfin),
    ais: assessAis(ais),
  };

  // Find the highest severity across all monitors.
  //
  // Ties are broken by hazard priority, not by the order the `monitors` literal
  // happens to be written in. A strict `>` let the first-declared key win, so a
  // chronic drought WARNING outranked an active PSPS WARNING or a school
  // closure for the single front-page reason line, purely because `drought` is
  // declared before `psps`/`schools`. MONITOR_PRIORITY is ordered
  // emergency-first and matches the "applied in priority order" the module
  // header claims.
  let topLevel: AlertSeverity = "CALM";
  let topReason = "All systems nominal";
  let topPriority = Number.POSITIVE_INFINITY;

  for (const [name, status] of Object.entries(monitors)) {
    const level = SEVERITY_ORDER[status.level];
    const rank = priorityRank(name);
    if (level > SEVERITY_ORDER[topLevel] || (level === SEVERITY_ORDER[topLevel] && level > 0 && rank < topPriority)) {
      topLevel = status.level;
      topReason = `${name.charAt(0).toUpperCase() + name.slice(1)}: ${status.summary}`;
      topPriority = rank;
    }
  }

  const unavailable = Object.entries(monitors)
    .filter(([, status]) => status.availability === "unavailable")
    .map(([name]) => name);
  if (topLevel === "CALM" && unavailable.length > 0) {
    topReason = `Data unavailable: ${unavailable.join(", ")}`;
  }

  return {
    level: topLevel,
    assessedAt: new Date().toISOString(),
    reason: topReason,
    hasUnavailableMonitors: unavailable.length > 0,
    monitors,
  };
}

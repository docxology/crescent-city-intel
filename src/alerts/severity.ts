/**
 * Composite alert severity scoring for Crescent City.
 *
 * Aggregates input from all 13 alert monitors and returns a single
 * standardised composite status: CALM | WATCH | WARNING | EMERGENCY.
 *
 * Rules (applied in priority order):
 *   EMERGENCY — any active Tsunami Warning (CAP) or USGS tsunami flag >= 2
 *   WARNING   — active Earthquake M>=6 within 200 km, NWS Severe weather warning,
 *               tidal water level >= 7.0 ft MLLW (significant exceedance), gale-force winds,
 *               wildfire evac orders, or active PSPS event in Del Norte
 *   WATCH     — Earthquake M4-6 within 200 km, NWS watch/advisory,
 *               CDFW fishing closure, tidal level >= 6.0 ft MLLW (at/above the typical max high tide),
 *               elevated seas, D3+ drought, air quality AQI > 100, road closure,
 *               school closure, or HRRR smoke UNHEALTHY+
 *   CALM      — no active alerts meeting above thresholds
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

/** HRRR Smoke Forecast input. */
export interface SmokeInput {
  /** Peak PM2.5 smoke level */
  peakLevel: "GOOD" | "MODERATE" | "UNHEALTHY_SENSITIVE" | "UNHEALTHY" | "VERY_UNHEALTHY" | "HAZARDOUS";
  /** Peak AQI equivalent */
  peakAqi: number | null;
  /** Max PM2.5 forecast value */
  maxPm25: number | null;
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


export interface DroughtInput {
  /** D0-D4 drought category for Del Norte County (0-4, -1 if unavailable) */
  category: number;
  /** Percentage of Del Norte County in that category */
  percentage: number;
  /** Whether data was available */
  available: boolean;
}

export interface PSPSInput {
  /** Whether a PSPS event is active for Del Norte County */
  active: boolean;
  /** Optional PSPS description */
  description?: string;
  /** Whether data was available */
  available: boolean;
}

export interface SmokeInput {
  /** PM2.5 concentration in μg/m³ (null if unavailable) */
  pm25: number | null;
  /** Whether smoke forecast data was available */
  available: boolean;
}

export interface RoadClosureInput {
  /** Number of active road closures on Del Norte routes */
  closureCount: number;
  /** Whether data was available */
  available: boolean;
}

export interface SchoolClosureInput {
  /** Whether DUSD schools are closed */
  closed: boolean;
  /** Optional reason for closure */
  reason?: string;
  /** Whether data was available */
  available: boolean;
}

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
      summary: `\U0001f7e1 ${input.watchCount} active Tsunami Watch/Advisory`,
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

  // USGS tsunami flag 2 = tsunami generated
  const tsunamiEvents = nearbyEvents.filter((e) => e.tsunami >= 2);
  if (tsunamiEvents.length > 0) {
    return {
      level: "EMERGENCY",
      summary: `\U0001f6a8 Earthquake M${tsunamiEvents[0].magnitude} with tsunami generated`,
      count: nearbyEvents.length,
    };
  }

  const severe = nearbyEvents.filter((e) => e.magnitude >= 6.0);
  if (severe.length > 0) {
    const top = severe[0];
    return {
      level: "WARNING",
      summary: `\U0001f534 M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away`,
      count: nearbyEvents.length,
    };
  }

  // M4.0-5.9 in range
  const top = nearbyEvents[0];
  return {
    level: "WATCH",
    summary: `\U0001f7e1 M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away`,
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

  if (input.severities.includes("warning")) {
    return {
      level: "WARNING",
      summary: `\U0001f534 ${input.count} active NWS Warning(s)`,
      count: input.count,
    };
  }
  if (input.severities.includes("watch")) {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 ${input.count} active NWS Watch(es)`,
      count: input.count,
    };
  }
  return {
    level: "WATCH",
    summary: `\U0001f535 ${input.count} active NWS Advisory(ies)`,
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
      summary: `\U0001f534 Water level ${input.waterLevelFt.toFixed(1)} ft MLLW (significant exceedance)`,
      count: 1,
    };
  }
  if (input.waterLevelFt >= 6.0) {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 Elevated water level ${input.waterLevelFt.toFixed(1)} ft MLLW (at/above normal max high tide)`,
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
      summary: `\U0001f7e1 Fishery closure in effect${input.closureMessage ? ": " + input.closureMessage : ""}`,
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
      summary: `\U0001f534 Air quality AQI ${input.maxAqi} (Very Unhealthy)`,
      count: 1,
    };
  }
  if (input.maxAqi > 100) {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 Air quality AQI ${input.maxAqi} (Unhealthy for Sensitive Groups)`,
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
      summary: `\U0001f6a8 Wildfire evacuation orders active (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  if (input.hasLargeFireNearby) {
    return {
      level: "WARNING",
      summary: `\U0001f534 Large active wildfire nearby (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  return {
    level: "WATCH",
    summary: `\U0001f7e1 ${input.incidentCount} active wildfire(s) in region`,
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
      summary: `\U0001f534 Hazardous marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "\u2014"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "\u2014"}kt wind`,
      count: 1,
    };
  }
  if ((input.waveHeightFt ?? 0) >= 10 || (input.windSpeedKt ?? 0) >= 22) {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 Elevated marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "\u2014"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "\u2014"}kt wind`,
      count: 1,
    };
  }
  return {
    level: "CALM",
    summary: `Normal marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "\u2014"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "\u2014"}kt wind`,
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
      summary: `\U0001f534 Extreme drought (${input.severity}): ${input.severeDroughtPercent.toFixed(1)}% severe-extreme`,
      count: 1,
    };
  }
  if (scores[input.severity] >= 3) {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 Severe drought (${input.severity}): ${input.severeDroughtPercent.toFixed(1)}% D2-D4`,
      count: 1,
    };
  }
  if (scores[input.severity] >= 1) {
    return {
      level: "WATCH",
      summary: `\U0001f535 Dry conditions (${input.severity})`,
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
  if (input.delNorteAffected && input.status === "ACTIVE") {
    return {
      level: "WARNING",
      summary: `\U0001f534 Active PSPS in Del Norte County (${input.eventCount} event(s))`,
      count: input.eventCount,
    };
  }
  if (input.status === "PLANNED" || input.status === "ACTIVE") {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 PSPS ${input.status}: ${input.eventCount} event(s) (${input.delNorteAffected ? "Del Norte affected" : "regionally"})`,
      count: input.eventCount,
    };
  }
  if (input.status === "MONITORED" || input.status === "RESTORATION") {
    return {
      level: "WATCH",
      summary: `\U0001f535 PSPS ${input.status}: ${input.eventCount} event(s) monitored`,
      count: input.eventCount,
    };
  }
  return { level: "CALM", summary: "No PSPS events", count: 0 };
}

/**
 * Assess HRRR smoke forecast severity.
 */
function assessSmoke(input: SmokeInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Smoke forecast data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.peakLevel === "HAZARDOUS" || input.peakLevel === "VERY_UNHEALTHY") {
    return {
      level: "WARNING",
      summary: `\U0001f534 Smoke ${input.peakLevel}: PM2.5 ${input.maxPm25?.toFixed(1) ?? "N/A"} ug/m3`,
      count: 1,
    };
  }
  if (input.peakLevel === "UNHEALTHY" || input.peakLevel === "UNHEALTHY_SENSITIVE") {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 Smoke ${input.peakLevel}: PM2.5 ${input.maxPm25?.toFixed(1) ?? "N/A"} ug/m3`,
      count: 1,
    };
  }
  return { level: "CALM", summary: "Smoke forecast: Good/Moderate air quality", count: 0 };
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
      summary: `\U0001f534 Major road closure active on Del Norte route (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  if (input.severity === "WARNING") {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 Road hazard warning: ${input.incidentCount} incident(s)`,
      count: input.incidentCount,
    };
  }
  return {
    level: "WATCH",
    summary: `\U0001f535 Road advisory: ${input.incidentCount} incident(s)`,
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
      summary: `\U0001f534 School closure active (${input.status}): ${input.eventCount} event(s)`,
      count: input.eventCount,
    };
  }
  if (input.hasActiveDelay || input.status !== "OPEN") {
    return {
      level: "WATCH",
      summary: `\U0001f7e1 School schedule change (${input.status}): ${input.eventCount} event(s)`,
      count: input.eventCount,
    };
  }
  return { level: "CALM", summary: "No school closures", count: 0 };
}


/**
 * Assess USDM drought monitor severity.
 */
function assessDrought(input: DroughtInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Drought data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.category >= 3) {
    return { level: "WARNING", summary: `🔴 Drought D${input.category} (${input.percentage}% of county)`, count: 1 };
  }
  if (input.category >= 2) {
    return { level: "WATCH", summary: `🟡 Drought D${input.category} (${input.percentage}% of county)`, count: 1 };
  }
  return { level: "CALM", summary: `No significant drought (D${input.category})`, count: 0 };
}

/**
 * Assess PG&E PSPS monitor severity.
 */
function assessPSPS(input: PSPSInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "PSPS data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.active) {
    return { level: "WARNING", summary: `🔴 PG&E PSPS active${input.description ? ": " + input.description : ""}`, count: 1 };
  }
  return { level: "CALM", summary: "No active PSPS event", count: 0 };
}

/**
 * Assess HRRR smoke forecast monitor severity.
 */
function assessSmoke(input: SmokeInput): MonitorStatus {
  if (!input.available || input.pm25 === null) {
    return { level: "CALM", summary: "Smoke forecast data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.pm25 > 150) {
    return { level: "WARNING", summary: `🔴 Unhealthy smoke PM2.5 ${input.pm25} μg/m³`, count: 1 };
  }
  if (input.pm25 > 55) {
    return { level: "WATCH", summary: `🟡 Elevated smoke PM2.5 ${input.pm25} μg/m³`, count: 1 };
  }
  return { level: "CALM", summary: `Normal air quality (PM2.5 ${input.pm25} μg/m³)`, count: 0 };
}

/**
 * Assess Caltrans road closure monitor severity.
 */
function assessRoadClosure(input: RoadClosureInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "Road closure data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.closureCount > 0) {
    return { level: "WARNING", summary: `🔴 ${input.closureCount} road closure(s) on Del Norte routes`, count: input.closureCount };
  }
  return { level: "CALM", summary: "No active road closures on major routes", count: 0 };
}

/**
 * Assess DUSD school closure monitor severity.
 */
function assessSchoolClosure(input: SchoolClosureInput): MonitorStatus {
  if (!input.available) {
    return { level: "CALM", summary: "School closure data unavailable", count: 0, availability: "unavailable" };
  }
  if (input.closed) {
    return { level: "WATCH", summary: `🟡 DUSD schools closed${input.reason ? ": " + input.reason : ""}`, count: 1 };
  }
  return { level: "CALM", summary: "DUSD schools operating normally", count: 0 };
}

/** Priority ordering for severity levels */
const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  CALM: 0,
  WATCH: 1,
  WARNING: 2,
  EMERGENCY: 3,
};

/**
 * Compute composite alert severity from all 13 monitor inputs.
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
  smoke: SmokeInput = { peakLevel: "GOOD", peakAqi: null, maxPm25: null, available: false },
  roads: RoadClosureInput = { severity: "NONE", hasMajorClosure: false, incidentCount: 0, available: false },
  schools: SchoolClosureInput = { status: "OPEN", hasActiveClosure: false, hasActiveDelay: false, eventCount: 0, available: false },
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
  };

  // Find the highest severity across all monitors
  let topLevel: AlertSeverity = "CALM";
  let topReason = "All systems nominal";

  for (const [name, status] of Object.entries(monitors)) {
    if (SEVERITY_ORDER[status.level] > SEVERITY_ORDER[topLevel]) {
      topLevel = status.level;
      topReason = `${name.charAt(0).toUpperCase() + name.slice(1)}: ${status.summary}`;
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

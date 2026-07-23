/**
 * Composite alert severity scoring for Crescent City.
 *
 * Aggregates input from all 8 alert monitors and returns a single
 * standardised composite status: CALM | WATCH | WARNING | EMERGENCY.
 *
 * Rules (applied in priority order):
 *   EMERGENCY — any active Tsunami Warning (CAP) or USGS tsunami flag ≥ 2
 *   WARNING   — active Earthquake M≥6 within 200 km, NWS Severe weather warning,
 *               tidal water level ≥ 5 ft MLLW, gale-force winds, or wildfire evac orders
 *   WATCH     — Earthquake M4-6 within 200 km, NWS watch/advisory,
 *               CDFW fishing closure, tidal level ≥ 3 ft MLLW, elevated seas
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
  };
}

export interface MonitorStatus {
  /** CALM | WATCH | WARNING | EMERGENCY */
  level: AlertSeverity;
  /** Short human-readable status */
  summary: string;
  /** Number of active alerts/events this monitor found */
  count: number;
}

export interface TsunamiInput {
  /** Number of active Tsunami Warning CAP events */
  warningCount: number;
  /** Number of active Tsunami Watch/Advisory CAP events */
  watchCount: number;
}

export interface EarthquakeInput {
  /** Array of nearby earthquakes with magnitude + USGS tsunami flag */
  events: Array<{ magnitude: number; distanceKm: number; tsunami: number; place: string }>;
}

export interface WeatherInput {
  /** Active NWS severity levels for Crescent City zone */
  severities: Array<"advisory" | "watch" | "warning">;
  /** Number of active events */
  count: number;
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
}

export interface MarineInput {
  /** Wave height in feet at primary buoy (null if unavailable) */
  waveHeightFt: number | null;
  /** Wind speed in knots at primary buoy (null if unavailable) */
  windSpeedKt: number | null;
  /** Whether buoy data was available */
  available: boolean;
}

/**
 * Assess tsunami monitor severity.
 */
function assessTsunami(input: TsunamiInput): MonitorStatus {
  if (input.warningCount > 0) {
    return {
      level: "EMERGENCY",
      summary: `⚠️ ${input.warningCount} active Tsunami Warning(s)`,
      count: input.warningCount + input.watchCount,
    };
  }
  if (input.watchCount > 0) {
    return {
      level: "WATCH",
      summary: `🟡 ${input.watchCount} active Tsunami Watch/Advisory`,
      count: input.watchCount,
    };
  }
  return { level: "CALM", summary: "No active tsunami alerts", count: 0 };
}

/**
 * Assess earthquake monitor severity.
 */
function assessEarthquake(input: EarthquakeInput): MonitorStatus {
  const nearbyEvents = input.events.filter((e) => e.distanceKm <= 200);
  if (nearbyEvents.length === 0) {
    return { level: "CALM", summary: "No qualifying earthquakes nearby", count: 0 };
  }

  // USGS tsunami flag 2 = tsunami generated
  const tsunamiEvents = nearbyEvents.filter((e) => e.tsunami >= 2);
  if (tsunamiEvents.length > 0) {
    return {
      level: "EMERGENCY",
      summary: `🚨 Earthquake M${tsunamiEvents[0].magnitude} with tsunami generated`,
      count: nearbyEvents.length,
    };
  }

  const severe = nearbyEvents.filter((e) => e.magnitude >= 6.0);
  if (severe.length > 0) {
    const top = severe[0];
    return {
      level: "WARNING",
      summary: `🔴 M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away`,
      count: nearbyEvents.length,
    };
  }

  // M4.0–5.9 in range
  const top = nearbyEvents[0];
  return {
    level: "WATCH",
    summary: `🟡 M${top.magnitude} earthquake ${top.distanceKm.toFixed(0)} km away`,
    count: nearbyEvents.length,
  };
}

/**
 * Assess NWS weather monitor severity.
 */
function assessWeather(input: WeatherInput): MonitorStatus {
  if (input.count === 0) {
    return { level: "CALM", summary: "No active weather alerts", count: 0 };
  }

  if (input.severities.includes("warning")) {
    return {
      level: "WARNING",
      summary: `🔴 ${input.count} active NWS Warning(s)`,
      count: input.count,
    };
  }
  if (input.severities.includes("watch")) {
    return {
      level: "WATCH",
      summary: `🟡 ${input.count} active NWS Watch(es)`,
      count: input.count,
    };
  }
  return {
    level: "WATCH",
    summary: `🔵 ${input.count} active NWS Advisory(ies)`,
    count: input.count,
  };
}

/**
 * Assess NOAA tides severity based on predicted water level.
 */
function assessTides(input: TidesInput): MonitorStatus {
  if (!input.available || input.waterLevelFt === null) {
    return { level: "CALM", summary: "Tides data unavailable", count: 0 };
  }
  if (input.waterLevelFt >= 5.0) {
    return {
      level: "WARNING",
      summary: `🔴 High tide ${input.waterLevelFt.toFixed(1)} ft MLLW`,
      count: 1,
    };
  }
  if (input.waterLevelFt >= 3.0) {
    return {
      level: "WATCH",
      summary: `🟡 Elevated tide ${input.waterLevelFt.toFixed(1)} ft MLLW`,
      count: 1,
    };
  }
  return {
    level: "CALM",
    summary: `Normal tides ${input.waterLevelFt.toFixed(1)} ft MLLW`,
    count: 0,
  };
}

/**
 * Assess CDFW fishing monitor severity.
 */
function assessFishing(input: FishingInput): MonitorStatus {
  if (input.closureActive) {
    return {
      level: "WATCH",
      summary: `🟡 Fishery closure in effect${input.closureMessage ? ": " + input.closureMessage : ""}`,
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
    return { level: "CALM", summary: "Air quality data unavailable", count: 0 };
  }
  if (input.maxAqi > 200) {
    return {
      level: "WARNING",
      summary: `🔴 Air quality AQI ${input.maxAqi} (Very Unhealthy)`,
      count: 1,
    };
  }
  if (input.maxAqi > 100) {
    return {
      level: "WATCH",
      summary: `🟡 Air quality AQI ${input.maxAqi} (Unhealthy for Sensitive Groups)`,
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
  if (input.incidentCount === 0) {
    return { level: "CALM", summary: "No active wildfires in region", count: 0 };
  }
  if (input.hasEvacuationOrders) {
    return {
      level: "EMERGENCY",
      summary: `🚨 Wildfire evacuation orders active (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  if (input.hasLargeFireNearby) {
    return {
      level: "WARNING",
      summary: `🔴 Large active wildfire nearby (${input.incidentCount} incident(s))`,
      count: input.incidentCount,
    };
  }
  return {
    level: "WATCH",
    summary: `🟡 ${input.incidentCount} active wildfire(s) in region`,
    count: input.incidentCount,
  };
}

/**
 * Assess NDBC marine weather monitor severity.
 */
function assessMarine(input: MarineInput): MonitorStatus {
  if (!input.available || (input.waveHeightFt === null && input.windSpeedKt === null)) {
    return { level: "CALM", summary: "Marine buoy data unavailable", count: 0 };
  }
  if ((input.waveHeightFt ?? 0) >= 15 || (input.windSpeedKt ?? 0) >= 34) {
    return {
      level: "WARNING",
      summary: `🔴 Hazardous marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "—"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "—"}kt wind`,
      count: 1,
    };
  }
  if ((input.waveHeightFt ?? 0) >= 10 || (input.windSpeedKt ?? 0) >= 22) {
    return {
      level: "WATCH",
      summary: `🟡 Elevated marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "—"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "—"}kt wind`,
      count: 1,
    };
  }
  return {
    level: "CALM",
    summary: `Normal marine conditions: ${input.waveHeightFt?.toFixed(1) ?? "—"}ft waves, ${input.windSpeedKt?.toFixed(0) ?? "—"}kt wind`,
    count: 0,
  };
}

/** Priority ordering for severity levels */
const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  CALM: 0,
  WATCH: 1,
  WARNING: 2,
  EMERGENCY: 3,
};

/**
 * Compute composite alert severity from all 8 monitor inputs.
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

  return {
    level: topLevel,
    assessedAt: new Date().toISOString(),
    reason: topReason,
    monitors,
  };
}

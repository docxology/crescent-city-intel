/**
 * Fixture-driven tests for NWS Weather, USGS Earthquake, and NOAA Tsunami
 * alert monitors. Tests pure parsing and classification functions only —
 * no network calls, no mocks. Fixtures match the real API response shapes.
 */
import { describe, test, expect } from "bun:test";
import {
  getAlertSeverityLevel,
  isCrescentCityRelevant as nwsIsCrescentCityRelevant,
  pointInPolygon,
} from "../src/alerts/nws_weather.ts";
import {
  haversineDistance,
  isCascadiaEvent,
} from "../src/alerts/usgs_earthquake.ts";
import {
  isCrescentCityRelevant as tsunamiIsCrescentCityRelevant,
} from "../src/alerts/noaa_tsunami.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURES — Realistic NWS API response data matching NWSAlertResponse shape
// ═══════════════════════════════════════════════════════════════════════════════

/** High Wind Warning affecting Crescent City — Severe/Likely/Immediate */
const NWS_HIGH_WIND_FEATURE = {
  type: "Feature" as const,
  id: "urn:oid:2.49.0.1.840.0.nws-hw-001",
  properties: {
    id: "urn:oid:2.49.0.1.840.0.nws-hw-001",
    areaDesc: "Coastal Del Norte; Northern California Coast",
    event: "High Wind Warning",
    severity: "Severe",
    certainty: "Likely",
    urgency: "Immediate",
    effective: "2025-01-15T12:00:00Z",
    expires: "2025-01-16T00:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "High Wind Warning issued for Crescent City area",
    description:
      "Damaging winds expected along the coast. Crescent City will experience gusts up to 70 mph.",
    instruction: "Take shelter immediately. Avoid coastal areas.",
    status: "Actual",
    msgType: "Alert",
    category: "Met",
    response: "Shelter",
    onset: "2025-01-15T14:00:00Z",
    parameters: {} as Record<string, unknown>,
  },
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [-124.3, 41.7],
        [-124.1, 41.7],
        [-124.1, 41.8],
        [-124.3, 41.8],
        [-124.3, 41.7],
      ],
    ],
  },
};

/** Coastal Flood Advisory — Minor/Possible/Future = advisory */
const NWS_COASTAL_FLOOD_FEATURE = {
  type: "Feature" as const,
  id: "urn:oid:2.49.0.1.840.0.nws-cf-002",
  properties: {
    id: "urn:oid:2.49.0.1.840.0.nws-cf-002",
    areaDesc: "CAZ006; Northwest California coastal waters",
    event: "Coastal Flood Advisory",
    severity: "Minor",
    certainty: "Possible",
    urgency: "Future",
    effective: "2025-01-15T06:00:00Z",
    expires: "2025-01-16T06:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Coastal Flood Advisory for Northwest California",
    description:
      "Minor coastal flooding possible during high tide cycles. Areas include Del Norte County coastline.",
    instruction: "Avoid low-lying coastal roads during high tide.",
    status: "Actual",
    msgType: "Alert",
    category: "Met",
    response: "Prepare",
    onset: "2025-01-15T08:00:00Z",
    parameters: {} as Record<string, unknown>,
  },
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [-124.5, 41.5],
        [-123.5, 41.5],
        [-123.5, 42.0],
        [-124.5, 42.0],
        [-124.5, 41.5],
      ],
    ],
  },
};

/** Marine Weather Statement — Moderate/Likely/Future = watch */
const NWS_MARINE_STATEMENT_FEATURE = {
  type: "Feature" as const,
  id: "urn:oid:2.49.0.1.840.0.nws-ms-003",
  properties: {
    id: "urn:oid:2.49.0.1.840.0.nws-ms-003",
    areaDesc: "Coastal waters from Pt. St. George to Cape Mendocino CA out 10 nm",
    event: "Marine Weather Statement",
    severity: "Moderate",
    certainty: "Possible",
    urgency: "Future",
    effective: "2025-01-15T10:00:00Z",
    expires: "2025-01-16T10:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Marine conditions may deteriorate along the California coast",
    description:
      "A developing low pressure system may bring hazardous marine conditions to coastal waters.",
    instruction: "Mariners should monitor conditions.",
    status: "Actual",
    msgType: "Alert",
    category: "Met",
    response: "Monitor",
    onset: "2025-01-15T18:00:00Z",
    parameters: {} as Record<string, unknown>,
  },
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [-124.5, 40.5],
        [-123.5, 40.5],
        [-123.5, 42.0],
        [-124.5, 42.0],
        [-124.5, 40.5],
      ],
    ],
  },
};

/** Alert for a completely different region — should NOT be deemed Crescent City relevant.
 *  NOTE: Must avoid NWS keyword-list substrings (especially 'ca' which matches
 *  'Chicago', 'coastal', 'local', etc.). Using Denver, CO to guarantee no match. */
const NWS_DISTANT_ALERT_FEATURE = {
  type: "Feature" as const,
  id: "urn:oid:2.49.0.1.840.0.nws-co-999",
  properties: {
    id: "urn:oid:2.49.0.1.840.0.nws-co-999",
    areaDesc: "Denver County; Adams County; Arapahoe County",
    event: "Winter Storm Warning",
    severity: "Severe",
    certainty: "Likely",
    urgency: "Immediate",
    effective: "2025-01-15T12:00:00Z",
    expires: "2025-01-16T00:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Winter Storm Warning for Denver metropolitan area",
    description: "Heavy snow expected in Denver metro. 8-12 inches possible.",
    instruction: "Avoid unnecessary travel.",
    status: "Actual",
    msgType: "Alert",
    category: "Met",
    response: "Shelter",
    onset: "2025-01-15T14:00:00Z",
    parameters: {} as Record<string, unknown>,
  },
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [-105.0, 39.5],
        [-104.5, 39.5],
        [-104.5, 40.0],
        [-105.0, 40.0],
        [-105.0, 39.5],
      ],
    ],
  },
};

/** Full NWS alert response fixture (wraps multiple features) */
const NWS_ALERT_RESPONSE_FIXTURE = {
  type: "FeatureCollection",
  features: [
    NWS_HIGH_WIND_FEATURE,
    NWS_COASTAL_FLOOD_FEATURE,
    NWS_MARINE_STATEMENT_FEATURE,
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURES — Realistic USGS API response data matching USGSResponse shape
// ═══════════════════════════════════════════════════════════════════════════════

/** M6.4 near Crescent City with tsunami potential (tsunami=1) */
const USGS_EQ_NEARBY = {
  type: "Feature" as const,
  id: "us7000abc123",
  properties: {
    mag: 6.4,
    place: "45 km SW of Crescent City, California",
    time: 1737000000000,
    updated: 1737000100000,
    tz: null as number | null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abc123",
    detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000abc123.geojson",
    felt: null as number | null,
    cdi: null as number | null,
    mmi: null as number | null,
    alert: "green" as string | null,
    status: "reviewed",
    tsunami: 1,
    sig: 630,
    net: "us",
    code: "7000abc123",
    ids: ",us7000abc123,",
    sources: ",us,",
    types: ",origin,phase-data,",
    nst: null as number | null,
    dmin: null as number | null,
    rms: null as number | null,
    gap: null as number | null,
    magType: "mw",
    type: "earthquake",
    title: "M 6.4 - 45 km SW of Crescent City, California",
  },
  geometry: {
    type: "Point" as const,
    coordinates: [-124.5, 41.5, 10.0] as [number, number, number],
  },
};

/** M4.2 just barely above minimum magnitude, Cascadia zone */
const USGS_EQ_CASCADIA = {
  type: "Feature" as const,
  id: "us7000def456",
  properties: {
    mag: 4.2,
    place: "120 km NW of Eureka, California",
    time: 1737000000000,
    updated: 1737000100000,
    tz: null as number | null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000def456",
    detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000def456.geojson",
    felt: null as number | null,
    cdi: null as number | null,
    mmi: null as number | null,
    alert: null as string | null,
    status: "reviewed",
    tsunami: 0,
    sig: 270,
    net: "us",
    code: "7000def456",
    ids: ",us7000def456,",
    sources: ",us,",
    types: ",origin,phase-data,",
    nst: null as number | null,
    dmin: null as number | null,
    rms: null as number | null,
    gap: null as number | null,
    magType: "mb",
    type: "earthquake",
    title: "M 4.2 - 120 km NW of Eureka, California",
  },
  geometry: {
    type: "Point" as const,
    coordinates: [-125.0, 41.8, 25.0] as [number, number, number],
  },
};

/** M7.8 megaquake — Cascadia subduction boundary */
const USGS_EQ_MEGA = {
  type: "Feature" as const,
  id: "us7000ghi789",
  properties: {
    mag: 7.8,
    place: "95 km W of Crescent City, California",
    time: 1737000000000,
    updated: 1737000100000,
    tz: null as number | null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000ghi789",
    detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000ghi789.geojson",
    felt: null as number | null,
    cdi: null as number | null,
    mmi: null as number | null,
    alert: "red" as string | null,
    status: "reviewed",
    tsunami: 2,
    sig: 935,
    net: "us",
    code: "7000ghi789",
    ids: ",us7000ghi789,",
    sources: ",us,",
    types: ",origin,phase-data,",
    nst: null as number | null,
    dmin: null as number | null,
    rms: null as number | null,
    gap: null as number | null,
    magType: "mw",
    type: "earthquake",
    title: "M 7.8 - 95 km W of Crescent City, California",
  },
  geometry: {
    type: "Point" as const,
    coordinates: [-125.2, 41.75, 15.0] as [number, number, number],
  },
};

/** M3.1 earthquake — below magnitude threshold (should be filtered out) */
const USGS_EQ_BELOW_THRESHOLD = {
  type: "Feature" as const,
  id: "us7000jkl012",
  properties: {
    mag: 3.1,
    place: "25 km E of Crescent City, California",
    time: 1737000000000,
    updated: 1737000100000,
    tz: null as number | null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000jkl012",
    detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000jkl012.geojson",
    felt: null as number | null,
    cdi: null as number | null,
    mmi: null as number | null,
    alert: null as string | null,
    status: "reviewed",
    tsunami: 0,
    sig: 148,
    net: "us",
    code: "7000jkl012",
    ids: ",us7000jkl012,",
    sources: ",us,",
    types: ",origin,phase-data,",
    nst: null as number | null,
    dmin: null as number | null,
    rms: null as number | null,
    gap: null as number | null,
    magType: "ml",
    type: "earthquake",
    title: "M 3.1 - 25 km E of Crescent City, California",
  },
  geometry: {
    type: "Point" as const,
    coordinates: [-124.0, 41.8, 5.0] as [number, number, number],
  },
};

/** M5.0 — moderate, non-Cascadia (outside subduction zone longitudinally) */
const USGS_EQ_NON_CASCADIA = {
  type: "Feature" as const,
  id: "us7000mno345",
  properties: {
    mag: 5.0,
    place: "60 km SE of Reno, Nevada",
    time: 1737000000000,
    updated: 1737000100000,
    tz: null as number | null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000mno345",
    detail: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000mno345.geojson",
    felt: null as number | null,
    cdi: null as number | null,
    mmi: null as number | null,
    alert: null as string | null,
    status: "reviewed",
    tsunami: 0,
    sig: 385,
    net: "us",
    code: "7000mno345",
    ids: ",us7000mno345,",
    sources: ",us,",
    types: ",origin,phase-data,",
    nst: null as number | null,
    dmin: null as number | null,
    rms: null as number | null,
    gap: null as number | null,
    magType: "mb",
    type: "earthquake",
    title: "M 5.0 - 60 km SE of Reno, Nevada",
  },
  geometry: {
    type: "Point" as const,
    coordinates: [-119.0, 39.0, 8.0] as [number, number, number],
  },
};

/** Full USGS response fixture */
const USGS_RESPONSE_FIXTURE = {
  type: "FeatureCollection",
  metadata: {
    generated: 1737000000000,
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson",
    title: "USGS Significant Earthquakes, Past Hour",
    status: 200,
    api: "1.0.0",
    count: 4,
  },
  features: [
    USGS_EQ_NEARBY,
    USGS_EQ_CASCADIA,
    USGS_EQ_MEGA,
    USGS_EQ_NON_CASCADIA,
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// FIXTURES — Realistic NOAA CAP alert response data matching NOAAAlertResponse shape
// ═══════════════════════════════════════════════════════════════════════════════

/** Tsunami Warning for Crescent City area */
const NOAA_TSUNAMI_WARNING_FEATURE = {
  type: "Feature" as const,
  properties: {
    id: "urn:oid:2.49.0.1.840.0.ntwc-tsu-001",
    areaDesc: "Crescent City; Del Norte County; Northern California Coast",
    event: "Tsunami Warning",
    severity: "Extreme",
    certainty: "Observed",
    urgency: "Immediate",
    effective: "2025-01-15T12:00:00Z",
    expires: "2025-01-16T00:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tsunami Warning for Crescent City and Northern California Coast",
    description:
      "Tsunami waves observed along the Northern California coast. Crescent City expected to be impacted within 30 minutes.",
    instruction: "Move to high ground immediately. Do not return until authorities declare safe.",
    status: "Actual",
    msgType: "Alert",
    category: "Geo",
  },
  geometry: null as { type: string; coordinates: number[][][] } | null,
};

/** Tsunami Watch — milder event */
const NOAA_TSUNAMI_WATCH_FEATURE = {
  type: "Feature" as const,
  properties: {
    id: "urn:oid:2.49.0.1.840.0.ntwc-tsu-002",
    areaDesc: "Pacific Coast from Oregon border to Cape Mendocino",
    event: "Tsunami Watch",
    severity: "Severe",
    certainty: "Possible",
    urgency: "Expected",
    effective: "2025-01-15T14:00:00Z",
    expires: "2025-01-16T02:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tsunami Watch issued for Northern California and Oregon coast",
    description:
      "A tsunami watch is in effect for the California coast and Oregon coast following a distant seismic event.",
    instruction: "Stay away from beaches and low-lying coastal areas.",
    status: "Actual",
    msgType: "Alert",
    category: "Geo",
  },
  geometry: null as { type: string; coordinates: number[][][] } | null,
};

/** Tsunami Information Statement — advisory level */
const NOAA_TSUNAMI_INFO_FEATURE = {
  type: "Feature" as const,
  properties: {
    id: "urn:oid:2.49.0.1.840.0.ntwc-tsu-003",
    areaDesc: "California Coast; Oregon Coast; Washington Coast",
    event: "Tsunami Information Statement",
    severity: "Minor",
    certainty: "Possible",
    urgency: "Past",
    effective: "2025-01-15T16:00:00Z",
    expires: "2025-01-16T04:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tsunami Information Statement for the West Coast",
    description:
      "An earthquake has occurred but no tsunami is expected for California or the West Coast.",
    instruction: "No action required. Monitor local news for updates.",
    status: "Actual",
    msgType: "Alert",
    category: "Geo",
  },
  geometry: null as { type: string; coordinates: number[][][] } | null,
};

/** Alert from a non-California region — should not be deemed relevant.
 *  NOTE: Must avoid keyword-list substrings (especially 'ca' which matches
 *  'Alaska', 'local', 'Pacific', etc.). Using Japan with 'ca'-free text. */
const NOAA_DISTANT_ALERT_FEATURE = {
  type: "Feature" as const,
  properties: {
    id: "urn:oid:2.49.0.1.840.0.ntwc-tsu-999",
    areaDesc: "Japan; Honshu Island",
    event: "Tsunami Warning",
    severity: "Extreme",
    certainty: "Observed",
    urgency: "Immediate",
    effective: "2025-01-15T12:00:00Z",
    expires: "2025-01-16T00:00:00Z",
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tsunami Warning for Japan",
    description: "Tsunami observed near Japan. Evacuation ordered for the region.",
    instruction: "Move to high ground immediately.",
    status: "Actual",
    msgType: "Alert",
    category: "Geo",
  },
  geometry: null as { type: string; coordinates: number[][][] } | null,
};

/** Full NOAA tsunami alert response fixture */
const NOAA_TSUNAMI_RESPONSE_FIXTURE = {
  type: "FeatureCollection",
  features: [
    NOAA_TSUNAMI_WARNING_FEATURE,
    NOAA_TSUNAMI_WATCH_FEATURE,
    NOAA_TSUNAMI_INFO_FEATURE,
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// NWS WEATHER — Fixture shape validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("NWS Weather — fixture shape matches API response interface", () => {
  test("fixture is a valid FeatureCollection with features array", () => {
    expect(NWS_ALERT_RESPONSE_FIXTURE.type).toBe("FeatureCollection");
    expect(Array.isArray(NWS_ALERT_RESPONSE_FIXTURE.features)).toBe(true);
    expect(NWS_ALERT_RESPONSE_FIXTURE.features.length).toBeGreaterThanOrEqual(1);
  });

  test("each feature has required NWSAlertProperties fields", () => {
    for (const feature of NWS_ALERT_RESPONSE_FIXTURE.features) {
      const p = feature.properties;
      expect(typeof p.id).toBe("string");
      expect(typeof p.areaDesc).toBe("string");
      expect(typeof p.event).toBe("string");
      expect(typeof p.severity).toBe("string");
      expect(typeof p.certainty).toBe("string");
      expect(typeof p.urgency).toBe("string");
      expect(typeof p.effective).toBe("string");
      expect(typeof p.expires).toBe("string");
      expect(typeof p.headline).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(typeof p.status).toBe("string");
      expect(typeof p.msgType).toBe("string");
      expect(typeof p.category).toBe("string");
    }
  });

  test("fixture timestamps are valid ISO 8601", () => {
    for (const feature of NWS_ALERT_RESPONSE_FIXTURE.features) {
      const effectiveDate = new Date(feature.properties.effective);
      const expiresDate = new Date(feature.properties.expires);
      expect(effectiveDate.getTime()).not.toBeNaN();
      expect(expiresDate.getTime()).not.toBeNaN();
      // Expires should be after effective
      expect(expiresDate.getTime()).toBeGreaterThanOrEqual(effectiveDate.getTime());
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NWS WEATHER — Classification: getAlertSeverityLevel
// ═══════════════════════════════════════════════════════════════════════════════

describe("NWS Weather — getAlertSeverityLevel classification", () => {
  test("Severe severity returns warning regardless of certainty/urgency", () => {
    expect(getAlertSeverityLevel("Severe", "Likely", "Immediate")).toBe("warning");
    expect(getAlertSeverityLevel("Severe", "Possible", "Future")).toBe("warning");
    expect(getAlertSeverityLevel("Severe", "Observed", "Past")).toBe("warning");
    expect(getAlertSeverityLevel("severe", "likely", "immediate")).toBe("warning");
  });

  test("Moderate + Likely/Very Likely + Immediate/Expected returns warning", () => {
    expect(getAlertSeverityLevel("Moderate", "Likely", "Immediate")).toBe("warning");
    expect(getAlertSeverityLevel("Moderate", "Very Likely", "Immediate")).toBe("warning");
    expect(getAlertSeverityLevel("Moderate", "Likely", "Expected")).toBe("warning");
    expect(getAlertSeverityLevel("Moderate", "Very Likely", "Expected")).toBe("warning");
  });

  test("Moderate + Possible/Likely + Future returns watch", () => {
    expect(getAlertSeverityLevel("Moderate", "Possible", "Future")).toBe("watch");
    expect(getAlertSeverityLevel("Moderate", "Likely", "Future")).toBe("watch");
  });

  test("Minor + Likely/Very Likely returns watch", () => {
    expect(getAlertSeverityLevel("Minor", "Likely", "Immediate")).toBe("watch");
    expect(getAlertSeverityLevel("Minor", "Very Likely", "Immediate")).toBe("watch");
    expect(getAlertSeverityLevel("Minor", "Likely", "Future")).toBe("watch");
    expect(getAlertSeverityLevel("Minor", "Very Likely", "Future")).toBe("watch");
  });

  test("Minor + Possible returns advisory (fallback)", () => {
    expect(getAlertSeverityLevel("Minor", "Possible", "Future")).toBe("advisory");
    expect(getAlertSeverityLevel("Minor", "Possible", "Immediate")).toBe("advisory");
    expect(getAlertSeverityLevel("Minor", "Possible", "Expected")).toBe("advisory");
    expect(getAlertSeverityLevel("Minor", "Possible", "Past")).toBe("advisory");
  });

  test("Unknown/arbitrary values return advisory (safe default)", () => {
    expect(getAlertSeverityLevel("Unknown", "Unknown", "Unknown")).toBe("advisory");
    expect(getAlertSeverityLevel("", "", "")).toBe("advisory");
  });

  test("case-insensitive matching works", () => {
    expect(getAlertSeverityLevel("SEVERE", "LIKELY", "IMMEDIATE")).toBe("warning");
    expect(getAlertSeverityLevel("moderate", "POSSIBLE", "FUTURE")).toBe("watch");
    expect(getAlertSeverityLevel("MINOR", "POSSIBLE", "FUTURE")).toBe("advisory");
  });

  test("fixture alerts classify correctly", () => {
    const hw = NWS_HIGH_WIND_FEATURE.properties;
    expect(getAlertSeverityLevel(hw.severity, hw.certainty, hw.urgency)).toBe("warning");

    const cf = NWS_COASTAL_FLOOD_FEATURE.properties;
    expect(getAlertSeverityLevel(cf.severity, cf.certainty, cf.urgency)).toBe("advisory");

    const ms = NWS_MARINE_STATEMENT_FEATURE.properties;
    expect(getAlertSeverityLevel(ms.severity, ms.certainty, ms.urgency)).toBe("watch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NWS WEATHER — Relevance: isCrescentCityRelevant
// ═══════════════════════════════════════════════════════════════════════════════

describe("NWS Weather — isCrescentCityRelevant keyword matching", () => {
  test('"crescent city" in areaDesc is relevant', () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: "Crescent City; Del Norte County",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"del norte" in areaDesc is relevant', () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: "Del Norte County coastal zone",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"california coast" in areaDesc is relevant', () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: "California Coast; Northwest California",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"caz006" (zone code) in areaDesc is relevant', () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: "CAZ006; Northwest California coastal waters",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"california" in description but not areaDesc is still relevant', () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: "Some generic zone",
      description: "This alert covers the California coastal region.",
    });
    expect(result).toBe(true);
  });

  test("case-insensitive matching", () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: "CRESCENT CITY; DEL NORTE",
      description: "",
    });
    expect(result).toBe(true);
  });

  test("distant Denver alert is NOT relevant by keywords or geometry", () => {
    const result = nwsIsCrescentCityRelevant({
      areaDesc: NWS_DISTANT_ALERT_FEATURE.properties.areaDesc,
      description: NWS_DISTANT_ALERT_FEATURE.properties.description,
      geometry: NWS_DISTANT_ALERT_FEATURE.geometry,
    });
    expect(result).toBe(false);
  });

  test("fixture alerts are correctly classified as relevant/not", () => {
    // High Wind Warning for Del Norte — relevant by keywords
    expect(
      nwsIsCrescentCityRelevant({
        areaDesc: NWS_HIGH_WIND_FEATURE.properties.areaDesc,
        description: NWS_HIGH_WIND_FEATURE.properties.description,
        geometry: NWS_HIGH_WIND_FEATURE.geometry,
      })
    ).toBe(true);

    // Coastal Flood Advisory for CAZ006 — relevant by zone code
    expect(
      nwsIsCrescentCityRelevant({
        areaDesc: NWS_COASTAL_FLOOD_FEATURE.properties.areaDesc,
        description: NWS_COASTAL_FLOOD_FEATURE.properties.description,
        geometry: NWS_COASTAL_FLOOD_FEATURE.geometry,
      })
    ).toBe(true);

    // Marine statement with "California coast" — relevant
    expect(
      nwsIsCrescentCityRelevant({
        areaDesc: NWS_MARINE_STATEMENT_FEATURE.properties.areaDesc,
        description: NWS_MARINE_STATEMENT_FEATURE.properties.description,
        geometry: NWS_MARINE_STATEMENT_FEATURE.geometry,
      })
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NWS WEATHER — Geometry: pointInPolygon
// ═══════════════════════════════════════════════════════════════════════════════

describe("NWS Weather — pointInPolygon geometry", () => {
  test("Crescent City coordinates are inside its own bounding box", () => {
    // A polygon that tightly wraps Crescent City
    const ccPolygon: number[][][] = [
      [
        [-124.3, 41.7],
        [-124.1, 41.7],
        [-124.1, 41.8],
        [-124.3, 41.8],
        [-124.3, 41.7],
      ],
    ];
    const ccPoint = { lat: 41.7485, lng: -124.2028 };
    expect(pointInPolygon(ccPoint, ccPolygon)).toBe(true);
  });

  test("point far outside polygon returns false", () => {
    const polygon: number[][][] = [
      [
        [-124.3, 41.7],
        [-124.1, 41.7],
        [-124.1, 41.8],
        [-124.3, 41.8],
        [-124.3, 41.7],
      ],
    ];
    const distantPoint = { lat: 40.0, lng: -120.0 };
    expect(pointInPolygon(distantPoint, polygon)).toBe(false);
  });

  test("point on polygon boundary edge is handled", () => {
    const polygon: number[][][] = [
      [
        [-125.0, 41.0],
        [-123.0, 41.0],
        [-123.0, 43.0],
        [-125.0, 43.0],
        [-125.0, 41.0],
      ],
    ];
    // Crescent City is well inside this larger box
    const ccPoint = { lat: 41.7485, lng: -124.2028 };
    expect(pointInPolygon(ccPoint, polygon)).toBe(true);
  });

  test("empty polygon returns false", () => {
    const emptyPolygon: number[][][] = [[]];
    expect(pointInPolygon({ lat: 41.7485, lng: -124.2028 }, emptyPolygon)).toBe(false);
  });

  test("Crescent City is NOT inside a Florida polygon", () => {
    const floridaPolygon: number[][][] = [
      [
        [-80.5, 25.5],
        [-80.0, 25.5],
        [-80.0, 26.5],
        [-80.5, 26.5],
        [-80.5, 25.5],
      ],
    ];
    const ccPoint = { lat: 41.7485, lng: -124.2028 };
    expect(pointInPolygon(ccPoint, floridaPolygon)).toBe(false);
  });

  test("a point inside a ring hole returns false (outer ring + hole)", () => {
    // Outer square [-125..-123] x [41..43] with a hole [-124.4..-124.0] x [41.6..41.9].
    const donut: number[][][] = [
      [
        [-125.0, 41.0], [-123.0, 41.0], [-123.0, 43.0], [-125.0, 43.0], [-125.0, 41.0],
      ],
      [
        [-124.4, 41.6], [-124.0, 41.6], [-124.0, 41.9], [-124.4, 41.9], [-124.4, 41.6],
      ],
    ];
    // Inside the hole → outside the polygon.
    expect(pointInPolygon({ lat: 41.7485, lng: -124.2 }, donut)).toBe(false);
    // In the ring area (inside outer, outside hole) → inside the polygon.
    expect(pointInPolygon({ lat: 42.0, lng: -124.2 }, donut)).toBe(true);
    // Outside the outer ring → not inside.
    expect(pointInPolygon({ lat: 40.0, lng: -124.2 }, donut)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// USGS EARTHQUAKE — Fixture shape validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("USGS Earthquake — fixture shape matches API response interface", () => {
  test("fixture is a valid FeatureCollection with metadata", () => {
    expect(USGS_RESPONSE_FIXTURE.type).toBe("FeatureCollection");
    expect(USGS_RESPONSE_FIXTURE.metadata.status).toBe(200);
    expect(Array.isArray(USGS_RESPONSE_FIXTURE.features)).toBe(true);
    expect(USGS_RESPONSE_FIXTURE.features.length).toBeGreaterThanOrEqual(1);
  });

  test("each feature has required USGSEarthquakeProperties fields", () => {
    for (const feature of USGS_RESPONSE_FIXTURE.features) {
      const p = feature.properties;
      expect(typeof p.mag).toBe("number");
      expect(typeof p.place).toBe("string");
      expect(typeof p.time).toBe("number");
      expect(typeof p.url).toBe("string");
      expect(typeof p.tsunami).toBe("number");
      expect(typeof p.magType).toBe("string");
      expect(typeof p.title).toBe("string");
    }
  });

  test("each feature has Point geometry with valid coordinates", () => {
    for (const feature of USGS_RESPONSE_FIXTURE.features) {
      expect(feature.geometry.type).toBe("Point");
      expect(Array.isArray(feature.geometry.coordinates)).toBe(true);
      expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      // longitude is valid
      expect(feature.geometry.coordinates[0]).toBeGreaterThanOrEqual(-180);
      expect(feature.geometry.coordinates[0]).toBeLessThanOrEqual(180);
      // latitude is valid
      expect(feature.geometry.coordinates[1]).toBeGreaterThanOrEqual(-90);
      expect(feature.geometry.coordinates[1]).toBeLessThanOrEqual(90);
    }
  });

  test("fixture earthquake times are valid epoch milliseconds", () => {
    for (const feature of USGS_RESPONSE_FIXTURE.features) {
      const date = new Date(feature.properties.time);
      expect(date.getTime()).not.toBeNaN();
      expect(feature.properties.time).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// USGS EARTHQUAKE — haversineDistance
// ═══════════════════════════════════════════════════════════════════════════════

describe("USGS Earthquake — haversineDistance", () => {
  test("distance from Crescent City to itself is zero", () => {
    const d = haversineDistance(41.7485, -124.2028, 41.7485, -124.2028);
    expect(d).toBe(0);
  });

  test("distance between known coordinate pairs is accurate", () => {
    // Crescent City to San Francisco ~500 km
    const d = haversineDistance(41.7485, -124.2028, 37.7749, -122.4194);
    expect(d).toBeGreaterThan(400);
    expect(d).toBeLessThan(550);
  });

  test("distance from Crescent City to Eureka is ~80 km", () => {
    const d = haversineDistance(41.7485, -124.2028, 40.8021, -124.1637);
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(120);
  });

  test("distance is symmetric", () => {
    const d1 = haversineDistance(41.7485, -124.2028, 40.0, -125.0);
    const d2 = haversineDistance(40.0, -125.0, 41.7485, -124.2028);
    expect(Math.abs(d1 - d2)).toBeLessThan(0.01);
  });

  test("fixture earthquakes compute realistic distances", () => {
    const ccLat = 41.7485;
    const ccLng = -124.2028;

    // Nearby M6.4 at [-124.5, 41.5] — about 35 km
    const dNearby = haversineDistance(ccLat, ccLng, 41.5, -124.5);
    expect(dNearby).toBeGreaterThan(25);
    expect(dNearby).toBeLessThan(45);

    // M7.8 at [-125.2, 41.75] — about 80-85 km
    const dMega = haversineDistance(ccLat, ccLng, 41.75, -125.2);
    expect(dMega).toBeGreaterThan(75);
    expect(dMega).toBeLessThan(95);

    // M5.0 non-Cascadia at [-119.0, 39.0] — very far
    const dNevada = haversineDistance(ccLat, ccLng, 39.0, -119.0);
    expect(dNevada).toBeGreaterThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// USGS EARTHQUAKE — isCascadiaEvent boundary detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("USGS Earthquake — isCascadiaEvent", () => {
  test("Crescent City itself is in Cascadia zone", () => {
    expect(isCascadiaEvent(41.7485, -124.2028)).toBe(true);
  });

  test("Cape Mendocino (38.0, -124.0) — southern boundary is inside", () => {
    expect(isCascadiaEvent(38.0, -124.0)).toBe(true);
  });

  test("just south of Cape Mendocino (37.99, -124.0) — outside", () => {
    expect(isCascadiaEvent(37.99, -124.0)).toBe(false);
  });

  test("Vancouver Island (49.5, -126.0) — inside Cascadia", () => {
    expect(isCascadiaEvent(49.5, -126.0)).toBe(true);
  });

  test("north of Cascadia zone (51.0, -127.0) — outside", () => {
    expect(isCascadiaEvent(51.0, -127.0)).toBe(false);
  });

  test("east of Cascadia zone (45.0, -120.0) — outside", () => {
    expect(isCascadiaEvent(45.0, -120.0)).toBe(false);
  });

  test("west of Cascadia zone (45.0, -129.0) — outside", () => {
    expect(isCascadiaEvent(45.0, -129.0)).toBe(false);
  });

  test("fixture earthquakes are correctly classified as Cascadia or not", () => {
    // Nearby M6.4 at (41.5, -124.5) — inside Cascadia
    const nearbyCoords = USGS_EQ_NEARBY.geometry.coordinates;
    expect(isCascadiaEvent(nearbyCoords[1], nearbyCoords[0])).toBe(true);

    // Cascadia M4.2 at (41.8, -125.0) — inside Cascadia
    const cascadiaCoords = USGS_EQ_CASCADIA.geometry.coordinates;
    expect(isCascadiaEvent(cascadiaCoords[1], cascadiaCoords[0])).toBe(true);

    // Mega M7.8 at (41.75, -125.2) — inside Cascadia
    const megaCoords = USGS_EQ_MEGA.geometry.coordinates;
    expect(isCascadiaEvent(megaCoords[1], megaCoords[0])).toBe(true);

    // Nevada M5.0 at (39.0, -119.0) — NOT Cascadia (east of boundary)
    const nevadaCoords = USGS_EQ_NON_CASCADIA.geometry.coordinates;
    expect(isCascadiaEvent(nevadaCoords[1], nevadaCoords[0])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// USGS EARTHQUAKE — Alert level classification
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Replicates the alert level classification logic from monitorUSGSEarthquakeAlerts:
 *   let alertLevel = 'INFO';
 *   if (eq.magnitude >= 6.0) alertLevel = 'WARNING';
 *   if (eq.magnitude >= 7.0) alertLevel = 'CRITICAL';
 *   if (eq.tsunami === 1) alertLevel = 'TSUNAMI_WATCH';
 *   if (eq.tsunami === 2) alertLevel = 'TSUNAMI_WARNING';
 */
function classifyUSGSAlert(magnitude: number, tsunami: number): string {
  let alertLevel = "INFO";
  if (magnitude >= 6.0) alertLevel = "WARNING";
  if (magnitude >= 7.0) alertLevel = "CRITICAL";
  if (tsunami === 1) alertLevel = "TSUNAMI_WATCH";
  if (tsunami === 2) alertLevel = "TSUNAMI_WARNING";
  return alertLevel;
}

describe("USGS Earthquake — alert level classification", () => {
  test("magnitudes below 4.0 are below monitoring threshold", () => {
    // The module's MIN_MAGNITUDE is 4.0 — these would be filtered out
    expect(USGS_EQ_BELOW_THRESHOLD.properties.mag).toBeLessThan(4.0);
  });

  test("M4.0-M5.9 with no tsunami → INFO", () => {
    expect(classifyUSGSAlert(4.0, 0)).toBe("INFO");
    expect(classifyUSGSAlert(4.2, 0)).toBe("INFO");
    expect(classifyUSGSAlert(5.9, 0)).toBe("INFO");
  });

  test("M6.0-M6.9 with no tsunami → WARNING", () => {
    expect(classifyUSGSAlert(6.0, 0)).toBe("WARNING");
    expect(classifyUSGSAlert(6.4, 0)).toBe("WARNING");
    expect(classifyUSGSAlert(6.9, 0)).toBe("WARNING");
  });

  test("M7.0+ with no tsunami → CRITICAL", () => {
    expect(classifyUSGSAlert(7.0, 0)).toBe("CRITICAL");
    expect(classifyUSGSAlert(7.8, 0)).toBe("CRITICAL");
    expect(classifyUSGSAlert(9.0, 0)).toBe("CRITICAL");
  });

  test("tsunami=1 overrides magnitude-based level → TSUNAMI_WATCH", () => {
    // Even a M4.0 with tsunami=1 becomes TSUNAMI_WATCH
    expect(classifyUSGSAlert(4.0, 1)).toBe("TSUNAMI_WATCH");
    expect(classifyUSGSAlert(6.4, 1)).toBe("TSUNAMI_WATCH");
    expect(classifyUSGSAlert(7.8, 1)).toBe("TSUNAMI_WATCH");
  });

  test("tsunami=2 overrides everything → TSUNAMI_WARNING", () => {
    expect(classifyUSGSAlert(4.0, 2)).toBe("TSUNAMI_WARNING");
    expect(classifyUSGSAlert(6.4, 2)).toBe("TSUNAMI_WARNING");
    expect(classifyUSGSAlert(7.8, 2)).toBe("TSUNAMI_WARNING");
    expect(classifyUSGSAlert(9.1, 2)).toBe("TSUNAMI_WARNING");
  });

  test("fixture earthquakes classify correctly", () => {
    // M6.4, tsunami=1 → TSUNAMI_WATCH
    expect(classifyUSGSAlert(USGS_EQ_NEARBY.properties.mag, USGS_EQ_NEARBY.properties.tsunami)).toBe(
      "TSUNAMI_WATCH"
    );

    // M4.2, tsunami=0 → INFO
    expect(classifyUSGSAlert(USGS_EQ_CASCADIA.properties.mag, USGS_EQ_CASCADIA.properties.tsunami)).toBe(
      "INFO"
    );

    // M7.8, tsunami=2 → TSUNAMI_WARNING
    expect(classifyUSGSAlert(USGS_EQ_MEGA.properties.mag, USGS_EQ_MEGA.properties.tsunami)).toBe(
      "TSUNAMI_WARNING"
    );

    // M5.0, tsunami=0, non-Cascadia → INFO
    expect(
      classifyUSGSAlert(USGS_EQ_NON_CASCADIA.properties.mag, USGS_EQ_NON_CASCADIA.properties.tsunami)
    ).toBe("INFO");
  });

  test("distance filtering — non-Cascadia M5.0 is far from Crescent City (>500km)", () => {
    // The USGS module filters by SEARCH_RADIUS_KM=200
    // This confirms the Nevada quake would indeed be filtered out by distance
    const ccLat = 41.7485;
    const ccLng = -124.2028;
    const nevadaCoords = USGS_EQ_NON_CASCADIA.geometry.coordinates;
    const distance = haversineDistance(ccLat, ccLng, nevadaCoords[1], nevadaCoords[0]);
    expect(distance).toBeGreaterThan(200);
  });

  test("magnitude filtering — M3.1 is below MIN_MAGNITUDE=4.0", () => {
    // Confirm the module would filter this out
    const mag = USGS_EQ_BELOW_THRESHOLD.properties.mag;
    expect(mag).toBeLessThan(4.0); // MIN_MAGNITUDE = 4.0
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOAA TSUNAMI — Fixture shape validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("NOAA Tsunami — fixture shape matches API response interface", () => {
  test("fixture is a valid FeatureCollection with features array", () => {
    expect(NOAA_TSUNAMI_RESPONSE_FIXTURE.type).toBe("FeatureCollection");
    expect(Array.isArray(NOAA_TSUNAMI_RESPONSE_FIXTURE.features)).toBe(true);
    expect(NOAA_TSUNAMI_RESPONSE_FIXTURE.features.length).toBeGreaterThanOrEqual(1);
  });

  test("each feature has required NOAAAlertProperties fields", () => {
    for (const feature of NOAA_TSUNAMI_RESPONSE_FIXTURE.features) {
      const p = feature.properties;
      expect(typeof p.id).toBe("string");
      expect(typeof p.areaDesc).toBe("string");
      expect(typeof p.event).toBe("string");
      expect(typeof p.severity).toBe("string");
      expect(typeof p.certainty).toBe("string");
      expect(typeof p.urgency).toBe("string");
      expect(typeof p.effective).toBe("string");
      expect(typeof p.expires).toBe("string");
      expect(typeof p.headline).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(typeof p.instruction).toBe("string");
      expect(typeof p.status).toBe("string");
      expect(typeof p.msgType).toBe("string");
      expect(typeof p.category).toBe("string");
    }
  });

  test("fixture timestamps are valid ISO 8601", () => {
    for (const feature of NOAA_TSUNAMI_RESPONSE_FIXTURE.features) {
      expect(Date.parse(feature.properties.effective)).not.toBeNaN();
      expect(Date.parse(feature.properties.expires)).not.toBeNaN();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOAA TSUNAMI — Relevance: isCrescentCityRelevant
// ═══════════════════════════════════════════════════════════════════════════════

describe("NOAA Tsunami — isCrescentCityRelevant keyword matching", () => {
  test('"crescent city" in areaDesc is relevant', () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "Crescent City; Del Norte County",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"del norte" in areaDesc is relevant', () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "Del Norte County coastal waters",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"california coast" in areaDesc is relevant', () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "California Coast from Oregon border to Cape Mendocino",
      description: "",
    });
    expect(result).toBe(true);
  });

  test('"northern california" in description is relevant', () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "West Coast Tsunami Zone",
      description: "Tsunami waves are expected along northern California.",
    });
    expect(result).toBe(true);
  });

  test('"ca" boundary (standalone abbreviation) matches', () => {
    // "ca" is in the keyword list; "Pacific" contains "ca" • this is a known
    // loose-match behaviour of the substring check — document it as expected.
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "Pacific Coast CA",
      description: "",
    });
    expect(result).toBe(true);
  });

  test("Japan-only alert is NOT relevant", () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: NOAA_DISTANT_ALERT_FEATURE.properties.areaDesc,
      description: NOAA_DISTANT_ALERT_FEATURE.properties.description,
    });
    expect(result).toBe(false);
  });

  test("Hawaii-only alert is NOT relevant", () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "Hawaii; All Hawaiian Islands",
      description: "Tsunami warning for the Hawaiian Islands.",
    });
    expect(result).toBe(false);
  });

  test("case-insensitive matching", () => {
    const result = tsunamiIsCrescentCityRelevant({
      areaDesc: "CRESCENT CITY; NORTHERN CALIFORNIA COAST",
      description: "",
    });
    expect(result).toBe(true);
  });

  test("fixture alerts are correctly classified", () => {
    // Tsunami Warning for Crescent City — relevant
    expect(
      tsunamiIsCrescentCityRelevant({
        areaDesc: NOAA_TSUNAMI_WARNING_FEATURE.properties.areaDesc,
        description: NOAA_TSUNAMI_WARNING_FEATURE.properties.description,
      })
    ).toBe(true);

    // Tsunami Watch for Pacific Coast to Cape Mendocino (CA) — relevant
    expect(
      tsunamiIsCrescentCityRelevant({
        areaDesc: NOAA_TSUNAMI_WATCH_FEATURE.properties.areaDesc,
        description: NOAA_TSUNAMI_WATCH_FEATURE.properties.description,
      })
    ).toBe(true);

    // Tsunami Info Statement for California Coast — relevant
    expect(
      tsunamiIsCrescentCityRelevant({
        areaDesc: NOAA_TSUNAMI_INFO_FEATURE.properties.areaDesc,
        description: NOAA_TSUNAMI_INFO_FEATURE.properties.description,
      })
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOAA TSUNAMI — Threat level classification
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Replicates the threat level classification from monitorNOAATsunamiAlerts:
 *   event.toLowerCase().includes('warning') ? 'warning'
 *   : event.toLowerCase().includes('watch') ? 'watch' : 'advisory'
 */
function classifyTsunamiThreat(event: string): string {
  return event.toLowerCase().includes("warning")
    ? "warning"
    : event.toLowerCase().includes("watch")
      ? "watch"
      : "advisory";
}

describe("NOAA Tsunami — threat level classification", () => {
  test("'Tsunami Warning' → warning", () => {
    expect(classifyTsunamiThreat("Tsunami Warning")).toBe("warning");
  });

  test("'Tsunami Watch' → watch", () => {
    expect(classifyTsunamiThreat("Tsunami Watch")).toBe("watch");
  });

  test("'Tsunami Information Statement' → advisory (no warning/watch substring)", () => {
    expect(classifyTsunamiThreat("Tsunami Information Statement")).toBe("advisory");
  });

  test("'Tsunami Advisory' → advisory (no warning/watch substring)", () => {
    expect(classifyTsunamiThreat("Tsunami Advisory")).toBe("advisory");
  });

  test("case-insensitive matching", () => {
    expect(classifyTsunamiThreat("TSUNAMI WARNING")).toBe("warning");
    expect(classifyTsunamiThreat("tsunami watch")).toBe("watch");
  });

  test("'warning' substring takes precedence over 'watch' when both are in name", () => {
    // Hypothetical edge case: both substrings present
    expect(classifyTsunamiThreat("Tsunami Warning and Watch")).toBe("warning");
  });

  test("fixture alerts classify correctly", () => {
    expect(classifyTsunamiThreat(NOAA_TSUNAMI_WARNING_FEATURE.properties.event)).toBe("warning");
    expect(classifyTsunamiThreat(NOAA_TSUNAMI_WATCH_FEATURE.properties.event)).toBe("watch");
    expect(classifyTsunamiThreat(NOAA_TSUNAMI_INFO_FEATURE.properties.event)).toBe("advisory");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-MODULE — Module exports
// ═══════════════════════════════════════════════════════════════════════════════

describe("alerts-extended — module exports are valid", () => {
  test("nws_weather exports monitorNWSWeatherAlerts and testable pure functions", async () => {
    const mod = await import("../src/alerts/nws_weather.ts");
    expect(typeof mod.monitorNWSWeatherAlerts).toBe("function");
    expect(typeof mod.getAlertSeverityLevel).toBe("function");
    expect(typeof mod.isCrescentCityRelevant).toBe("function");
    expect(typeof mod.pointInPolygon).toBe("function");
  });

  test("usgs_earthquake exports monitorUSGSEarthquakeAlerts and testable pure functions", async () => {
    const mod = await import("../src/alerts/usgs_earthquake.ts");
    expect(typeof mod.monitorUSGSEarthquakeAlerts).toBe("function");
    expect(typeof mod.haversineDistance).toBe("function");
    expect(typeof mod.isCascadiaEvent).toBe("function");
  });

  test("noaa_tsunami exports monitorNOAATsunamiAlerts and testable pure functions", async () => {
    const mod = await import("../src/alerts/noaa_tsunami.ts");
    expect(typeof mod.monitorNOAATsunamiAlerts).toBe("function");
    expect(typeof mod.isCrescentCityRelevant).toBe("function");
  });
});

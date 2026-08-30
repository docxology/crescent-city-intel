#!/usr/bin/env bun
/**
 * Caltrans Road Closure Monitor for Del Norte County.
 *
 * Fetches road closure and traffic incident data from Caltrans QuickMap
 * and checks for closures/restrictions on US-101 and US-199 in Del Norte
 * County and the Crescent City area.
 *
 * API: Caltrans QuickMap District 1 (https://quickmap.dot.ca.gov)
 *
 * Usage:
 *   bun run src/alerts/caltrans_roads.ts
 *
 * Output: output/alerts/roads/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

const logger = createLogger("caltrans_roads_alert");

/** Caltrans QuickMap API endpoint for statewide road incidents. */
export const CALTRANS_API_URL = "https://quickmap.dot.ca.gov/api/v1/incidents?format=json&status=active";
/** Alternative: Caltrans QuickMap API with District 1 filter. */
export const CALTRANS_API_D1_URL = "https://quickmap.dot.ca.gov/api/v1/incidents?district=1&format=json&status=active";
/**
 * Official Caltrans Highway Conditions network (roads.dot.ca.gov) — the text
 * system behind 1-800-427-7623. Verified live 2026-08-30: the QuickMap v1
 * incident API now serves an SPA shell (HTTP 200 + HTML, no JSON), so this
 * per-route text source is the PRIMARY fetch and the old JSON endpoints are
 * retained only as fallback attempts.
 */
export const CALTRANS_ROADS_TEXT_URL = "https://roads.dot.ca.gov/?roadnumber=";
const TEXT_ROUTES = ["101", "199", "169", "197", "299"]; // Del Norte routes on the highway-conditions text system

/** QuickMap public web URL */
export const CALTRANS_WEB_URL = "https://quickmap.dot.ca.gov";

const TARGET_ROUTES = ["US-101", "US-199", "101", "199", "SR-101", "SR-199"];
const TARGET_COUNTIES = ["Del Norte", "Humboldt", "Siskiyou"];
const CRESCENT_CITY_LAT = 41.7485;
const CRESCENT_CITY_LNG = -124.2028;
const SEARCH_RADIUS_KM = 60;

const HISTORY_DIR = join(process.cwd(), "output", "alerts", "roads");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
let lastRoadsError: string | undefined;

export function getLastRoadsError(): string | undefined {
  return lastRoadsError;
}

export type RoadClosureSeverity = "NONE" | "ADVISORY" | "WARNING" | "CLOSURE";

export interface RoadIncident {
  /** Incident ID */
  id: string;
  /** Route/road name */
  route: string;
  /** Location description */
  location: string;
  /** County */
  county: string;
  /** Incident type (closure, construction, hazard, etc.) */
  type: string;
  /** Severity classification */
  severity: RoadClosureSeverity;
  /** Description */
  description: string;
  /** Start time ISO */
  startedAt: string | null;
  /** Estimated end time ISO */
  estimatedEnd: string | null;
  /** Affected direction */
  direction: string | null;
  /** Distance from Crescent City (km) */
  distanceKm: number | null;
  /** Whether this is on a major Del Norte route */
  isDelNorteRoute: boolean;
}

export interface RoadClosureReport {
  timestamp: string;
  /** Active incidents */
  incidents: RoadIncident[];
  /** Total incidents found */
  totalIncidents: number;
  /** Incidents on major Del Norte routes */
  delNorteIncidents: RoadIncident[];
  /** Overall severity level */
  overallSeverity: RoadClosureSeverity;
  /** Whether US-101 or US-199 has a full closure */
  hasMajorClosure: boolean;
  /** Human-readable summary */
  summary: string;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const clamped = Math.max(0, Math.min(1, a));
  return R * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(HISTORY_FILE)) return ids;
  try {
    const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function appendHistory(incident: RoadIncident): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const record = JSON.stringify({ ...incident, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE, record);
  } catch (err) {
    logger.warn("Failed to append road closure history", { error: String(err) });
  }
}

export function classifyRoadSeverity(incidentType: string, description: string): RoadClosureSeverity {
  const combined = (incidentType + " " + description).toLowerCase();
  // "lane closed" is a lane-level restriction (ADVISORY), not a full road
  // closure — it must be checked before the generic "closed" substring match
  // or every lane closure would be misreported as CLOSURE.
  if (combined.includes("lane closed") || combined.includes("lane closure")) {
    return "ADVISORY";
  }
  if (combined.includes("closure") || combined.includes("closed") || combined.includes("road closed") || combined.includes("full closure")) {
    return "CLOSURE";
  }
  if (combined.includes("warning") || combined.includes("hazard") || combined.includes("accident") || combined.includes("flood") || combined.includes("slide") || combined.includes("blocked")) {
    return "WARNING";
  }
  if (combined.includes("advisory") || combined.includes("construction") || combined.includes("maintenance") || combined.includes("lane closed") || combined.includes("restriction")) {
    return "ADVISORY";
  }
  return "NONE";
}

function matchRoute(routeName: string): string | null {
  const r = routeName.trim().toUpperCase().replace(/\s+/g, " ");
  for (const target of TARGET_ROUTES) {
    if (r.includes(target.toUpperCase())) return target;
  }
  return null;
}

/** Fetch road incidents from Caltrans QuickMap. */
export async function fetchRoadIncidentsLegacy(): Promise<RoadIncident[]> {
  // Try District 1 endpoint first, fall back to statewide
  let errors: string[] = [];
  const urls = [CALTRANS_API_D1_URL, CALTRANS_API_URL];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        errors.push("QuickMap returned " + response.status + " from " + url);
        continue;
      }
      const payload = await response.json() as any;
      const rawIncidents: any[] = Array.isArray(payload)
        ? payload
        : payload?.incidents ?? payload?.data ?? payload?.results ?? [];

      const incidents: RoadIncident[] = [];
      for (const raw of rawIncidents) {
        const county = String(raw.county ?? raw.County ?? raw.affectedCounty ?? "");
        const matchesCounty = TARGET_COUNTIES.some(tc =>
          county.toLowerCase().includes(tc.toLowerCase())
        );
        if (!matchesCounty) continue;

        const routeName = String(raw.route ?? raw.Route ?? raw.roadName ?? raw.highway ?? "");
        const matchedRoute = matchRoute(routeName);

        let distanceKm: number | null = null;
        const latitude = Number(raw.latitude ?? raw.Latitude ?? raw.lat ?? 0);
        const longitude = Number(raw.longitude ?? raw.Longitude ?? raw.lng ?? 0);
        if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0) {
          distanceKm = haversineDistance(CRESCENT_CITY_LAT, CRESCENT_CITY_LNG, latitude, longitude);
          if (distanceKm > SEARCH_RADIUS_KM) continue;
        }

        const type = String(raw.type ?? raw.Type ?? raw.incidentType ?? raw.eventType ?? "");
        const description = String(raw.description ?? raw.Description ?? raw.details ?? raw.comments ?? "");
        const severity = classifyRoadSeverity(type, description);

        const inc: RoadIncident = {
          id: String(raw.id ?? raw.ID ?? raw.incidentId ?? raw.eventId ?? ""),
          route: matchedRoute ?? routeName,
          location: String(raw.location ?? raw.Location ?? raw.area ?? ""),
          county,
          type,
          severity,
          description,
          startedAt: raw.startedAt ?? raw.startDate ?? raw.StartDate ?? null,
          estimatedEnd: raw.estimatedEnd ?? raw.estimatedEndDate ?? null,
          direction: raw.direction ?? raw.Direction ?? null,
          distanceKm,
          isDelNorteRoute: matchedRoute !== null && county.toLowerCase().includes("del norte"),
        };
        incidents.push(inc);
      }
      return incidents;
    } catch (err) {
      errors.push("Failed to fetch from " + url + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  throw new Error("All QuickMap endpoints failed: " + errors.join("; "));
}

/**
 * Text-condition fetcher for one route: the official Caltrans Highway
 * Conditions network (the text system behind 1-800-427-7623). Verified live
 * 2026-08-30. Returns the report text starting at "reported as of".
 */
export async function fetchRouteConditionsText(route: string): Promise<string> {
  const response = await fetch(CALTRANS_ROADS_TEXT_URL + encodeURIComponent(route), {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("Caltrans highway-conditions returned " + response.status + " for route " + route);
  }
  const raw = await response.text();
  const noScripts = raw.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const text = noScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  const asOf = text.indexOf("reported as of");
  if (asOf === -1) {
    throw new Error("Caltrans highway-conditions response for route " + route + " had no condition report");
  }
  return text.slice(asOf);
}

/**
 * Parse one route's condition text into incidents. Condition sentences carry
 * their reporting county in parentheses - "(Del Norte Co)" - and severities
 * reuse the shared classifyRoadSeverity word list.
 */
export function parseRouteConditionText(route: string, text: string): RoadIncident[] {
  const incidents: RoadIncident[] = [];
  const chunks = text.split(/\[[^\]]*AREA\]/i).slice(1);
  const bodies = chunks.length > 0 ? chunks : [text];
  for (const body of bodies) {
    const sentences = body
      .replace(/\s+/g, " ")
      .split(/(?<=\))\s*-\s|(?<=\.)\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
    for (const sentence of sentences) {
      if (!/del norte/i.test(sentence)) continue;
      const countyMatch = sentence.match(/\(([^)]*Co\.?)\)/i);
      const lower = sentence.toLowerCase();
      const endMatch = text.match(/thru\s+\d{1,4}\s*hrs\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      incidents.push({
        id: "caltrans-text-" + route + "-" + sentence.slice(0, 48).replace(/\W+/g, "-").toLowerCase(),
        route: "Route " + route,
        location: countyMatch ? countyMatch[1].trim() : "Del Norte County",
        county: countyMatch ? countyMatch[1].trim() : "Del Norte",
        type: /closed/i.test(lower) ? "Closure" : /1-way|controlled traffic|construction/i.test(lower) ? "Construction" : "Advisory",
        severity: classifyRoadSeverity("Text", sentence),
        description: sentence,
        startedAt: null,
        estimatedEnd: endMatch ? endMatch[1] : null,
        direction: null,
        distanceKm: null,
        isDelNorteRoute: true,
      });
    }
  }
  return incidents;
}

/**
 * PRIMARY source: the per-route text system. The legacy QuickMap v1 JSON
 * endpoints run only when every text fetch failed - they now serve an SPA
 * shell (verified 2026-08-30) but are retained so a service restoration
 * needs no code change.
 */
export async function fetchRoadIncidents(): Promise<RoadIncident[]> {
  const results = await Promise.allSettled(
    TEXT_ROUTES.map(async route => parseRouteConditionText(route, await fetchRouteConditionsText(route))),
  );
  const incidents: RoadIncident[] = [];
  let failures = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const inc of result.value) incidents.push(inc);
    } else {
      failures++;
      logger.warn("Caltrans text fetch failed for one route", { error: String(result.reason) });
    }
  }
  if (failures < TEXT_ROUTES.length) return incidents;
  logger.warn("All Caltrans text routes failed; trying legacy QuickMap JSON");
  return await fetchRoadIncidentsLegacy();
}

/** Main monitor entry point */
export async function runRoadClosureMonitor(): Promise<RoadClosureReport | null> {
  logger.info("Checking Caltrans road closures for Del Norte County routes");
  lastRoadsError = undefined;

  try {
    const incidents = await fetchRoadIncidents();

    const delNorteIncidents = incidents.filter(i => i.isDelNorteRoute);
    const hasMajorClosure = delNorteIncidents.some(i => i.severity === "CLOSURE");

    let overallSeverity: RoadClosureSeverity = "NONE";
    for (const inc of incidents) {
      const scores: Record<RoadClosureSeverity, number> = { NONE: 0, ADVISORY: 1, WARNING: 2, CLOSURE: 3 };
      if (scores[inc.severity] > scores[overallSeverity]) {
        overallSeverity = inc.severity;
      }
    }

    const report: RoadClosureReport = {
      timestamp: new Date().toISOString(),
      incidents,
      totalIncidents: incidents.length,
      delNorteIncidents,
      overallSeverity,
      hasMajorClosure,
      summary: incidents.length === 0
        ? "No active road closures or incidents on Del Norte routes"
        : overallSeverity + ": " + incidents.length + " incident(s) (" +
          delNorteIncidents.length + " on Del Norte routes)" +
          (hasMajorClosure ? " — MAJOR CLOSURE ACTIVE" : "") +
          ". " + delNorteIncidents.map(i => i.route + ": " + i.description.slice(0, 60)).join("; "),
    };

    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);

    if (incidents.length > 0) {
      const processedIds = loadProcessedIds();
      for (const inc of incidents) {
        if (!processedIds.has(inc.id)) {
          appendHistory(inc);
        }
      }
    }

    if (hasMajorClosure) {
      logger.warn("ROAD CLOSURE: " + report.summary);
    } else if (overallSeverity === "WARNING") {
      logger.warn("Road hazard: " + report.summary);
    } else if (overallSeverity !== "NONE") {
      logger.info("Road advisory: " + report.summary);
    } else {
      logger.info("Road check: " + report.summary);
    }

    return report;
  } catch (err: any) {
    lastRoadsError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch road closure data", { error: lastRoadsError });
    return null;
  }
}

if (import.meta.main) {
  runRoadClosureMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Road closure monitor check failed --- see logs");
  });
}

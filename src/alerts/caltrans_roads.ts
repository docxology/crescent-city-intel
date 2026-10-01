#!/usr/bin/env bun
import { withProducerScope, type ProducerOptions } from "../shared/run_scope.js";
import { boundedHttpFetch as fetch } from "../shared/transport.js";
import { outputRoot } from "../shared/paths.js";
/**
 * Caltrans Road Closure Monitor for Del Norte County.
 *
 * Fetches road closure and traffic incident data from Caltrans Highway Conditions
 * and checks for closures/restrictions on US-101 and US-199 in Del Norte
 * County and the Crescent City area.
 *
 * Source: https://roads.dot.ca.gov per-route condition reports.
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

/**
 * Official Caltrans Highway Conditions network (roads.dot.ca.gov) — the text
 * system behind 1-800-427-7623. Each configured route must be checked before
 * the monitor reports complete coverage.
 */
export const CALTRANS_ROADS_TEXT_URL = "https://roads.dot.ca.gov/?roadnumber=";
const TEXT_ROUTES = ["101", "199", "169", "197", "299"]; // Del Norte routes on the highway-conditions text system

function HISTORY_DIR(): string { return join(outputRoot(), "alerts", "roads"); }
function HISTORY_FILE(): string { return join(HISTORY_DIR(), "history.jsonl"); }
function CURRENT_FILE(): string { return join(HISTORY_DIR(), "current.json"); }
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

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(HISTORY_FILE())) return ids;
  try {
    const lines = readFileSync(HISTORY_FILE(), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function appendHistory(incident: RoadIncident): void {
  try {
    mkdirSync(HISTORY_DIR(), { recursive: true });
    const record = JSON.stringify({ ...incident, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE(), record);
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
      // Scope the estimated-end match to THIS sentence. It used to match
      // against the whole route document outside the loop, so every incident
      // from a route was stamped with the first end time found anywhere in
      // that document — typically another closure's, and possibly belonging to
      // a different route entirely.
      const endMatch = sentence.match(/thru\s+\d{1,4}\s*hrs\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
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
 * Fetch Del Norte route conditions.
 *
 * Returns `null` when the coverage is incomplete: at least one route's fetch
 * failed (a transient error, or a route page with no "reported as of" anchor),
 * so the incidents we did collect are not a complete picture. A partial result
 * used to be returned as a *successful* report, so a US-101 closure invisible
 * to the surviving routes published as "No road incidents on Del Norte routes"
 * — a false calm on the region's single artery. `null` is what
 * `NULL_ON_FAILURE_MONITORS` maps to an unavailable source, so the composite and
 * the source-health record both say "unavailable" rather than "clear".
 */
export async function fetchRoadIncidents(): Promise<RoadIncident[] | null> {
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
  if (failures === 0) return incidents;
  logger.warn("Caltrans route coverage is incomplete; reporting unavailable", {
    failedRoutes: failures,
    totalRoutes: TEXT_ROUTES.length,
  });
  return null;
}

/** Main monitor entry point */
export async function runRoadClosureMonitor(options: ProducerOptions = {}): Promise<RoadClosureReport | null> { return withProducerScope("alert-caltrans-roads", options, () => runRoadClosureMonitorInScope()); }
async function runRoadClosureMonitorInScope(): Promise<RoadClosureReport | null> {
  logger.info("Checking Caltrans road closures for Del Norte County routes");
  lastRoadsError = undefined;

  try {
    const incidents = await fetchRoadIncidents();
    // Partial route coverage is not a clean bill of health. `null` here becomes
    // an unavailable source via NULL_ON_FAILURE_MONITORS, so the composite says
    // "unavailable" and the health record counts it missing — rather than
    // reporting CALM "No road incidents" from whatever subset did respond.
    if (incidents === null) {
      lastRoadsError = "incomplete Caltrans route coverage (at least one route fetch failed)";
      logger.error("Caltrans road coverage incomplete; reporting unavailable", { error: lastRoadsError });
      return null;
    }

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

    await mkdir(HISTORY_DIR(), { recursive: true });
    await writeJsonAtomic(CURRENT_FILE(), report);

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

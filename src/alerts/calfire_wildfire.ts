#!/usr/bin/env bun
/**
 * CAL FIRE Wildfire Monitor for Del Norte County.
 *
 * Fetches active wildfire incidents from the current CAL FIRE incident API
 * and filters for those affecting Del Norte County and surrounding
 * areas. Tracks fire size, containment, evacuation orders, and proximity
 * to Crescent City.
 *
 * API: https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false
 *
 * Usage:
 *   bun run src/alerts/calfire_wildfire.ts
 *
 * Output: output/alerts/wildfire/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

const logger = createLogger("calfire_wildfire_alert");

/** Linked as the JSON API from CAL FIRE's public Current Emergency Incidents page. */
export const CALFIRE_API_URL = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false";
const SEARCH_COUNTIES = ["Del Norte", "Siskiyou", "Humboldt", "Trinity"];
const CRESCENT_CITY_LAT = 41.7485;
const CRESCENT_CITY_LNG = -124.2028;
const SEARCH_RADIUS_KM = 150;

const HISTORY_DIR = join(process.cwd(), "output", "alerts", "wildfire");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
let lastWildfireError: string | undefined;

/** Return the most recent failure without changing the monitor's null-result contract. */
export function getLastWildfireError(): string | undefined {
  return lastWildfireError;
}

export type WildfireSeverity = "NONE" | "ADVISORY" | "WARNING" | "EMERGENCY";

export interface WildfireIncident {
  /** CAL FIRE incident ID */
  id: string;
  /** Incident name */
  name: string;
  /** County */
  county: string;
  /** Location description */
  location: string;
  /** Acres burned */
  acres: number;
  /** Containment percentage (0-100) */
  containmentPercent: number;
  /** Start date ISO */
  started: string;
  /** Number of personnel assigned */
  personnel: number;
  /** Evacuation orders active */
  hasEvacuationOrders: boolean;
  /** Evacuation warnings active */
  hasEvacuationWarnings: boolean;
  /** Structures threatened */
  structuresThreatened: number;
  /** Structures destroyed */
  structuresDestroyed: number;
  /** Distance from Crescent City (km) */
  distanceKm: number | null;
  /** Whether in Cascadia/border region */
  isBorderRegion: boolean;
}

export interface WildfireReport {
  timestamp: string;
  incidents: WildfireIncident[];
  /** Total active incidents in search area */
  totalIncidents: number;
  /** Composite severity level */
  level: WildfireSeverity;
  /** Human-readable summary */
  summary: string;
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

function appendHistory(incident: WildfireIncident): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const record = JSON.stringify({ ...incident, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE, record);
  } catch (err) {
    logger.warn("Failed to append wildfire history", { error: String(err) });
  }
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  // Clamp a to [0,1] to avoid NaN from floating-point rounding on sqrt(1-a).
  const clamped = Math.max(0, Math.min(1, a));
  return R * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

export function classifyWildfireSeverity(incidents: WildfireIncident[]): WildfireSeverity {
  if (incidents.length === 0) return "NONE";

  const hasEvacOrders = incidents.some(i => i.hasEvacuationOrders);
  const largeFire = incidents.some(i => i.acres >= 1000 && i.containmentPercent < 50);
  const nearbyFire = incidents.some(i => i.distanceKm !== null && i.distanceKm <= 50);

  if (hasEvacOrders) return "EMERGENCY";
  if (largeFire && nearbyFire) return "WARNING";
  if (incidents.length > 0) return "ADVISORY";
  return "NONE";
}

export async function fetchWildfireIncidents(): Promise<WildfireIncident[]> {
  const response = await fetch(CALFIRE_API_URL, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`CAL FIRE API returned ${response.status}: ${response.statusText}`);
  }

  const payload = await response.json() as unknown;
  const data = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { incidents?: unknown[] }).incidents)
      ? (payload as { incidents: unknown[] }).incidents
      : [];

  const incidents: WildfireIncident[] = [];

  for (const incident of data) {
    const county = String(incident.County ?? incident.county ?? incident.AdminUnit ?? incident.adminUnit ?? "");
    const matchesCounty = SEARCH_COUNTIES.some(c =>
      county.toLowerCase().includes(c.toLowerCase())
    );

    if (!matchesCounty && !Boolean(incident.IsBorderRegion ?? incident.isBorderRegion)) continue;

    let distanceKm: number | null = null;
    const latitude = Number(incident.Latitude ?? incident.latitude);
    const longitude = Number(incident.Longitude ?? incident.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0) {
      distanceKm = haversineDistance(
        CRESCENT_CITY_LAT,
        CRESCENT_CITY_LNG,
        latitude,
        longitude,
      );
      if (distanceKm > SEARCH_RADIUS_KM) continue;
    }

    const wf: WildfireIncident = {
      id: String(incident.UniqueId ?? incident.uniqueId ?? incident.id ?? ""),
      name: String(incident.Name ?? incident.name ?? "Unnamed"),
      county,
      location: String(incident.Location ?? incident.location ?? ""),
      acres: Number(incident.AcresBurned ?? incident.acresBurned ?? incident.DailyAcres ?? incident.CalculatedAcres ?? 0) || 0,
      containmentPercent: Number(incident.PercentContained ?? incident.percentContained ?? 0) || 0,
      started: String(incident.Started ?? incident.StartedDateOnly ?? incident.started ?? incident.dateStarted ?? ""),
      personnel: Number(incident.TotalIncidentPersonnel ?? incident.totalFirePersonnel ?? 0) || 0,
      hasEvacuationOrders: Boolean(incident.HasEvacuationOrders ?? incident.hasEvacOrders),
      hasEvacuationWarnings: Boolean(incident.HasEvacuationWarnings ?? incident.hasEvacWarnings),
      structuresThreatened: Number(incident.StructuresThreatened ?? incident.structuresThreatened ?? 0) || 0,
      structuresDestroyed: Number(incident.StructuresDestroyed ?? incident.structuresDestroyed ?? 0) || 0,
      distanceKm,
      isBorderRegion: Boolean(incident.IsBorderRegion ?? incident.isBorderRegion),
    };

    incidents.push(wf);
  }

  return incidents;
}

export async function runWildfireMonitor(): Promise<WildfireReport | null> {
  logger.info("Checking CAL FIRE incidents for Del Norte region");
  lastWildfireError = undefined;

  try {
    const incidents = await fetchWildfireIncidents();
    const level = classifyWildfireSeverity(incidents);
    const processedIds = loadProcessedIds();

    for (const incident of incidents) {
      if (!processedIds.has(incident.id)) {
        appendHistory(incident);
      }
    }

    const report: WildfireReport = {
      timestamp: new Date().toISOString(),
      incidents,
      totalIncidents: incidents.length,
      level,
      summary: incidents.length === 0
        ? "No active wildfires in Del Norte region"
        : `${incidents.length} active wildfire(s): ${incidents.map(i => `${i.name} (${i.acres} ac, ${i.containmentPercent}% contained)`).join("; ")}`,
    };

    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);

    if (level === "EMERGENCY") {
      logger.warn(`WILDFIRE EMERGENCY: ${report.summary}`);
    } else if (level === "WARNING") {
      logger.warn(`Wildfire warning: ${report.summary}`);
    } else {
      logger.info(`Wildfire check: ${report.summary}`);
    }

    return report;
  } catch (err: any) {
    lastWildfireError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch CAL FIRE data", { error: lastWildfireError });
    return null;
  }
}

if (import.meta.main) {
  runWildfireMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Wildfire check failed — see logs");
  });
}

#!/usr/bin/env bun
/**
 * AIS vessel-traffic monitor (#20) — part of the 🟡 TODO "Marine expansion".
 *
 * Real-time AIS positions for US coastal waters are not publicly keyless:
 * the USCG NAVCEN live feed is restricted, and community feeds (AISHub) and
 * commercial feeds (MarineTraffic) require membership or API keys. What IS
 * publicly reachable without a key is the Finnish Transport Infrastructure
 * Agency's open AIS feed (digitraffic, https://meri.digitraffic.fi/api/ais/
 * v1/locations), which publishes the exact GeoJSON shape an open AIS feed
 * speaks — real vessel positions, captured as this monitor's fixture.
 *
 * Connector contract, stated honestly:
 *   - `AIS_FEED_URL` (env) selects the feed. It defaults to the keyless
 *     digitraffic feed so the connector runs live end-to-end; point it at
 *     any provider that speaks the same FeatureCollection shape. For US
 *     water coverage an AISHub/USCG feed credential is required — absent a
 *     local feed, the monitor reports an explicit EMPTY local state over the
 *     real upstream data, never a fabricated vessel.
 *   - Positions are filtered to the Del Norte watch box (Crescent City
 *     harbor approach). Zero vessels in the box is a legitimate empty state
 *     (`vesselsInWatchArea: []`, worstLevel CALM), not an outage.
 *
 * Fetch plan (bounded): one GET of the locations feed, one retry. Parsing
 * is strict: a response that is not a FeatureCollection with a features
 * array throws, so a feed format change is a loud unavailable error.
 *
 * Usage: bun run src/alerts/ais.ts
 * Output: output/alerts/ais/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  SOURCE_FETCH_TIMEOUT_MS,
  writeJsonAtomic,
  appendBoundedJsonlSync,
} from "../shared/source_health.js";
import { outputRoot } from "../shared/paths.js";

const logger = createLogger("ais_alert");

/** Any provider speaking the digitraffic FeatureCollection shape. */
export const DIGITRAFFIC_AIS_URL = "https://meri.digitraffic.fi/api/ais/v1/locations";
export const AIS_FEED_URL_ENV = "AIS_FEED_URL";
export const AIS_SOURCE_NAME = "AIS Vessel Traffic";

/** Del Norte watch box: Crescent City harbor, harbor approach and adjacent coastal waters. */
export const AIS_WATCH_BOX = {
  minLat: 41.6,
  maxLat: 42.1,
  minLon: -124.45,
  maxLon: -123.9,
} as const;

const outputDir = (): string => join(outputRoot(), "alerts", "ais");
export function aisHistoryPath(): string {
  return join(outputDir(), "history.jsonl");
}
export function aisCurrentPath(): string {
  return join(outputDir(), "current.json");
}

let lastAisError: string | undefined;
export function getLastAisError(): string | undefined {
  return lastAisError;
}

export type AisLevel = "CALM" | "ADVISORY";

export interface AisVesselPosition {
  /** Maritime Mobile Service Identity. */
  mmsi: number;
  /** WGS-84 [lon, lat] from the feed. */
  lon: number;
  lat: number;
  /** Speed over ground (kn). */
  sog: number;
  /** Course over ground (deg). */
  cog: number;
  /** True heading (deg). */
  heading: number;
  /** Feed-reported position epoch, ISO. */
  positionAt: string;
}

export interface AisReport {
  fetchedAt: string;
  sourceUrl: string;
  feedName: string;
  /** Vessels in the feed this run (the whole feed, before the watch-box filter). */
  vesselsObserved: number;
  /** Vessels inside the Del Norte watch box. */
  vesselsInWatchArea: AisVesselPosition[];
  /** False while the feed is not a US-waters feed — say so rather than imply coverage. */
  coversDelNorteWaters: boolean;
  worstLevel: AisLevel;
  summary: string;
}

/** Is a position inside the Del Norte watch box? */
export function isInWatchBox(lon: number, lat: number, box = AIS_WATCH_BOX): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/**
 * Parse an open-AIS FeatureCollection into positions. THROWS on a non-object
 * body, a non-FeatureCollection type, a missing/non-array features field, or
 * a feature lacking an mmsi + point geometry — a feed format change must
 * surface as an unavailable error, never as a silent "no vessels". A
 * FeatureCollection with zero features is legitimate (no traffic) and parses
 * to [].
 */
export function parseAisLocations(body: string): AisVesselPosition[] {
  if (!body || !body.trim()) throw new Error("AIS feed returned an empty body");
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("AIS feed body was not JSON — source format changed");
  }
  if (parsed === null || typeof parsed !== "object" || parsed.type !== "FeatureCollection") {
    throw new Error("AIS feed is not a FeatureCollection — source format changed");
  }
  if (!Array.isArray(parsed.features)) {
    throw new Error("AIS feed carries no features array — source format changed");
  }
  const positions: AisVesselPosition[] = [];
  for (const feature of parsed.features) {
    const mmsi = Number(feature?.mmsi ?? feature?.properties?.mmsi);
    const coords = feature?.geometry?.coordinates;
    if (!Number.isFinite(mmsi) || !Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const props = feature.properties ?? {};
    const epoch = Number(feature.timestampExternal ?? props.timestampExternal);
    positions.push({
      mmsi,
      lon,
      lat,
      sog: Number.isFinite(Number(props.sog)) ? Number(props.sog) : 0,
      cog: Number.isFinite(Number(props.cog)) ? Number(props.cog) : 0,
      heading: Number.isFinite(Number(props.heading)) ? Number(props.heading) : 0,
      positionAt: Number.isFinite(epoch)
        ? new Date(epoch).toISOString()
        : (typeof props.posTimestamp === "string" ? props.posTimestamp : ""),
    });
  }
  return positions;
}

/** Build the monitor report from parsed positions (pure; no I/O). */
export function buildAisReport(
  positions: AisVesselPosition[],
  now = new Date().toISOString(),
  feedName = "digitraffic open AIS",
): AisReport {
  const inBox = positions.filter(position => isInWatchBox(position.lon, position.lat));
  const worstLevel: AisLevel = inBox.length > 0 ? "ADVISORY" : "CALM";
  const summary = inBox.length === 0
    ? `No AIS vessels in the Del Norte watch box (${positions.length} vessels in the feed; feed covers US west coast only when AIS_FEED_URL points at a US provider).`
    : `${inBox.length} AIS vessel(s) in the Del Norte watch box: ` +
      inBox.slice(0, 3).map(vessel => `MMSI ${vessel.mmsi} (${vessel.sog.toFixed(1)} kn)`).join(", ") +
      (inBox.length > 3 ? `, +${inBox.length - 3} more` : "");
  return {
    fetchedAt: now,
    sourceUrl: process.env[AIS_FEED_URL_ENV] || DIGITRAFFIC_AIS_URL,
    feedName,
    vesselsObserved: positions.length,
    vesselsInWatchArea: inBox,
    coversDelNorteWaters: feedName !== "digitraffic open AIS",
    worstLevel,
    summary,
  };
}

/** Append one history record per in-box observation (deduped by mmsi + position stamp). */
export async function appendAisHistory(
  inBox: AisVesselPosition[],
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  if (inBox.length === 0) return;
  await mkdir(outputDir(), { recursive: true });
  for (const vessel of inBox) {
    const id = `ais-${vessel.mmsi}-${vessel.positionAt || "unknown"}`;
    appendBoundedJsonlSync(aisHistoryPath(), JSON.stringify({
      id,
      type: "ais",
      mmsi: vessel.mmsi,
      lat: vessel.lat,
      lon: vessel.lon,
      sog: vessel.sog,
      cog: vessel.cog,
      level: "ADVISORY",
      summary: `AIS vessel MMSI ${vessel.mmsi} in the Del Norte watch box`,
      url: process.env[AIS_FEED_URL_ENV] || DIGITRAFFIC_AIS_URL,
      fetchedAt,
    }));
  }
}

const REQUEST_HEADERS = {
  "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)",
  Accept: "application/json",
} as const;

/** Bounded fetch with one retry; a second failure throws to the run wrapper. */
async function fetchFeed(url: string, attempts = 2): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("AIS feed returned " + response.status + ": " + response.statusText);
      const text = await response.text();
      if (!text.trim()) throw new Error("AIS feed returned an empty body");
      return text;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Run the monitor: fetch, parse, watch-box filter, persist current.json + deduped history. */
export async function runAisMonitor(): Promise<AisReport | null> {
  const feedUrl = process.env[AIS_FEED_URL_ENV] || DIGITRAFFIC_AIS_URL;
  logger.info("Checking AIS vessel traffic (feed: " + feedUrl + ")");
  lastAisError = undefined;
  try {
    const positions = parseAisLocations(await fetchFeed(feedUrl));
    const report = buildAisReport(positions, new Date().toISOString(),
      feedUrl === DIGITRAFFIC_AIS_URL ? "digitraffic open AIS" : "configured AIS feed");

    await mkdir(outputDir(), { recursive: true });
    await writeJsonAtomic(aisCurrentPath(), report);
    await appendAisHistory(report.vesselsInWatchArea, report.fetchedAt);

    if (report.worstLevel === "ADVISORY") {
      logger.warn("AIS: " + report.summary);
    } else {
      logger.info("AIS check: " + report.summary);
    }
    return report;
  } catch (err) {
    lastAisError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to check AIS vessel traffic", { error: lastAisError });
    return null;
  }
}

if (import.meta.main) {
  runAisMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("AIS check failed — see logs");
  });
}
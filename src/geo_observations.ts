/**
 * GEO-INFER hazard-observation interface (`crescent-city-geo-observations/v1`).
 *
 * Companion surface to the frozen `crescent-city-geo-intel/v1` contract
 * (src/geo.ts): where the contract answers "what is the municipal hazard
 * policy surface", this envelope answers "what is the LIVE hazard state" —
 * the composite alert snapshot, per-monitor source health, and a hazard-tag
 * summary projected from the contract's hazard-relevant domain subset.
 *
 * Designed for external geospatial consumers (GEO-INFER-BAYES / -ACT /
 * -RISK): every field is either passed in or an honest empty state
 * (`composite: null`, `monitors: []`) — absent artifacts never become
 * invented values. The builder is PURE: it takes plain data and returns a
 * JSON-safe envelope with no filesystem, clock, or network access. The
 * filesystem seam lives in `scripts/run-geo-observations.ts`, which loads
 * the composite + source-health artifacts and passes `generatedAt` in.
 *
 * Sibling adoption mirrors `geo_infer_bayes.civic_intel.load_crescent_city_intel`:
 * load the JSON artifact at its documented path and read the envelope fields.
 */
import { CRESCENT_CITY_ANCHOR } from "./geo.js";
import type { SourceHealth, SourceHealthStatus } from "./types.js";

/** Output schema id for this envelope (registered as GET /api/geo-observations). */
export const GEO_OBSERVATIONS_SCHEMA = "crescent-city-geo-observations/v1";

/** Schema id of the upstream geo-intel contract this envelope stays fresh against. */
export const GEO_INTEL_CONTRACT_SCHEMA = "crescent-city-geo-intel/v1";

/** Anchor fields shared with the geo-intel contract (point identity; no bounds). */
export interface ObservationAnchor {
  /** Human-readable municipal name (e.g. "Crescent City"). */
  name: string;
  /** Municipal-code platform guid (e.g. ecode360 code). */
  guid: string;
  /** "City, State" display string. */
  municipality: string;
  /** County (or equivalent) containing the municipality. */
  county: string;
  /** State / province. */
  state: string;
  /** Decimal degrees WGS84 centroid. */
  latitude: number;
  longitude: number;
}

/** Normalized composite severity snapshot carried in the envelope. */
export interface CompositeSnapshot {
  /** Composite level: CALM | WATCH | WARNING | EMERGENCY. */
  level: string;
  /** Human-readable reason for the composite level. */
  reason: string;
  /** ISO-8601 assessment timestamp; null when the artifact omitted it. */
  assessedAt: string | null;
  /** True when one or more source feeds could not be checked. */
  hasUnavailableMonitors: boolean;
}

/** One monitor's normalized observation entry (public envelope shape). */
export interface MonitorObservation {
  /** Stable slug id derived from the source name (e.g. "noaa-tsunami"). */
  id: string;
  /** Human-readable monitor label (the SourceHealth source name). */
  label: string;
  /** Operational status, lower-cased; unrecognized values degrade to "unavailable". */
  status: SourceHealthStatus;
  /** ISO-8601 check timestamp; null when not recorded. */
  checkedAt: string | null;
  /** Item count reported by the monitor, when known. */
  itemCount?: number;
  /** Age of the observation in whole milliseconds, when known. */
  ageMs?: number;
  /** Monitored endpoint URL, when recorded. */
  url?: string;
}

/** Hazard-relevant domain slice of the geo-intel contract (builder input). */
export interface HazardDomainInput {
  /** Domain id (e.g. "emergency-management"). */
  id?: string;
  /** Domain display name. */
  name?: string;
  /** Domain-level hazard tags; derived from topics when absent. */
  hazardTags?: string[];
  /** Hazard-tagged topics with their tags. */
  topics?: Array<{ tags?: string[] }>;
}

/** Per-tag aggregation over the contract's hazard-relevant domains. */
export interface HazardTagSummary {
  /** Hazard tag (e.g. "tsunami"). */
  tag: string;
  /** Number of hazard-relevant domains referencing the tag. */
  domainCount: number;
  /** Number of hazard-tagged topics carrying the tag. */
  topicCount: number;
}

/** Fully-typed pure-builder input. No clock, no filesystem. */
export interface GeoObservationInput {
  /** Municipality anchor (same shape as the geo-intel contract's anchor). */
  anchor: ObservationAnchor;
  /** Envelope timestamp — passed in by the runner, never `Date.now()` here. */
  generatedAt: string;
  /** Composite severity snapshot, or null when the artifact is absent/unreadable. */
  composite: CompositeSnapshot | null;
  /** Normalized per-monitor entries; empty when source health is absent. */
  monitors: MonitorObservation[];
  /** Hazard-relevant domain subset of the geo-intel contract. */
  hazardDomains: HazardDomainInput[];
  /** Upstream contract's generatedAt, or null when the contract is absent. */
  contractGeneratedAt: string | null;
}

/** The `crescent-city-geo-observations/v1` envelope. */
export interface GeoObservationsEnvelope {
  schema: typeof GEO_OBSERVATIONS_SCHEMA;
  anchor: ObservationAnchor;
  generatedAt: string;
  /** Composite snapshot, or null when no composite artifact exists. */
  composite: CompositeSnapshot | null;
  /** Per-monitor observations; empty when no source-health artifact exists. */
  monitors: MonitorObservation[];
  /** Per-tag aggregation of the contract's hazard subset. */
  hazardSummary: HazardTagSummary[];
  /** Freshness of the upstream `crescent-city-geo-intel/v1` contract. */
  freshness: {
    contractSchema: typeof GEO_INTEL_CONTRACT_SCHEMA;
    contractGeneratedAt: string | null;
  };
}

/**
 * The Crescent City anchor projected to the observation shape — the same
 * literals as `CRESCENT_CITY_ANCHOR` minus `bounds`, which the point-identity
 * envelope does not carry. Runners fall back to this when the contract
 * artifact is absent.
 */
export const DEFAULT_OBSERVATION_ANCHOR: ObservationAnchor = {
  name: CRESCENT_CITY_ANCHOR.name,
  guid: CRESCENT_CITY_ANCHOR.guid,
  municipality: CRESCENT_CITY_ANCHOR.municipality,
  county: CRESCENT_CITY_ANCHOR.county,
  state: CRESCENT_CITY_ANCHOR.state,
  latitude: CRESCENT_CITY_ANCHOR.latitude,
  longitude: CRESCENT_CITY_ANCHOR.longitude,
};

/** Normalize a monitor source name to a stable slug id ("NWS Weather" → "nws-weather"). */
export function monitorId(source: string): string {
  return source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const VALID_STATUSES: Record<string, true> = { ok: true, empty: true, unavailable: true, stale: true };

/**
 * Normalize one raw SourceHealth record into a MonitorObservation. Status is
 * lower-cased and validated against the four operational states — an
 * unrecognized value degrades to "unavailable" (state could not be
 * established) rather than being passed through or invented. `ageMs` is
 * rounded to a whole number for compact output.
 */
export function normalizeMonitorObservation(health: SourceHealth): MonitorObservation {
  const rawStatus = typeof health?.status === "string" ? health.status.toLowerCase() : "";
  const status: SourceHealthStatus = VALID_STATUSES[rawStatus]
    ? (rawStatus as SourceHealthStatus)
    : "unavailable";
  const entry: MonitorObservation = {
    id: monitorId(health?.source ?? ""),
    label: health?.source ?? "",
    status,
    checkedAt: typeof health?.checkedAt === "string" ? health.checkedAt : null,
  };
  if (typeof health?.itemCount === "number") entry.itemCount = health.itemCount;
  if (typeof health?.ageMs === "number") entry.ageMs = Math.round(health.ageMs);
  if (typeof health?.url === "string" && health.url.length > 0) entry.url = health.url;
  return entry;
}

/**
 * Normalize an unknown composite artifact (`output/alerts/composite/current.json`)
 * into a typed snapshot. Returns null for anything that is not an object with
 * a string level — an absent or corrupt artifact is an honest empty state,
 * never a fabricated CALM.
 */
export function normalizeCompositeSnapshot(raw: unknown): CompositeSnapshot | null {
  if (raw == null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.level !== "string") return null;
  return {
    level: record.level,
    reason: typeof record.reason === "string" ? record.reason : "",
    assessedAt: typeof record.assessedAt === "string" ? record.assessedAt : null,
    hasUnavailableMonitors: record.hasUnavailableMonitors === true,
  };
}

/**
 * Aggregate the contract's hazard-relevant domain subset into a per-tag
 * summary, sorted by tag for deterministic output. `domainCount` counts
 * domains referencing the tag (hazardTags or any topic tag); `topicCount`
 * counts individual hazard-tagged topics carrying it.
 */
export function hazardTagSummary(domains: HazardDomainInput[]): HazardTagSummary[] {
  const domainCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const domain of domains) {
    const domainTags = new Set<string>();
    for (const tag of domain.hazardTags ?? []) {
      const key = tag.toLowerCase().trim();
      if (key) domainTags.add(key);
    }
    for (const topic of domain.topics ?? []) {
      const topicTags = new Set<string>();
      for (const tag of topic.tags ?? []) {
        const key = tag.toLowerCase().trim();
        if (!key) continue;
        domainTags.add(key);
        topicTags.add(key);
      }
      for (const tag of topicTags) topicCounts.set(tag, (topicCounts.get(tag) ?? 0) + 1);
    }
    for (const tag of domainTags) domainCounts.set(tag, (domainCounts.get(tag) ?? 0) + 1);
  }
  return [...new Set([...domainCounts.keys(), ...topicCounts.keys()])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((tag) => ({ tag, domainCount: domainCounts.get(tag) ?? 0, topicCount: topicCounts.get(tag) ?? 0 }));
}

/**
 * Build the `crescent-city-geo-observations/v1` envelope. Pure and
 * deterministic: identical inputs yield identical output; absent artifacts
 * are passed as `null` / `[]` and surface as honest empty states.
 *
 * The wave-2 route agent imports this for `GET /api/geo-observations`.
 */
export function buildHazardObservations(input: GeoObservationInput): GeoObservationsEnvelope {
  return {
    schema: GEO_OBSERVATIONS_SCHEMA,
    anchor: input.anchor,
    generatedAt: input.generatedAt,
    composite: input.composite,
    monitors: input.monitors,
    hazardSummary: hazardTagSummary(input.hazardDomains),
    freshness: {
      contractSchema: GEO_INTEL_CONTRACT_SCHEMA,
      contractGeneratedAt: input.contractGeneratedAt,
    },
  };
}

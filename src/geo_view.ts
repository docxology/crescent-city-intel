#!/usr/bin/env bun
/**
 * Crescent City geospatial view-assembler.
 *
 * Turns the machine-readable geo-intel contract (src/geo.ts → buildGeoIntel)
 * into a map-ready feature surface — a Del Norte County bounds polygon, the
 * Crescent City anchor point, one point per hazard-relevant civic domain, and
 * the flattened municipal-code section list — WITHOUT requiring any tiles
 * provider. A client (the GUI panel, a static export, or an external map) can
 * render the returned GeoJSON-shaped features directly onto a blank canvas or
 * any projection.
 *
 * The builder is a PURE function (`buildGeoView`): it takes a geo-intel
 * contract object and returns a plain JSON-safe structure with no filesystem
 * or network side effects. Tests exercise it in isolation.
 *
 * Honest placement note: the contract carries the city anchor + Del Norte
 * bounds but no per-domain coordinates. Hazard-domain points are therefore
 * placed at deterministic, anchor-relative offsets (a nominal cluster around
 * the city center) so they render as distinct markers without fabricating
 * surveyed locations — each feature carries `nominal: true` to make that visible.
 */
import { CRESCENT_CITY_ANCHOR } from "./geo.js";

// ─── Feature view output types ──────────────────────────────────────────
export interface GeoBoundsFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties: {
    kind: "bounds";
    label: string;
    west: number;
    south: number;
    east: number;
    north: number;
  };
}
export interface GeoPointFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: number[] };
  properties: {
    kind: "anchor" | "hazard-domain";
    label: string;
    name: string;
    icon: string;
    hazardTags: string[];
    sectionCount: number;
    nominal: boolean;
  };
}
export interface GeoSectionRef {
  sectionNumber: string;
  relevance: string;
  domains: string[];
  topics: string[];
}
export interface GeoIntelView {
  schema: string;
  crs: { type: string; properties: { name: string } };
  anchor: {
    name: string;
    municipality: string;
    county: string;
    state: string;
    latitude: number;
    longitude: number;
    bounds: { west: number; south: number; east: number; north: number };
  };
  generatedAt?: string;
  features: Array<GeoBoundsFeature | GeoPointFeature>;
  hazard: { domainCount: number; hazardTags: string[]; topHazardTags: string[] };
  sections: GeoSectionRef[];
}

// ─── Contract input shape (defensive — the raw contract is `Record<...>`) ──
interface ContractTopic {
  name: string;
  tags: string[];
  sections: Array<{ sectionNumber: string; relevance: string }>;
}
interface ContractDomain {
  id: string;
  name: string;
  icon: string;
  hazardTags: string[];
  topics: ContractTopic[];
}
interface ContractInput {
  schema: string;
  anchor: {
    name: string;
    municipality: string;
    county: string;
    state: string;
    latitude: number;
    longitude: number;
    bounds: { west: number; south: number; east: number; north: number };
  };
  generatedAt?: string;
  hazardDomains: ContractDomain[];
}

/** Deterministic anchor-relative marker offsets (in decimal degrees) so
 * hazard-domain points render as a distinct cluster around the city center. */
const HAZARD_OFFSETS: Array<[number, number]> = [
  [0.000, 0.000],
  [0.010, 0.006],
  [0.012, -0.010],
  [-0.010, 0.008],
  [0.012, 0.014],
  [-0.012, -0.008],
  [0.016, 0.000],
  [-0.006, 0.016],
  [0.010, -0.014],
  [-0.016, 0.006],
  [0.000, -0.016],
  [-0.010, -0.014],
];

/** Normalize an unknown contract payload into a typed, defensively-populated input. */
function normalizeContractInput(raw: Record<string, unknown>): ContractInput {
  const anchor = (raw.anchor ?? {}) as Record<string, unknown>;
  const bounds = (anchor.bounds ?? {}) as Record<string, unknown>;
  const hazard = (raw.hazard ?? {}) as Record<string, unknown>;
  const asString = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  const asNumber = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const asRecordArray = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const hazardDomains: ContractDomain[] = asRecordArray(hazard.relevantDomains).map((d) => {
    const topics: ContractTopic[] = asRecordArray(d.topics).map((t) => ({
      name: asString(t.name, "Untitled topic"),
      tags: asStringArray(t.tags),
      sections: asRecordArray(t.sections).map((s) => ({
        sectionNumber: asString(s.sectionNumber, ""),
        relevance: asString(s.relevance, ""),
      })),
    }));
    return {
      id: asString(d.id, "unknown-domain"),
      name: asString(d.name, "Unknown Domain"),
      icon: asString(d.icon, "📌"),
      hazardTags: asStringArray(d.hazardTags),
      topics,
    };
  });

  return {
    schema: asString(raw.schema, "crescent-city-geo-intel/v1"),
    anchor: {
      name: asString(anchor.name, CRESCENT_CITY_ANCHOR.name),
      municipality: asString(anchor.municipality, CRESCENT_CITY_ANCHOR.municipality),
      county: asString(anchor.county, CRESCENT_CITY_ANCHOR.county),
      state: asString(anchor.state, CRESCENT_CITY_ANCHOR.state),
      latitude: asNumber(anchor.latitude, CRESCENT_CITY_ANCHOR.latitude),
      longitude: asNumber(anchor.longitude, CRESCENT_CITY_ANCHOR.longitude),
      bounds: {
        west: asNumber(bounds.west, CRESCENT_CITY_ANCHOR.bounds.west),
        south: asNumber(bounds.south, CRESCENT_CITY_ANCHOR.bounds.south),
        east: asNumber(bounds.east, CRESCENT_CITY_ANCHOR.bounds.east),
        north: asNumber(bounds.north, CRESCENT_CITY_ANCHOR.bounds.north),
      },
    },
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : undefined,
    // Derive the domain count from the array so the view is self-consistent
    // even if the contract's `relevantDomainCount` ever drifted.
    hazardDomains,
  };
}

/** Round a coordinate to 6 decimal places (~0.11 m) for stable / compact output. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Count municipal-code sections referenced across a domain's hazard topics. */
function domainSectionCount(topics: ContractTopic[]): number {
  return topics.reduce((n, topic) => n + topic.sections.length, 0);
}

/**
 * Build the map-ready Crescent City geo view from a geo-intel contract.
 *
 * @param raw The output of `buildGeoIntel()` (or any schema-compatible object).
 * @returns A JSON-safe feature view: Del Norte bounds polygon + city anchor
 *   point + one point per hazard-relevant civic domain, plus aggregated
 *   municipal-code section references.
 */
export function buildGeoView(raw: Record<string, unknown>): GeoIntelView {
  const input = normalizeContractInput(raw);
  const a = input.anchor;

  // 1. Del Norte County bounds → a closed 4-vertex Polygon ring (GeoJSON rectangle).
  const boundsFeature: GeoBoundsFeature = {
    type: "Feature",
    id: "del-norte-bounds",
    geometry: {
      type: "Polygon",
      coordinates: [[
        [a.bounds.west, a.bounds.south],
        [a.bounds.east, a.bounds.south],
        [a.bounds.east, a.bounds.north],
        [a.bounds.west, a.bounds.north],
        [a.bounds.west, a.bounds.south],
      ]],
    },
    properties: {
      kind: "bounds",
      label: "Del Norte County extent",
      west: a.bounds.west,
      south: a.bounds.south,
      east: a.bounds.east,
      north: a.bounds.north,
    },
  };

  // 2. City anchor point.
  const anchorFeature: GeoPointFeature = {
    type: "Feature",
    id: "city-anchor",
    geometry: { type: "Point", coordinates: [a.longitude, a.latitude] },
    properties: {
      kind: "anchor",
      label: `${a.name} — ${a.municipality}`,
      name: a.name,
      icon: "📍",
      hazardTags: [],
      sectionCount: 0,
      nominal: false,
    },
  };

  // 3. One point per hazard-relevant civic domain (deterministic anchor-relative).
  const hazardTagSet = new Set<string>();
  const hazardPoints: GeoPointFeature[] = input.hazardDomains.map((domain, index) => {
    for (const tag of domain.hazardTags) hazardTagSet.add(tag);
    const [dlat, dlon] = HAZARD_OFFSETS[index % HAZARD_OFFSETS.length];
    return {
      type: "Feature",
      id: `hazard-domain:${domain.name}`,
      geometry: {
        type: "Point",
        coordinates: [round6(a.longitude + dlon), round6(a.latitude + dlat)],
      },
      properties: {
        kind: "hazard-domain",
        label: `${domain.icon} ${domain.name}`,
        name: domain.name,
        icon: domain.icon,
        hazardTags: domain.hazardTags,
        sectionCount: domainSectionCount(domain.topics),
        nominal: true,
      },
    };
  });

  // 4. Aggregated municipal-code section references across hazard domains.
  const sectionMap = new Map<string, { relevance: string; domains: Set<string>; topics: Set<string> }>();
  for (const domain of input.hazardDomains) {
    for (const topic of domain.topics) {
      for (const section of topic.sections) {
        if (!section.sectionNumber) continue;
        const existing = sectionMap.get(section.sectionNumber) ?? {
          relevance: section.relevance,
          domains: new Set<string>(),
          topics: new Set<string>(),
        };
        existing.domains.add(domain.name);
        if (topic.name) existing.topics.add(topic.name);
        sectionMap.set(section.sectionNumber, existing);
      }
    }
  }
  const sections: GeoSectionRef[] = [...sectionMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0], undefined, { numeric: true }))
    .map(([sectionNumber, info]) => ({
      sectionNumber,
      relevance: info.relevance,
      domains: [...info.domains].sort(),
      topics: [...info.topics].sort(),
    }));

  // 5. Hazard-intent summary: tag frequency across the relevant domains.
  const tagCount = new Map<string, number>();
  for (const domain of input.hazardDomains) {
    for (const tag of domain.hazardTags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const topHazardTags = [...tagCount.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([tag]) => tag);

  return {
    schema: "crescent-city-geo-view/v1",
    crs: { type: "name", properties: { name: "EPSG:4326" } },
    anchor: {
      name: a.name,
      municipality: a.municipality,
      county: a.county,
      state: a.state,
      latitude: a.latitude,
      longitude: a.longitude,
      bounds: { ...a.bounds },
    },
    generatedAt: input.generatedAt,
    features: [boundsFeature, anchorFeature, ...hazardPoints],
    hazard: {
      domainCount: input.hazardDomains.length,
      hazardTags: [...hazardTagSet].sort(),
      topHazardTags,
    },
    sections,
  };
}
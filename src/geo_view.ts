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
 * The builders are PURE functions: `buildGeoView` returns the JSON-safe feature
 * surface and `buildGeoViewSvg` projects that surface into an escaped inline
 * SVG. Neither requires a DOM, filesystem, network, or tiles provider.
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
    /** Additive round-2 field present only when insights attach to this domain. */
    insight?: HazardDomainInsight;
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

/**
 * Public integration surface shared by the live API and static Pages export.
 * The contract fields remain at the top level for backward compatibility;
 * `view` is the additive, map-ready projection of that same contract.
 */
export type GeoIntelSurface = Record<string, unknown> & { view: GeoIntelView };

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

/**
 * Broadsheet palette for the inline SVG (§4.8): grayscale ink/rule steps plus
 * the newspaper's own `--cc`/`--rdark` brand family. Replaces the saturated
 * Tailwind palette that clashed with the light broadsheet page.
 */
const GEO_VIEW_PALETTE = [
  "#c41e1e", // --cc brand red
  "#333333", // --ink-dim
  "#8b1a1a", // --rdark
  "#666666", // --ink-faint
  "#a01818", // brand red, darker step
  "#4a4a4a",
  "#b0b0b0",
  "#7a7a7a",
  "#d01818", // brand red, lighter step
  "#5a5a5a",
  "#909090",
  "#3a3a3a",
];

function escapeSvg(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character,
  );
}

function shortSvgLabel(value: string, maxLength = 27): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isPointFeature(feature: GeoBoundsFeature | GeoPointFeature): feature is GeoPointFeature {
  return feature.geometry.type === "Point";
}

/**
 * Project a canonical geo view into a compact, accessible inline SVG.
 *
 * The county extent remains the primary frame. Because the contract's
 * hazard-domain coordinates are explicitly nominal and intentionally cluster
 * around the city anchor, a labeled inset shows their relative positions
 * without suggesting surveyed facilities or incident locations.
 */
export function buildGeoViewSvg(view: GeoIntelView): string {
  const width = 720;
  const height = 410;
  const map = { x: 24, y: 48, width: 448, height: 322 };
  const legend = { x: 492, y: 48, width: 204, height: 322 };
  const fallbackBounds = CRESCENT_CITY_ANCHOR.bounds;
  const rawBounds = view.anchor?.bounds ?? fallbackBounds;
  const bounds = rawBounds.east > rawBounds.west && rawBounds.north > rawBounds.south
    ? rawBounds
    : fallbackBounds;
  const projectX = (longitude: number): number =>
    map.x + 14 + ((longitude - bounds.west) / (bounds.east - bounds.west)) * (map.width - 28);
  const projectY = (latitude: number): number =>
    map.y + 14 + ((bounds.north - latitude) / (bounds.north - bounds.south)) * (map.height - 28);
  const format = (value: number): string => value.toFixed(1);

  const features = Array.isArray(view.features) ? view.features : [];
  const boundsFeature = features.find((feature): feature is GeoBoundsFeature => feature.geometry.type === "Polygon");
  const anchorFeature = features.find(
    (feature): feature is GeoPointFeature => isPointFeature(feature) && feature.properties.kind === "anchor",
  );
  const hazardPoints = features.filter(
    (feature): feature is GeoPointFeature => isPointFeature(feature) && feature.properties.kind === "hazard-domain",
  );
  const fallbackRing = [
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
    [bounds.west, bounds.south],
  ];
  const featureRing = boundsFeature?.geometry.coordinates[0] ?? [];
  const ring = featureRing.length >= 4 && featureRing.every(
    (position) => position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1]),
  ) ? featureRing : fallbackRing;
  const anchorLongitude = anchorFeature?.geometry.coordinates[0] ?? view.anchor.longitude;
  const anchorLatitude = anchorFeature?.geometry.coordinates[1] ?? view.anchor.latitude;

  const insetPoints = [[anchorLongitude, anchorLatitude], ...hazardPoints.map((feature) => feature.geometry.coordinates)]
    .filter((position) => position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1]));
  const insetLongitudes = insetPoints.map((position) => position[0]);
  const insetLatitudes = insetPoints.map((position) => position[1]);
  const longitudeCenter = (Math.min(...insetLongitudes) + Math.max(...insetLongitudes)) / 2;
  const latitudeCenter = (Math.min(...insetLatitudes) + Math.max(...insetLatitudes)) / 2;
  const longitudeSpan = Math.max(0.05, (Math.max(...insetLongitudes) - Math.min(...insetLongitudes)) * 1.5);
  const latitudeSpan = Math.max(0.05, (Math.max(...insetLatitudes) - Math.min(...insetLatitudes)) * 1.5);
  const inset = { x: map.x + map.width - 174, y: map.y + map.height - 142, width: 158, height: 126 };
  const insetX = (longitude: number): number =>
    inset.x + 10 + ((longitude - (longitudeCenter - longitudeSpan / 2)) / longitudeSpan) * (inset.width - 20);
  const insetY = (latitude: number): number =>
    inset.y + 20 + (((latitudeCenter + latitudeSpan / 2) - latitude) / latitudeSpan) * (inset.height - 30);

  const titleId = "crescent-city-geo-view-title";
  const descriptionId = "crescent-city-geo-view-description";
  const svg: string[] = [
    `<svg class="geo-view-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${titleId} ${descriptionId}" data-geo-view-schema="${escapeSvg(view.schema)}" xmlns="http://www.w3.org/2000/svg">`,
    `<title id="${titleId}">Crescent City civic and hazard geo view</title>`,
    `<desc id="${descriptionId}">Tiles-free WGS84 map of the Del Norte County extent, Crescent City anchor, and ${hazardPoints.length} nominal hazard-domain markers. The legend reports municipal-code section counts.</desc>`,
    "<defs><linearGradient id=\"geo-view-land\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#f2efe9\"/><stop offset=\"1\" stop-color=\"#e7e2d8\"/></linearGradient></defs>",
    `<rect width="${width}" height="${height}" rx="12" fill="#faf6ef"/>`,
    `<text x="${map.x}" y="27" fill="#0a0a0a" font-size="15" font-weight="700">Del Norte County extent · WGS84</text>`,
    `<text x="${map.x + map.width}" y="27" text-anchor="end" fill="#6a6a6a" font-size="11">tiles-free · not a surveyed boundary</text>`,
    `<rect x="${map.x}" y="${map.y}" width="${map.width}" height="${map.height}" rx="9" fill="url(#geo-view-land)" stroke="#d0cac4"/>`,
  ];

  const ringPoints = ring.map((position) => `${format(projectX(position[0]))},${format(projectY(position[1]))}`).join(" ");
  svg.push(
    `<polygon data-feature-id="${escapeSvg(boundsFeature?.id ?? "del-norte-bounds")}" data-feature-kind="bounds" points="${ringPoints}" fill="rgba(196,30,30,0.05)" stroke="#c41e1e" stroke-width="2" stroke-dasharray="8 5"/>`,
    `<text x="${map.x + 12}" y="${map.y + 19}" fill="#6a6a6a" font-size="10">${escapeSvg(boundsFeature?.properties.label ?? "Del Norte County extent")}</text>`,
    `<text x="${map.x + 12}" y="${map.y + map.height - 9}" fill="#6a6a6a" font-size="9">${bounds.west.toFixed(3)}° W</text>`,
    `<text x="${map.x + map.width - 12}" y="${map.y + map.height - 9}" text-anchor="end" fill="#6a6a6a" font-size="9">${bounds.east.toFixed(3)}° W</text>`,
    `<path d="M ${map.x + map.width - 24} ${map.y + 42} V ${map.y + 18} M ${map.x + map.width - 30} ${map.y + 26} L ${map.x + map.width - 24} ${map.y + 18} L ${map.x + map.width - 18} ${map.y + 26}" fill="none" stroke="#0a0a0a" stroke-width="1.5"/>`,
    `<text x="${map.x + map.width - 24}" y="${map.y + 54}" text-anchor="middle" fill="#0a0a0a" font-size="10">N</text>`,
  );

  const mainAnchorX = format(projectX(anchorLongitude));
  const mainAnchorY = format(projectY(anchorLatitude));
  svg.push(
    `<g data-feature-id="${escapeSvg(anchorFeature?.id ?? "city-anchor")}" data-feature-kind="anchor">`,
    `<circle cx="${mainAnchorX}" cy="${mainAnchorY}" r="11" fill="#0a0a0a" fill-opacity="0.72" stroke="#ffffff" stroke-width="2"/>`,
    `<circle cx="${mainAnchorX}" cy="${mainAnchorY}" r="2.5" fill="#ffffff"/>`,
    `<text x="${format(projectX(anchorLongitude) + 15)}" y="${format(projectY(anchorLatitude) + 4)}" fill="#0a0a0a" font-size="11" font-weight="700">${escapeSvg(view.anchor.name)}</text>`,
    "</g>",
  );

  hazardPoints.forEach((feature, index) => {
    const [longitude, latitude] = feature.geometry.coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    const color = GEO_VIEW_PALETTE[index % GEO_VIEW_PALETTE.length];
    svg.push(
      `<circle data-feature-id="${escapeSvg(feature.id)}" data-feature-kind="hazard-domain" data-nominal="${feature.properties.nominal}" cx="${format(projectX(longitude))}" cy="${format(projectY(latitude))}" r="5" fill="${color}" stroke="#ffffff" stroke-width="1.25"><title>${escapeSvg(feature.properties.label)} · ${feature.properties.sectionCount} code section reference(s) · nominal marker</title></circle>`,
    );
  });

  svg.push(
    `<g aria-label="Nominal marker inset">`,
    `<rect x="${inset.x}" y="${inset.y}" width="${inset.width}" height="${inset.height}" rx="7" fill="#f4efe6" fill-opacity="0.96" stroke="#d0cac4"/>`,
    `<text x="${inset.x + 9}" y="${inset.y + 14}" fill="#0a0a0a" font-size="9" font-weight="700">Nominal marker inset</text>`,
    `<circle cx="${format(insetX(anchorLongitude))}" cy="${format(insetY(anchorLatitude))}" r="8" fill="none" stroke="#ffffff" stroke-width="1.5"/>`,
  );
  hazardPoints.forEach((feature, index) => {
    const [longitude, latitude] = feature.geometry.coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    const color = GEO_VIEW_PALETTE[index % GEO_VIEW_PALETTE.length];
    svg.push(
      `<circle cx="${format(insetX(longitude))}" cy="${format(insetY(latitude))}" r="7" fill="${color}" stroke="#ffffff" stroke-width="1"><title>${escapeSvg(feature.properties.label)}</title></circle>`,
      `<text x="${format(insetX(longitude))}" y="${format(insetY(latitude) + 3.5)}" text-anchor="middle" fill="#08111f" font-size="9" font-weight="800">${index + 1}</text>`,
    );
  });
  svg.push("</g>");

  svg.push(
    `<rect x="${legend.x}" y="${legend.y}" width="${legend.width}" height="${legend.height}" rx="9" fill="#f4efe6" stroke="#d0cac4"/>`,
    `<text x="${legend.x + 14}" y="${legend.y + 24}" fill="#0a0a0a" font-size="13" font-weight="700">Hazard-relevant domains</text>`,
    `<text x="${legend.x + 14}" y="${legend.y + 42}" fill="#6a6a6a" font-size="10">${hazardPoints.length} nominal marker(s)</text>`,
  );
  const legendLimit = Math.min(hazardPoints.length, 6);
  hazardPoints.slice(0, legendLimit).forEach((feature, index) => {
    const color = GEO_VIEW_PALETTE[index % GEO_VIEW_PALETTE.length];
    const rowY = legend.y + 72 + index * 42;
    svg.push(
      `<circle cx="${legend.x + 20}" cy="${rowY - 4}" r="8" fill="${color}"/>`,
      `<text x="${legend.x + 20}" y="${rowY - 1}" text-anchor="middle" fill="#08111f" font-size="9" font-weight="800">${index + 1}</text>`,
      `<text x="${legend.x + 34}" y="${rowY - 7}" fill="#0a0a0a" font-size="10.5" font-weight="700"><title>${escapeSvg(feature.properties.name)}</title>${escapeSvg(shortSvgLabel(feature.properties.name))}</text>`,
      `<text x="${legend.x + 34}" y="${rowY + 8}" fill="#3a3a3a" font-size="9.5">${feature.properties.sectionCount} code section reference(s)</text>`,
    );
  });
  if (hazardPoints.length > legendLimit) {
    svg.push(`<text x="${legend.x + 14}" y="${legend.y + legend.height - 32}" fill="#6a6a6a" font-size="10">+ ${hazardPoints.length - legendLimit} domain(s) in JSON</text>`);
  }
  svg.push(
    `<text x="${legend.x + 14}" y="${legend.y + legend.height - 14}" fill="#c41e1e" font-size="10">${view.sections.length} hazard-weighted section(s) · EPSG:4326</text>`,
    "</svg>",
  );
  return svg.join("\n");
}

/**
 * Add the map-ready view to a geo-intel contract without mutating the input.
 * This is the canonical `/api/geo-intel` and public Pages JSON shape.
 */
export function buildGeoIntelSurface(raw: Record<string, unknown>): GeoIntelSurface {
  return {
    ...raw,
    view: buildGeoView(raw),
  };
}

/** Additive per-domain intelligence summary attached to hazard-domain points. */
export interface HazardDomainInsight {
  direction: "rising" | "steady" | "falling" | "insufficient";
  deltaTotal: number;
  momentumPct: number | null;
  /** Coverage-gap kind + score when the round-2 scorer flagged the domain. */
  coverageGapKind: string | null;
  coverageGapScore: number | null;
}

/**
 * Return a NEW view whose hazard-domain point properties gain an additive
 * `insight` field (never mutates the input). Points carry insights only for
 * domains present in the report - absence stays absent rather than becoming
 * a fabricated "calm".
 */
export function attachGeoDomainInsights(
  view: GeoIntelView,
  insightsByDomainId: Record<string, HazardDomainInsight>,
): GeoIntelView {
  const lookup = new Map<string, string>();
  for (const domainId of Object.keys(insightsByDomainId)) {
    lookup.set(normalizeDomainName(domainId), domainId);
  }
  const features = view.features.map(feature => {
    if (feature.geometry.type !== "Point" || feature.properties.kind !== "hazard-domain") return feature;
    const name = feature.id.startsWith("hazard-domain:") ? feature.id.slice("hazard-domain:".length) : null;
    const domainId = name ? lookup.get(normalizeDomainName(name)) ?? null : null;
    const insight = domainId ? insightsByDomainId[domainId] : undefined;
    if (!insight || feature.properties.kind !== "hazard-domain") return feature;
    const enriched: GeoPointFeature = {
      type: "Feature",
      id: feature.id,
      geometry: { type: "Point", coordinates: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]] },
      properties: { ...feature.properties, insight },
    };
    return enriched;
  });
  return { ...view, features };
}

/**
 * Normalize a domain id/display name to a comparable key so e.g.
 * "harbor-marine-operations", "Harbor & Marine Operations", and
 * "Harbor Marine Operations" all collide onto the same bucket.
 */
function normalizeDomainName(value: string): string {
  return value.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

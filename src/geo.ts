#!/usr/bin/env bun
/**
 * Municipality geo-intelligence contract.
 *
 * Emits a stable, machine-readable geo-intel snapshot that external
 * geospatial consumers (notably the GEO-INFER geodesign ecosystem) can
 * import and map without re-scraping. The framework is intentionally
 * MUNICIPALITY-AGNOSTIC: any city can build a contract from a
 * `MunicipalitySpec` (anchor + curated civic-domain surface), so sibling
 * cities never need to fork this builder. Crescent City, CA is the default /
 * anchor implementation, and its contract schema (`crescent-city-geo-intel/v1`)
 * is frozen so GEO-INFER's CrescentCityIntelMapper keeps working unchanged.
 *
 * Each contract carries:
 *
 *   1. Municipality anchor — name, guid, source, and geographic bounds.
 *   2. Civic intelligence domains — id / name / icon / description and their
 *      topics with municipal-code section cross-references + hazard tags.
 *   3. Hazard-relevant domains — the subset of domains whose topics carry
 *      natural-hazard tags (tsunami, seismic, flood, fire, erosion) so a
 *      geospatial dashboard can weight municipal policy by hazard intent.
 *
 * The builders are PURE functions (`buildMunicipalityContract`, `buildGeoIntel`):
 * they take a spec / domain surface and return plain JSON-safe objects without
 * filesystem or network side effects. Tests exercise them in isolation.
 */
import { mkdir } from "fs/promises";
import { join } from "path";
import { domains } from "./domains.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { createLogger } from "./logger.js";

const log = createLogger("geo-intel");

/** WGS84 bounds envelope shared by every municipality anchor. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Geographic + civic identity anchor embedded in every municipality contract. */
export interface MunicipalityAnchor {
  /** Human-readable municipal name (e.g. "Crescent City"). */
  name: string;
  /** Municipal-code platform guid (e.g. ecode360 code) used to cross-scrape. */
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
  /** Geographic extent (west, south, east, north) in decimal degrees. */
  bounds: GeoBounds;
}

/**
 * Fully-specified reusable municipality contract. Any city can supply one to
 * emit its own geo-intel snapshot without touching this builder.
 */
export interface MunicipalitySpec {
  /** Contract identifier — becomes the output `schema` (stable across re-runs). */
  id: string;
  /** Geographic + civic identity anchor. */
  anchor: MunicipalityAnchor;
  /** Curated civic-intelligence domain surface for this municipality. */
  domains: typeof domains;
}

/** Authoritative Crescent City / Del Norte County anchor — the default. */
export const CRESCENT_CITY_ANCHOR: MunicipalityAnchor = {
  name: "Crescent City",
  guid: "CR4919",
  municipality: "Crescent City, CA",
  county: "Del Norte County",
  state: "California",
  latitude: 41.76,
  longitude: -124.2,
  // Del Norte County extent (west, south, east, north).
  bounds: { west: -124.408, south: 41.458, east: -123.536, north: 42.006 },
};

/**
 * The built-in Crescent City municipality spec, returned as plain data so the
 * builder itself stays generic. Anchor fields are per-municipality: only the
 * `id` schema string is pinned for GEO-INFER compatibility.
 */
export function getDefaultCrescentSpec(): MunicipalitySpec {
  return {
    id: "crescent-city-geo-intel/v1",
    anchor: CRESCENT_CITY_ANCHOR,
    domains,
  };
}

/** Tags whose presence marks a domain topic as hazard-relevant. */
const HAZARD_RELEVANT_TAGS = new Set([
  "tsunami",
  "seismic",
  "earthquake",
  "flood",
  "erosion",
  "wildfire",
  "climate",
  "sea level",
  "storm",
  "landslide",
]);

/** Extract every unique tag referenced across a domain's topics (sorted). */
function extractDomainTags(topics: Array<{ tags?: string[] }>): string[] {
  const seen = new Set<string>();
  for (const topic of topics) {
    for (const tag of topic.tags ?? []) seen.add(tag);
  }
  return [...seen].sort();
}

/** Reduce a surface's topics to those carrying at least one hazard tag. */
function hazardTaggedTopics(topics: Array<{
  name: string;
  tags?: string[];
  sources?: Array<{ sectionNumber: string; relevance: string }>;
}>): Array<{ name: string; tags: string[]; sections: Array<{ sectionNumber: string; relevance: string }> }> {
  return topics
    .filter((topic) => (topic.tags ?? []).some((t) => HAZARD_RELEVANT_TAGS.has(t)))
    .map((topic) => ({
      name: topic.name,
      tags: (topic.tags ?? []).filter((t) => HAZARD_RELEVANT_TAGS.has(t)),
      sections: (topic.sources ?? []).map((s) => ({
        sectionNumber: s.sectionNumber,
        relevance: s.relevance,
      })),
    }));
}

/**
 * Isolate a civic-domain surface that overlaps natural-hazard policy.
 * Each returned domain is reduced to its hazard-tagged topics + code refs so a
 * downstream map can weight municipal policy by hazard intent.
 *
 * @param surface Municipal domains to project; defaults to the in-repo surface.
 */
export function hazardRelevantDomains(
  surface: typeof domains = domains,
): Array<{
  id: string;
  name: string;
  icon: string;
  hazardTags: string[];
  topics: Array<{ name: string; tags: string[]; sections: Array<{ sectionNumber: string; relevance: string }> }>;
}> {
  const out: ReturnType<typeof hazardRelevantDomains> = [];
  for (const domain of surface) {
    const taggedTopics = hazardTaggedTopics(domain.topics);
    if (taggedTopics.length === 0) continue;
    out.push({
      id: domain.id,
      name: domain.name,
      icon: domain.icon,
      hazardTags: extractDomainTags(domain.topics).filter((t) => HAZARD_RELEVANT_TAGS.has(t)),
      topics: taggedTopics,
    });
  }
  return out;
}

/**
 * Build a full municipality geo-intel contract from a defined spec.
 * Pure and transferable: pass any `MunicipalitySpec` (anchor + domains) and
 * get a plain JSON-safe contract keyed by that spec's `id`.
 */
export function buildMunicipalityContract(spec: MunicipalitySpec): Record<string, unknown> {
  const surface = spec.domains.length > 0 ? spec.domains : domains;
  const relevant = hazardRelevantDomains(spec.domains);
  return {
    schema: spec.id,
    anchor: spec.anchor,
    generatedAt: new Date().toISOString(),
    domainCount: surface.length,
    domains: surface.map((domain) => ({
      id: domain.id,
      name: domain.name,
      icon: domain.icon,
      description: domain.description,
      updatedAt: domain.updatedAt,
      topicCount: (domain.topics ?? []).length,
      tags: extractDomainTags(domain.topics),
      sections: (domain.topics ?? [])
        .flatMap((topic) => topic.sources ?? [])
        .map((s) => ({ sectionNumber: s.sectionNumber, relevance: s.relevance })),
    })),
    hazard: {
      relevantDomains: relevant,
      relevantDomainCount: relevant.length,
    },
  };
}

/**
 * Build the full machine-readable Crescent City geo-intel contract (backward
 * compatible with v2.5). Internally resolves the default Crescent City spec and
 * delegates to the transferable pure builder.
 *
 * @param domainList Optional ordered domain concern for pure testing; defaults
 *   to the built-in 12-domain surface.
 */
export function buildGeoIntel(
  domainList: typeof domains = domains,
): Record<string, unknown> {
  const spec = getDefaultCrescentSpec();
  return buildMunicipalityContract({
    ...spec,
    domains: domainList.length > 0 ? domainList : spec.domains,
  });
}

/** Paths for the geo-intel contract. */
export const geoPaths = {
  /** Committed public seed — external consumers read this without a live output/. */
  pagesSeed: join("pages-data", "geo-intel.json"),
  /** Live output/ path written by the orchestration script. */
  liveExport: join("output", "geo-intel.json"),
};

/**
 * Write the geo-intel contract to disk (committed seed + live export) when the
 * pipeline is ready. Never an import side effect. Defaults to the Crescent City
 * contract so existing pages-data/geo-intel.json consumers stay valid.
 */
export async function writeGeoIntelExports(): Promise<Array<string>> {
  const payload = buildGeoIntel();
  const written: Array<string> = [];
  try {
    await mkdir(join("pages-data"), { recursive: true });
    await writeJsonAtomic(geoPaths.pagesSeed, payload);
    written.push(geoPaths.pagesSeed);
  } catch (error) {
    log.warn(`Could not write committed geo-intel seed: ${String(error)}`);
  }
  try {
    await writeJsonAtomic(geoPaths.liveExport, payload);
    written.push(geoPaths.liveExport);
  } catch (error) {
    log.warn(`Skipping live export (output/ may be absent): ${String(error)}`);
  }
  log.info(`wrote Crescent City geo-intel contract → ${written.join(", ")}`);
  return written;
}

// CLI entry: `bun run src/geo.ts` — emit the contract index.
if (import.meta.main) {
  const written = await writeGeoIntelExports().catch(() => []);
  console.log(`Crescent City geo-intel written: ${written.length} file(s).`);
}
#!/usr/bin/env bun
/**
 * Crescent City geo-intelligence contract builder.
 *
 * Produces a stable, machine-readable Geo-Intel snapshot that external
 * geospatial consumers (notably the GEO-INFER geodesign ecosystem) can
 * import and map without re-scraping. It focuses the civic-domain +
 * hazard-aware municipal-code surface of Crescent City, CA:
 *
 *   1. Municipality anchor — name, guid, source, and geographic bounds.
 *   2. Civic intelligence domains — id / name / icon / description and their
 *      topics with municipal-code section cross-references + hazard tags.
 *   3. Hazard-relevant domains — the subset of domains whose topics carry
 *      natural-hazard tags (tsunami, seismic, flood, fire, erosion) so a
 *      geospatial dashboard can weight municipal policy by hazard intent.
 *
 * The builder is a PURE function (`buildGeoIntel`): it takes the curated
 * domain surface and returns a plain JSON-safe object without filesystem or
 * network side effects. Tests exercise it in isolation.
 */
import { mkdir } from "fs/promises";
import { join } from "path";
import { domains } from "./domains.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { createLogger } from "./logger.js";

const log = createLogger("geo-intel");

/** Authoritative Crescent City / Del Norte County geographic anchor. */
export const CRESCENT_CITY_ANCHOR: {
  name: string;
  guid: string;
  municipality: string;
  county: string;
  state: string;
  latitude: number;
  longitude: number;
  bounds: { west: number; south: number; east: number; north: number };
} = {
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

/** Reduce a domain's topics to those carrying at least one hazard tag. */
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
 * Isolate the civic-domain surface that overlaps natural-hazard policy.
 * Each returned domain is reduced to its hazard-tagged topics + code refs so a
 * downstream map can weight municipal policy by hazard intent.
 */
export function hazardRelevantDomains(): Array<{
  id: string;
  name: string;
  icon: string;
  hazardTags: string[];
  topics: Array<{ name: string; tags: string[]; sections: Array<{ sectionNumber: string; relevance: string }> }>;
}> {
  const out: ReturnType<typeof hazardRelevantDomains> = [];
  for (const domain of domains) {
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
 * Build the full machine-readable Crescent City geo-intel contract.
 *
 * @param domainList Optional ordered domain list for pure testing; defaults to
 *   the in-repo 12-domain surface.
 */
export function buildGeoIntel(
  domainList: typeof domains = domains,
): Record<string, unknown> {
  const surface = domainList.length > 0 ? domainList : domains;
  const relevant = hazardRelevantDomains();
  return {
    schema: "crescent-city-geo-intel/v1",
    anchor: CRESCENT_CITY_ANCHOR,
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

/** Paths for the geo-intel contract. */
export const geoPaths = {
  /** Committed public seed — external consumers read this without a live output/. */
  pagesSeed: join("pages-data", "geo-intel.json"),
  /** Live output/ path written by the orchestration script. */
  liveExport: join("output", "geo-intel.json"),
};

/**
 * Write the geo-intel contract to disk (committed seed + live export) when the
 * pipeline is ready. Never an import side effect.
 */
export async function writeGeoIntelExports(): Promise<Array<string>> {
  const payload = buildGeoIntel(domains);
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
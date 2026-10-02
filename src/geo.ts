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
import { mkdir, realpath } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { outputRoot } from "./shared/paths.js";
import { domains } from "./domains.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { createLogger } from "./logger.js";
import { bindCivicOutputRoot, currentCivicProfile, isCrescentCityProfile, type CivicProfile } from "./civic_profile.js";

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
  /** Explicit deployment identity when a runtime civic profile supplied this spec. */
  profileId?: string;
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

/** Project a validated deployment profile without supplying another locality's policy. */
export function getCivicMunicipalitySpec(profile: CivicProfile = currentCivicProfile()): MunicipalitySpec {
  const crescent = isCrescentCityProfile(profile);
  return {
    id: crescent ? "crescent-city-geo-intel/v1" : "civic-geo-intel/v1",
    anchor: {
      name: profile.name, guid: profile.code?.municipalityCode ?? profile.id,
      municipality: profile.municipality, county: profile.county, state: profile.state,
      latitude: profile.anchor.latitude, longitude: profile.anchor.longitude,
      bounds: { ...profile.anchor.bounds },
    },
    domains: crescent ? domains : [],
    ...(crescent ? {} : { profileId: profile.id }),
  };
}

/** Validate complete geographic identity; foreign contracts never borrow default coordinates. */
export function assertMunicipalityAnchor(value: unknown): asserts value is MunicipalityAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid municipality anchor");
  const a = value as Record<string, unknown>;
  for (const key of ["name", "guid", "municipality", "county", "state"]) {
    if (typeof a[key] !== "string" || !a[key].trim() || a[key].length > 300 || /[\u0000-\u001f\u007f]/.test(a[key])) throw new Error(`Invalid municipality anchor ${key}`);
  }
  const b = a.bounds as Record<string, unknown> | undefined;
  const inRange = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  if (!inRange(a.latitude, -90, 90) || !inRange(a.longitude, -180, 180) || !b ||
    !inRange(b.west, -180, 180) || !inRange(b.east, -180, 180) || !inRange(b.south, -90, 90) || !inRange(b.north, -90, 90) ||
    b.west >= b.east || b.south >= b.north || a.longitude < b.west || a.longitude > b.east || a.latitude < b.south || a.latitude > b.north) throw new Error("Invalid municipality anchor coordinates or bounds");
}

/** Compatibility identity check, independent of the selected runtime profile. */
export function isCrescentCityAnchor(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const bounds = a.bounds as Record<string, unknown> | undefined;
  return ["name", "guid", "municipality", "county", "state", "latitude", "longitude"].every(key => a[key] === CRESCENT_CITY_ANCHOR[key as keyof MunicipalityAnchor]) &&
    (bounds === undefined || ["west", "south", "east", "north"].every(key => bounds[key] === CRESCENT_CITY_ANCHOR.bounds[key as keyof GeoBounds]));
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

/**
 * True when a tag carries a hazard-relevant keyword, using word-boundary
 * matching so composite tags surface (`"flood zone"` ⇒ flood, `"sea level
 * rise"` ⇒ sea level) without false positives on substrings.
 */
function isHazardTag(tag: string): boolean {
  const lower = tag.toLowerCase().trim();
  if (!lower) return false;
  for (const keyword of HAZARD_RELEVANT_TAGS) {
    // Multi-word keywords match as a whole phrase; single words match on
    // word boundaries so "stormwater" does not read as "storm".
    if (keyword.includes(" ")) {
      if (lower.includes(keyword)) return true;
    } else {
      // eslint-disable-next-line no-useless-escape
      if (new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(lower)) return true;
    }
  }
  return false;
}

/** Escape regex-special characters for a literal word-boundary match. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    .filter((topic) => (topic.tags ?? []).some(isHazardTag))
    .map((topic) => ({
      name: topic.name,
      tags: (topic.tags ?? []).filter(isHazardTag),
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
      hazardTags: extractDomainTags(domain.topics).filter(isHazardTag),
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
  assertMunicipalityAnchor(spec.anchor);
  if (spec.profileId !== undefined && (spec.profileId.length > 63 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(spec.profileId))) throw new Error("Invalid geo profile identity");
  if (spec.id === "crescent-city-geo-intel/v1" && (!isCrescentCityAnchor(spec.anchor) || spec.profileId !== undefined)) throw new Error("Crescent City geo schema differs from its geographic identity");
  const surface = spec.domains;
  const relevant = hazardRelevantDomains(spec.domains);
  return {
    schema: spec.id,
    ...(spec.profileId ? { profileId: spec.profileId } : {}),
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
 * Build the selected civic profile's geo-intel contract. The exact default
 * retains its Crescent City contract and policy surface; other profiles start
 * with no curated domains until the caller supplies their own.
 *
 * @param domainList Optional ordered domain concern for pure testing; defaults
 *   to the built-in 12-domain surface for the exact Crescent default only.
 */
export function buildGeoIntel(
  domainList?: typeof domains,
): Record<string, unknown> {
  const spec = getCivicMunicipalitySpec();
  return buildMunicipalityContract({
    ...spec,
    domains: domainList === undefined || isCrescentCityProfile() && domainList.length === 0 ? spec.domains : domainList,
  });
}

/** Paths for the geo-intel contract. */
export const geoPaths = {
  /** Committed public seed — external consumers read this without a live output/. */
  pagesSeed: join("pages-data", "geo-intel.json"),
  /** Live output/ path written by the orchestration script. */
  get liveExport() { return join(outputRoot(), "geo-intel.json"); },
};

/**
 * Write the geo-intel contract to disk (committed seed + live export) when the
 * pipeline is ready. Never an import side effect. Defaults to the Crescent City
 * contract so existing pages-data/geo-intel.json consumers stay valid.
 */
/** One admission boundary for all geo seed/output writers, including physical aliases. */
export async function prepareCivicGeoExportRoots(seedDir: string, outputDir: string): Promise<void> {
  if (isCrescentCityProfile()) return;
  if (!currentCivicProfile().capabilities.includes("geo")) throw new Error("Selected civic profile has no configured geo capability");
    const physicalPath = async (path: string): Promise<string> => {
      let candidate = resolve(path); const suffix: string[] = [];
      for (;;) {
        try { return join(await realpath(candidate), ...suffix); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || candidate === dirname(candidate)) throw error; suffix.unshift(basename(candidate)); candidate = dirname(candidate); }
      }
    };
    const [seedPath, outputPath, trackedSeed, defaultOutput] = await Promise.all([physicalPath(seedDir), physicalPath(outputDir), physicalPath("pages-data"), physicalPath("output")]);
    const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    if (overlaps(seedPath, trackedSeed) || overlaps(outputPath, trackedSeed) || overlaps(seedPath, defaultOutput) || overlaps(outputPath, defaultOutput) || overlaps(seedPath, outputPath)) throw new Error("Alternate geo exports require independent roots outside the Crescent City seed and output");
    await mkdir(seedDir, { recursive: true }); await mkdir(outputDir, { recursive: true });
    await bindCivicOutputRoot(seedDir); await bindCivicOutputRoot(outputDir);
}

export async function writeGeoIntelExports(options: { seedDir?: string; outputDir?: string } = {}): Promise<Array<string>> {
  const profile = currentCivicProfile();
  if (!isCrescentCityProfile(profile) && (!profile.capabilities.includes("geo") || !options.seedDir || !options.outputDir)) throw new Error("Alternate geo exports require configured geo capability and explicit seed/output roots");
  const seedDir = options.seedDir ?? "pages-data";
  const outputDir = options.outputDir ?? outputRoot();
  if (!isCrescentCityProfile(profile)) {
    await prepareCivicGeoExportRoots(seedDir, outputDir);
  }
  const payload = buildGeoIntel();
  const written: Array<string> = [];
  try {
    await mkdir(seedDir, { recursive: true });
    const seedPath = join(seedDir, "geo-intel.json");
    await writeJsonAtomic(seedPath, payload);
    written.push(seedPath);
  } catch (error) {
    if (!isCrescentCityProfile(profile)) throw error;
    log.warn(`Could not write committed geo-intel seed: ${String(error)}`);
  }
  try {
    const livePath = join(outputDir, "geo-intel.json");
    await writeJsonAtomic(livePath, payload);
    written.push(livePath);
  } catch (error) {
    if (!isCrescentCityProfile(profile)) throw error;
    log.warn(`Skipping live export (output/ may be absent): ${String(error)}`);
  }
  log.info(`wrote ${currentCivicProfile().name} geo-intel contract → ${written.join(", ")}`);
  return written;
}

// CLI entry: `bun run src/geo.ts` — emit the contract index.
if (import.meta.main) {
  try {
    const written = await writeGeoIntelExports();
    console.log(`${currentCivicProfile().name} geo-intel written: ${written.length} file(s).`);
  } catch (error) { log.error(String(error)); process.exitCode = 1; }
}

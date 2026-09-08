#!/usr/bin/env bun
/**
 * scripts/run-geo-observations.ts — Thin orchestrator for the GEO-INFER
 * hazard-observation interface (`crescent-city-geo-observations/v1`).
 *
 * Loads the live composite severity snapshot (output/alerts/composite/
 * current.json), the alert source-health artifact (paths.alertsHealth), and
 * the committed geo-intel contract seed, then delegates everything else to
 * the pure builder `buildHazardObservations` and writes the envelope to both
 * the committed Pages seed and the live output export — atomically (temp +
 * rename via writeJsonAtomic, the same pattern as `bun run pages:seed`).
 *
 * Missing inputs are a VALID empty-state run (composite: null, monitors: []):
 * only a write failure exits non-zero. Run: `bun run geo:observations`.
 */
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { buildHazardObservations, normalizeCompositeSnapshot, normalizeMonitorObservation, DEFAULT_OBSERVATION_ANCHOR } from "../src/geo_observations.ts";
import type { GeoObservationsEnvelope, HazardDomainInput, MonitorObservation, ObservationAnchor } from "../src/geo_observations.ts";
import { CRESCENT_CITY_ANCHOR } from "../src/geo.ts";
import { outputRoot } from "../src/shared/paths.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";
import { createLogger } from "../src/logger.ts";

const log = createLogger("geo-observations");

/** Committed Pages seed directory — a getter, so a test can scope an override
 * (PAGES_SEED_DIR, like `pages:seed`) to one block instead of the process. */
function pagesSeedDir(): string {
  return process.env.PAGES_SEED_DIR ?? "pages-data";
}

export const geoObservationPaths = {
  get pagesSeed() { return join(pagesSeedDir(), "geo-observations.json"); },
  get liveExport() { return join(outputRoot(), "geo-observations.json"); },
};

/** Read a JSON artifact; absent or corrupt files are null, never a crash. */
async function readJsonArtifact(path: string): Promise<unknown> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    log.warn(`Could not parse ${path}, treating as absent: ${String(error)}`);
    return null;
  }
}

/** Project the contract anchor (or the built-in default) to the observation shape. */
function observationAnchor(raw: unknown): ObservationAnchor {
  const anchor = (raw != null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const stringField = (key: string, fallback: string): string =>
    typeof anchor[key] === "string" ? (anchor[key] as string) : fallback;
  const numberField = (key: string, fallback: number): number =>
    typeof anchor[key] === "number" ? (anchor[key] as number) : fallback;
  return {
    name: stringField("name", CRESCENT_CITY_ANCHOR.name),
    guid: stringField("guid", CRESCENT_CITY_ANCHOR.guid),
    municipality: stringField("municipality", CRESCENT_CITY_ANCHOR.municipality),
    county: stringField("county", CRESCENT_CITY_ANCHOR.county),
    state: stringField("state", CRESCENT_CITY_ANCHOR.state),
    latitude: numberField("latitude", DEFAULT_OBSERVATION_ANCHOR.latitude),
    longitude: numberField("longitude", DEFAULT_OBSERVATION_ANCHOR.longitude),
  };
}

/**
 * One observation run: load artifacts → build envelope → write both exports.
 * Returns the written paths; throws only on write failure (the CLI turns that
 * into a non-zero exit). Missing inputs are valid empty states.
 */
export async function runGeoObservations(): Promise<Array<string>> {
  const contract = (await readJsonArtifact(join(pagesSeedDir(), "geo-intel.json"))) as Record<string, unknown> | null;
  const compositeRaw = await readJsonArtifact(join(outputRoot(), "alerts", "composite", "current.json"));
  const healthRaw = await readJsonArtifact(join(outputRoot(), "alerts", "source-health.json"));

  const health = (healthRaw != null && typeof healthRaw === "object" ? healthRaw : {}) as Record<string, unknown>;
  const sources = Array.isArray(health.sources) ? health.sources : [];
  const monitors: MonitorObservation[] = sources.map((entry) =>
    normalizeMonitorObservation(entry as Parameters<typeof normalizeMonitorObservation>[0]));

  const hazard = (contract?.hazard != null && typeof contract.hazard === "object" ? contract.hazard : {}) as Record<string, unknown>;
  const hazardDomains: HazardDomainInput[] = Array.isArray(hazard.relevantDomains)
    ? (hazard.relevantDomains as HazardDomainInput[])
    : [];

  const envelope: GeoObservationsEnvelope = buildHazardObservations({
    anchor: observationAnchor(contract?.anchor),
    generatedAt: new Date().toISOString(),
    composite: normalizeCompositeSnapshot(compositeRaw),
    monitors,
    hazardDomains,
    contractGeneratedAt: typeof contract?.generatedAt === "string" ? contract.generatedAt : null,
  });

  const written: Array<string> = [];
  await writeJsonAtomic(geoObservationPaths.pagesSeed, envelope);
  written.push(geoObservationPaths.pagesSeed);
  await writeJsonAtomic(geoObservationPaths.liveExport, envelope);
  written.push(geoObservationPaths.liveExport);
  log.info(`wrote geo-observations envelope → ${written.join(", ")}`);
  return written;
}

if (import.meta.main) {
  try {
    const written = await runGeoObservations();
    console.log(`Geo-observations written: ${written.join(", ")}`);
  } catch (error) {
    log.error(`geo-observations run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

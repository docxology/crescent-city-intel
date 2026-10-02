#!/usr/bin/env bun
import { prepareCivicGeoExportRoots } from "../src/geo.js";
import { isCrescentCityProfile, bindCivicOutputRoot } from "../src/civic_profile.js";
/**
 * scripts/run-geo-observations.ts — Thin orchestrator for the GEO-INFER
 * hazard-observation interface (`crescent-city-geo-observations/v1`).
 *
 * Loads the live composite severity snapshot (output/alerts/composite/
 * current.json), the alert source-health artifact (paths.alertsHealth), and
 * the committed geo-intel contract seed — via the shared
 * `loadObservationInputs` loader in src/geo_observations.ts — then delegates
 * everything else to the pure builder `buildHazardObservations` and writes
 * the envelope to both
 * the committed Pages seed and the live output export — atomically (temp +
 * rename via writeJsonAtomic, the same pattern as `bun run pages:seed`).
 *
 * Missing inputs are a VALID empty-state run (composite: null, monitors: []):
 * only a write failure exits non-zero. Run: `bun run geo:observations`.
 */
import { join } from "path";
import { buildHazardObservations, loadObservationInputs } from "../src/geo_observations.ts";
import type { GeoObservationsEnvelope } from "../src/geo_observations.ts";
import { outputRoot } from "../src/shared/paths.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";
import { createLogger } from "../src/logger.ts";

const log = createLogger("geo-observations");

/** Committed Pages seed directory — a getter, so a test can scope an override
 * (PAGES_SEED_DIR, like `pages:seed`) to one block instead of the process. */
function pagesSeedDir(): string {
  if (!isCrescentCityProfile() && (!process.env.PAGES_SEED_DIR || process.env.PAGES_SEED_DIR === "pages-data")) throw new Error("Alternate profile requires its own PAGES_SEED_DIR");
  return process.env.PAGES_SEED_DIR ?? "pages-data";
}

export const geoObservationPaths = {
  get pagesSeed() { return join(pagesSeedDir(), "geo-observations.json"); },
  get liveExport() { return join(outputRoot(), "geo-observations.json"); },
};

/**
 * One observation run: load artifacts → build envelope → write both exports.
 * Returns the written paths; throws only on write failure (the CLI turns that
 * into a non-zero exit). Missing inputs are valid empty states.
 */
export async function runGeoObservations(): Promise<Array<string>> {
  await prepareCivicGeoExportRoots(pagesSeedDir(), outputRoot());
  await bindCivicOutputRoot(outputRoot());
  const inputs = await loadObservationInputs({
    seedDir: pagesSeedDir(),
    onCorrupt: (path, error) => log.warn(`Could not parse ${path}, treating as absent: ${String(error)}`),
  });

  const envelope: GeoObservationsEnvelope = buildHazardObservations({
    ...inputs,
    generatedAt: new Date().toISOString(),
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

#!/usr/bin/env bun
/**
 * scripts/check-geo-sync.ts — Deterministic drift guard for the frozen
 * `crescent-city-geo-intel/v1` contract and its bundled GEO-INFER copy.
 *
 * (a) CONTRACT REBUILD CHECK — rebuild the contract via the pure builder
 *     `buildMunicipalityContract(getDefaultCrescentSpec())` and compare the
 *     selected stable fields (schema, anchor, domainCount, domains, hazard —
 *     NOT generatedAt, which is clock-stamped) against the committed Pages
 *     seed `pages-data/geo-intel.json`. Any difference exits 1.
 *
 * (b) BUNDLED COPY CHECK — when `../GEO-INFER/GEO-INFER-BAYES/src/
 *     geo_infer_bayes/crescent-city-geo-intel.json` exists (or the
 *     CRESCENT_CITY_INTEL_BUNDLED_PATH override), report whether it is
 *     byte-identical to the Pages seed via sha256. Bundled drift prints a
 *     loud "BUNDLED COPY DRIFT" line but exits 0 so CI can decide policy.
 *
 * The comparison logic is exported as pure functions (tested against tmp
 * files); the CLI below is the thin orchestration. Run: `bun run geo:sync-check`.
 */
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { buildMunicipalityContract, getDefaultCrescentSpec } from "../src/geo.ts";
import { computeSha256 } from "../src/utils.ts";

/** Contract fields compared by the rebuild check (clock-stamped fields excluded). */
export const STABLE_CONTRACT_FIELDS = ["schema", "anchor", "domainCount", "domains", "hazard"] as const;

/** Default bundled-copy path relative to this script's directory. */
export const DEFAULT_BUNDLED_PATH = join(
  import.meta.dir, "..", "..", "GEO-INFER", "GEO-INFER-BAYES", "src", "geo_infer_bayes", "crescent-city-geo-intel.json",
);

export interface RebuildComparison {
  /** True when every stable field matches. */
  matches: boolean;
  /** Stable field names that differ (empty when matches). */
  differingFields: Array<string>;
}

/** Compare two contracts' stable fields via canonical JSON equality per field. */
export function compareRebuiltContract(
  rebuilt: Record<string, unknown>,
  seeded: Record<string, unknown>,
): RebuildComparison {
  const differingFields = STABLE_CONTRACT_FIELDS.filter((field) =>
    JSON.stringify(rebuilt[field]) !== JSON.stringify(seeded[field]));
  return { matches: differingFields.length === 0, differingFields: [...differingFields] };
}

export interface BundledComparison {
  /** True when the two payloads are byte-identical. */
  identical: boolean;
  /** sha256 of the Pages seed bytes. */
  shaSeed: string;
  /** sha256 of the bundled copy bytes. */
  shaBundled: string;
}

/** Hash-compare the Pages seed and bundled copy payloads (byte identity). */
export async function compareBundledCopy(seedText: string, bundledText: string): Promise<BundledComparison> {
  const [shaSeed, shaBundled] = await Promise.all([computeSha256(seedText), computeSha256(bundledText)]);
  return { identical: seedText === bundledText, shaSeed, shaBundled };
}

/** Read a UTF-8 file that must exist; the CLI pre-checks existence. */
async function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

async function main(): Promise<number> {
  const seedPath = join("pages-data", "geo-intel.json");
  if (!existsSync(seedPath)) {
    console.error(`CONTRACT DRIFT: ${seedPath} is missing — run \`bun run geo:intel\` to regenerate the seed.`);
    return 1;
  }

  // (a) Rebuild check — the builder is the source of truth, the seed must match it.
  const rebuilt = buildMunicipalityContract(getDefaultCrescentSpec());
  const seeded = JSON.parse(await readText(seedPath)) as Record<string, unknown>;
  const rebuild = compareRebuiltContract(rebuilt, seeded);
  if (!rebuild.matches) {
    console.error(`CONTRACT DRIFT: rebuilt contract differs from ${seedPath} in: ${rebuild.differingFields.join(", ")}`);
    console.error("Regenerate the seed with `bun run geo:intel` and commit it.");
    return 1;
  }
  console.log(`Contract rebuild check: OK (${seedPath} matches the builder on ${STABLE_CONTRACT_FIELDS.join(", ")}).`);

  // (b) Bundled copy check — advisory only; CI decides policy on drift.
  const bundledPath = process.env.CRESCENT_CITY_INTEL_BUNDLED_PATH ?? DEFAULT_BUNDLED_PATH;
  if (!existsSync(bundledPath)) {
    console.log(`Bundled copy check: SKIPPED (${bundledPath} not found).`);
    return 0;
  }
  const bundled = await compareBundledCopy(await readText(seedPath), await readText(bundledPath));
  console.log(`Bundled copy: ${bundledPath}`);
  console.log(`  pages-data sha256: ${bundled.shaSeed}`);
  console.log(`  bundled   sha256: ${bundled.shaBundled}`);
  if (bundled.identical) {
    console.log("Bundled copy check: OK (byte-identical to the Pages seed).");
  } else {
    console.log("BUNDLED COPY DRIFT: the GEO-INFER bundled contract is NOT byte-identical to pages-data/geo-intel.json.");
    console.log("  This is advisory (exit 0) — refresh the bundled copy if the drift is unintended.");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}

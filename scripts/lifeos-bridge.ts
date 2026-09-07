#!/usr/bin/env bun
/**
 * LifeOS / Pulse bridge — thin orchestrator. All digest logic (types, section
 * mapping, digest building, digest writing) lives in src/lifeos_bridge.ts;
 * this script only resolves the environment paths and delegates.
 *
 * Directories overridable for tests: LIFEOS_CUSTOMIZATIONS_DIR,
 * LIFEOS_DATA_DIR, REPO_OUTPUT_DIR.
 */
import { join } from "path";
import { homedir } from "os";
import { buildDigest, writeDigest } from "../src/lifeos_bridge.ts";

async function main() {
  const repoOutput = process.env.REPO_OUTPUT_DIR ?? join(process.cwd(), "output");
  const home = homedir();
  const customizationsDir =
    process.env.LIFEOS_CUSTOMIZATIONS_DIR ??
    join(home, ".claude", "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "LocalIntelligence");
  const dataDir = process.env.LIFEOS_DATA_DIR ?? join(home, ".claude", "LIFEOS", "MEMORY", "DATA", "LocalIntelligence");

  const digest = await buildDigest({ outputDir: repoOutput });
  const { datedPath, customLatest, dataLatest } = await writeDigest(digest, customizationsDir, dataDir);
  const totals = Object.fromEntries(
    (["news", "officials", "legislation"] as const).map(k => [k, digest[k].items.length]),
  );
  console.log(`LifeOS digest written: news=${totals.news} officials=${totals.officials} legislation=${totals.legislation}`);
  console.log(`  dated:   ${datedPath}`);
  console.log(`  latest:  ${customLatest}`);
  console.log(`  latest:  ${dataLatest}`);
  console.log(`  overview: ${digest.meta.overview}`);
}

if (import.meta.main) {
  await main();
}

#!/usr/bin/env bun
/** Build the bounded public snapshot consumed by GitHub Pages. */
import { exportPagesSnapshot } from "../src/pages_snapshot.js";
import { outputRoot } from "../src/shared/paths.js";

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 && Bun.argv[index + 1] ? Bun.argv[index + 1] : fallback;
}

const outputDir = argument("--output", process.env.PAGES_OUTPUT_DIR ?? ".pages");
const sourceDir = argument("--source", outputRoot());
const seedDir = argument("--seed", process.env.PAGES_SEED_DIR ?? "pages-data");
const municipalDir = argument("--municipal-source", sourceDir);
const result = await exportPagesSnapshot({ outputDir: sourceDir, municipalDir, destination: outputDir, seedDir });
console.log(JSON.stringify(result, null, 2));
console.log(`Pages snapshot written to ${result.destination} with status ${result.status}.`);

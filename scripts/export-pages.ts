#!/usr/bin/env bun
/** Build the bounded public snapshot consumed by GitHub Pages. */
import { exportPagesSnapshot } from "../src/pages_snapshot.js";

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 && Bun.argv[index + 1] ? Bun.argv[index + 1] : fallback;
}

const outputDir = argument("--output", process.env.PAGES_OUTPUT_DIR ?? ".pages");
const sourceDir = argument("--source", process.env.OUTPUT_DIR ?? "output");
const result = await exportPagesSnapshot({ outputDir: sourceDir, destination: outputDir });
console.log(JSON.stringify(result, null, 2));
console.log(`Pages snapshot written to ${result.destination} with status ${result.status}.`);

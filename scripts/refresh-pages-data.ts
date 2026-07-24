#!/usr/bin/env bun
/** Refresh the tracked, public municipal-code seed from verified output. */
import { mkdir, copyFile, readFile } from "fs/promises";
import { join } from "path";

const sourceDir = process.env.OUTPUT_DIR ?? "output";
const destinationDir = process.env.PAGES_SEED_DIR ?? "pages-data";
const required = [
  "crescent-city-code.json",
  "toc.json",
  "manifest.json",
  "verification-report.json",
  "domain-coverage.json",
  "readability.json",
];
await mkdir(destinationDir, { recursive: true });
let verification: { overallStatus?: string };
try {
  verification = JSON.parse(await readFile(join(sourceDir, "verification-report.json"), "utf8")) as { overallStatus?: string };
} catch (error) {
  throw new Error(`Cannot seed without output/verification-report.json: ${error instanceof Error ? error.message : String(error)}`);
}
if (verification.overallStatus !== "pass") {
  throw new Error(`Refusing to seed an unverified municipal code snapshot (overallStatus=${verification.overallStatus ?? "missing"})`);
}
for (const filename of required) {
  const source = join(sourceDir, filename);
  const destination = join(destinationDir, filename);
  try {
    JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new Error(`Cannot seed ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await copyFile(source, destination);
}
console.log(`Public Pages seed refreshed in ${destinationDir}: ${required.join(", ")}`);

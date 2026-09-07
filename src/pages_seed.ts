/**
 * Verified municipal-code seed refresh — copies the tracked public Pages seed
 * artifacts from a verified output directory into the seed directory, gating
 * on the verification report and parsing every file before it is copied.
 * Invoked by the thin orchestrator scripts/refresh-pages-data.ts.
 */
import { mkdir, copyFile, readFile } from "fs/promises";
import { join } from "path";

/** Seed files that must exist and parse as JSON in the source output directory. */
const REQUIRED_SEED_FILES = [
  "crescent-city-code.json",
  "toc.json",
  "manifest.json",
  "verification-report.json",
  "domain-coverage.json",
  "readability.json",
];

export async function refreshPagesSeed(options: { sourceDir: string; destinationDir: string }): Promise<string[]> {
  const { sourceDir, destinationDir } = options;
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
  for (const filename of REQUIRED_SEED_FILES) {
    const source = join(sourceDir, filename);
    const destination = join(destinationDir, filename);
    try {
      JSON.parse(await readFile(source, "utf8"));
    } catch (error) {
      throw new Error(`Cannot seed ${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await copyFile(source, destination);
  }
  return REQUIRED_SEED_FILES;
}

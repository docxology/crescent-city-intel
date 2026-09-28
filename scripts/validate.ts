#!/usr/bin/env bun
/**
 * Authoritative deterministic release gate for the repository.
 *
 * `--only=contracts` runs the offline contract checks and stops before the
 * suite. Used by the pull-request CI job, which must be fast; the publish job
 * runs the full gate. Both call the same `runReleaseGate`, so a check added to
 * one is present in the other.
 */
import { runReleaseGate } from "../src/release_gate.ts";

const only = process.argv.includes("--only=contracts") ? "contracts" : "all";
if (process.argv.some(arg => arg.startsWith("--only=")) && only === "all") {
  console.error("Unsupported --only value. Known values: contracts.");
  process.exit(2);
}

await runReleaseGate({ only });

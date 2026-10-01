#!/usr/bin/env bun
import { assessRetainedSourceCoverage } from "../src/source_coverage.js";
import { outputRoot } from "../src/shared/paths.js";
if (process.argv.length > 2) throw new Error("Usage: bun run scripts/source-coverage.ts (read-only; CC_OUTPUT_DIR selects retained artifacts)");
console.log(JSON.stringify(await assessRetainedSourceCoverage(outputRoot()), null, 2));

#!/usr/bin/env bun
/** Thin corpus scoring orchestrator. */
import { writeReadabilityReport } from "../src/readability_report.js";
await writeReadabilityReport({ args: Bun.argv.slice(2) });

#!/usr/bin/env bun
/**
 * scripts/run-curation.ts — Thin orchestrator: curation pipeline.
 *
 * Imports and runs the curation pipeline from src/curation.ts. Summarizes
 * and domain-tags every not-yet-curated item currently sitting in
 * output/{news,gov_meetings,youtube}/, writing output/curated/<date>.json.
 *
 * Requires the configured LLM provider (Ollama by default, or OpenRouter
 * via LLM_PROVIDER=openrouter + OPENROUTER_API_KEY) to be reachable.
 *
 * Usage:
 *   bun run scripts/run-curation.ts
 *   bun run curate
 */
import { runCuration } from "../src/curation.ts";
import { createLogger } from "../src/logger.ts";

const logger = createLogger("run-curation");

logger.info("=== Curation Pipeline ===");

const args = Bun.argv.slice(2);
if (args.some(arg => !/^--deadline-ms=\d+$/.test(arg))) throw new Error("Supported argument: --deadline-ms=N (1..3600000)");
const deadlineMs = Number(args.find(arg => arg.startsWith("--deadline-ms="))?.slice("--deadline-ms=".length) ?? 3600000);
const curated = await runCuration({ deadlineMs });
logger.info(`Curation complete: ${curated.length} item(s) curated to output/curated/`);

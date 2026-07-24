#!/usr/bin/env bun
/**
 * scripts/run-youtube.ts — Thin orchestrator: YouTube meeting transcript pipeline.
 *
 * Imports and runs the YouTube monitoring pipeline from src/youtube_monitor.ts.
 * Lists recent videos from the City of Crescent City YouTube channel, pulls
 * auto-caption transcripts for new videos, and indexes them into ChromaDB.
 *
 * Requires the `yt-dlp` CLI on PATH and (for indexing) Ollama + ChromaDB
 * running, following the same preflight as `bun run index`/`bun run chat`.
 *
 * Usage:
 *   bun run scripts/run-youtube.ts
 *   bun run youtube
 */
import { monitorYouTube } from "../src/youtube_monitor.ts";
import { createLogger } from "../src/logger.ts";
import { readFile } from "fs/promises";
import { paths } from "../src/shared/paths.ts";

const logger = createLogger("run-youtube");

logger.info("=== YouTube Meeting Transcript Monitoring ===");

const results = await monitorYouTube();
const ok = results.filter((r) => r.status === "ok").length;
const unavailable = results.filter((r) => r.status === "unavailable").length;
const failed = results.filter((r) => r.status === "extraction_failed").length;

logger.info(
  `YouTube monitoring complete: ${results.length} new video(s) processed (${ok} transcribed, ${unavailable} no captions, ${failed} extraction failed)`
);
try {
  const report = JSON.parse(await readFile(paths.youtubeHealth, "utf-8")) as { sources?: Array<{ source: string; status: string; error?: string }> };
  const source = report.sources?.[0];
  if (source && (source.status === "unavailable" || source.status === "stale")) {
    logger.warn(`YouTube source is ${source.status}`, { error: source.error });
  } else if (source) {
    logger.info(`YouTube source health: ${source.status}`);
  }
} catch { /* monitor already logged the failure */ }

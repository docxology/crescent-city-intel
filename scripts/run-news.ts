#!/usr/bin/env bun
/**
 * scripts/run-news.ts — Thin orchestrator: local news RSS monitoring.
 *
 * Imports and runs the news monitoring pipeline from src/news_monitor.ts.
 * Fetches current Times-Standard, North Coast, Humboldt County, Redwood News,
 * and Redwood Voice feeds (with bounded API/HTML fallbacks)
 * and saves relevant items to output/news/.
 *
 * Usage:
 *   bun run scripts/run-news.ts
 *   bun run news
 *   bun run news -- --keywords="tsunami,earthquake"
 *
 * CLI flags:
 *   --keywords=term1,term2   Override default filter keywords (comma-separated)
 *   --no-dedup               Skip persistent deduplication (useful for testing)
 */
import { monitorNews } from "../src/news_monitor.ts";
import { createLogger } from "../src/logger.ts";
import { readFile } from "fs/promises";
import { paths } from "../src/shared/paths.ts";

const logger = createLogger("run-news");

// Parse CLI args
const args = process.argv.slice(2);
const keywordsArg = args.find(a => a.startsWith("--keywords="));
const filterKeywords = keywordsArg
  ? keywordsArg.replace("--keywords=", "").split(",").map(k => k.trim()).filter(Boolean)
  : undefined;
const noDedup = args.includes("--no-dedup");

logger.info("=== Local News Monitoring ===");
if (filterKeywords) {
  logger.info(`Filtering with custom keywords: ${filterKeywords.join(", ")}`);
}

const items = await monitorNews(filterKeywords, { noDedup });
let health: Array<{ source: string; status: string }> = [];
try {
  const report = JSON.parse(await readFile(paths.newsHealth, "utf-8")) as { sources?: Array<{ source: string; status: string }> };
  health = report.sources ?? [];
} catch { /* monitor already logged the fetch failure */ }
const missing = health.filter(source => source.status === "unavailable" || source.status === "stale");
logger.info(`News monitoring complete: ${items.length} new relevant item(s) saved to output/news/`, {
  sourceHealth: health.map(source => `${source.source}:${source.status}`),
});
if (missing.length > 0) {
  logger.warn(`${missing.length} news source(s) are unavailable or stale; this is recorded as a coverage gap, not a failed run`, {
    sources: missing.map(source => source.source),
  });
}

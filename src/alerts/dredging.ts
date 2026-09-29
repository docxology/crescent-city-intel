#!/usr/bin/env bun
/**
 * Crescent City Harbor District dredging / marine-construction monitor (#17).
 *
 * Roadmap item: the 🔴 TODO "New monitors: permits, dredging, fuel". The
 * Harbor District (the port authority that owns the Crescent City harbor,
 * its channel approach and Citizens Dock) publishes operational news as
 * posts at www.ccharbor.com. The site has no RSS feed (wp-json and /feed/
 * are disabled) but a standard sitemap.xml, which this monitor reads.
 *
 * What this monitor observes: posts whose slugs carry dredging or
 * marine-construction keywords (dredge, channel, jetty, seawall, breakwater,
 * dock, pier, boat ramp, berth). Sitemap slugs are the post titles, so a new
 * "2026-dredging-update" post is a sitemap row; lastmod carries its date.
 * This is change detection over the harbor's public news surface, not a
 * dredge-position reading — there is no real-time dredge-location feed, and
 * this monitor will never fabricate one.
 *
 * Fetch plan (bounded): one GET of the sitemap (~60 KB today), one retry,
 * with a size cap enforced by the parser. USACE SPN's dredging schedule page
 * was evaluated as a secondary source (probed 2026-09-28: 403 from a datacenter
 * network) and is recorded as a future source, not wired.
 *
 * Usage: bun run src/alerts/dredging.ts
 * Output: output/alerts/dredging/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  writeJsonAtomic,
  appendBoundedJsonlSync,
} from "../shared/source_health.js";
import { outputRoot } from "../shared/paths.js";
import { IdempotencyStore, hashContent } from "../shared/idempotency.js";
import { boundedFetchText } from "./connector.js";

const logger = createLogger("dredging_alert");

export const CCHARBOR_SITEMAP_URL = "https://www.ccharbor.com/sitemap.xml";
export const DREDGING_SOURCE_NAME = "Crescent City Harbor District";
/** How far back a sitemap post counts as an active marine-construction item. */
export const DREDGING_WINDOW_DAYS = 90;
/** Hard cap on the sitemap the parser will accept — a bounded fetch discipline. */
export const CCHARBOR_SITEMAP_MAX_BYTES = 2_000_000;

const outputDir = (): string => join(outputRoot(), "alerts", "dredging");
export function dredgingHistoryPath(): string {
  return join(outputDir(), "history.jsonl");
}
export function dredgingCurrentPath(): string {
  return join(outputDir(), "current.json");
}
export function dredgingSeenPath(): string {
  return join(outputDir(), "seen-ids.json");
}

let lastDredgingError: string | undefined;
export function getLastDredgingError(): string | undefined {
  return lastDredgingError;
}

export type DredgingLevel = "CALM" | "ADVISORY";

export interface DredgingPost {
  /** Post URL from the sitemap. */
  url: string;
  /** Title derived from the slug (the sitemap carries no <title>). */
  title: string;
  /** ISO date of the sitemap <lastmod>, or "" when absent. */
  lastmod: string;
  /** Keywords that matched the slug. */
  matchedKeywords: string[];
  /** True when the slug named an actual dredging operation (not just nearby marine work). */
  isDredging: boolean;
}

export interface DredgingReport {
  fetchedAt: string;
  sourceUrl: string;
  windowDays: number;
  /** Every URL in the sitemap this run. */
  totalUrls: number;
  /** In-window posts matching the dredging / marine-construction keyword sets. */
  items: DredgingPost[];
  relevantCount: number;
  worstLevel: DredgingLevel;
  summary: string;
}

/** Dredging-first keywords; a match reads as an active dredging item. */
export const DREDGING_KEYWORDS = ["dredge", "dredging", "channel", "jetty"] as const;
/** Adjacent marine-construction keywords; a match alone is advisory-class context. */
export const MARINE_CONSTRUCTION_KEYWORDS = [
  "seawall", "breakwater", "dock", "pier", "boat ramp", "berth", "marina",
] as const;

/** "the-crescent-city-harbor-district-is-inviting-proposals-for-a-..." → "The Crescent City Harbor District Is Inviting Proposals For A ..." */
export function slugToTitle(slug: string): string {
  const stripped = slug.replace(/^https?:\/\//, "").replace(/\/$/, "").split("/").pop() ?? "";
  const withoutDate = stripped.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-\d{4}-\d{2}-\d{2}-/, "-");
  return withoutDate
    .split("-")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Parse the harbor's sitemap into {url, lastmod} rows. THROWS on an empty
 * body, a non-sitemap document, or zero URLs — a sitemap that parses to
 * nothing means the site moved or a CDN wall moved in, and that must surface
 * as an unavailable error, never as a silent "no harbor activity".
 */
export function parseHarborSitemap(xml: string): Array<{ url: string; lastmod: string }> {
  if (!xml || !/<urlset/i.test(xml)) {
    throw new Error("ccharbor sitemap carried no <urlset> — source format changed or blocked");
  }
  const rows = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?\s*<\/url>/g)]
    .map(match => ({ url: match[1]!.trim(), lastmod: (match[2] ?? "").trim() }));
  if (rows.length === 0) {
    throw new Error("ccharbor sitemap parsed to zero URLs — source format changed");
  }
  return rows;
}

/** Keyword filter over a post URL (the slug is the title). Case-insensitive substrings. */
export function matchDredgingKeywords(url: string): { matchedKeywords: string[]; isDredging: boolean } {
  const haystack = url.toLowerCase().replace(/-/g, " ");
  const dredge = DREDGING_KEYWORDS.filter(keyword => haystack.includes(keyword));
  const construction = MARINE_CONSTRUCTION_KEYWORDS.filter(keyword => haystack.includes(keyword));
  return { matchedKeywords: [...dredge, ...construction], isDredging: dredge.length > 0 };
}

/**
 * Build the report from parsed sitemap rows (pure; no I/O). Posts older than
 * the window are excluded from `items` (counted in totalUrls), and a post
 * without a parseable lastmod is excluded rather than assumed recent.
 */
export function buildDredgingReport(
  rows: Array<{ url: string; lastmod: string }>,
  now = new Date().toISOString(),
): DredgingReport {
  const nowMs = Date.parse(now);
  const windowStartMs = nowMs - DREDGING_WINDOW_DAYS * 24 * 3600 * 1000;
  const items: DredgingPost[] = [];
  for (const row of rows) {
    const { matchedKeywords, isDredging } = matchDredgingKeywords(row.url);
    if (matchedKeywords.length === 0) continue;
    const lastmodMs = row.lastmod ? Date.parse(row.lastmod) : Number.NaN;
    if (!Number.isFinite(lastmodMs) || lastmodMs < windowStartMs || lastmodMs > nowMs) continue;
    items.push({ url: row.url, title: slugToTitle(row.url), lastmod: row.lastmod, matchedKeywords, isDredging });
  }
  items.sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod));
  const worstLevel: DredgingLevel = items.length > 0 ? "ADVISORY" : "CALM";
  const dredgingCount = items.filter(item => item.isDredging).length;
  const summary = items.length === 0
    ? `No harbor dredging or marine-construction posts in the ${DREDGING_WINDOW_DAYS}-day window (${rows.length} sitemap URLs scanned).`
    : `${items.length} harbor marine-work post(s) in the ${DREDGING_WINDOW_DAYS}-day window, ${dredgingCount} dredging-related: ` +
      items.slice(0, 3).map(item => item.title).join("; ") +
      (items.length > 3 ? `, +${items.length - 3} more` : "");
  return {
    fetchedAt: now,
    sourceUrl: CCHARBOR_SITEMAP_URL,
    windowDays: DREDGING_WINDOW_DAYS,
    totalUrls: rows.length,
    items,
    relevantCount: items.length,
    worstLevel,
    summary,
  };
}

/** Append one history record per in-window post newly observed (deduped by URL). */
export async function appendDredgingHistory(
  items: DredgingPost[],
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  if (items.length === 0) return;
  await mkdir(outputDir(), { recursive: true });
  const store = new IdempotencyStore(dredgingSeenPath());
  await store.load();
  for (const item of items) {
    const urlHash = await hashContent(item.url);
    const id = `dredging-${urlHash.slice(0, 12)}`;
    const result = store.seen(id, item.lastmod || "");
    if (!result.isNew && !result.changed) continue;
    appendBoundedJsonlSync(dredgingHistoryPath(), JSON.stringify({
      id,
      type: "dredging",
      title: item.title,
      url: item.url,
      lastmod: item.lastmod,
      isDredging: item.isDredging,
      level: "ADVISORY",
      summary: item.title,
      fetchedAt,
    }));
  }
  await store.save();
}

/** Bounded live fetch through the shared connector. The parser's own cap is the second fence. */
function fetchHarborSitemap(): Promise<string> {
  return boundedFetchText(CCHARBOR_SITEMAP_URL, {
    label: "ccharbor sitemap",
    maxBytes: CCHARBOR_SITEMAP_MAX_BYTES,
  });
}

/** Run the monitor: fetch, parse, keyword-filter, persist current.json + deduped history. */
export async function runDredgingMonitor(): Promise<DredgingReport | null> {
  logger.info("Checking Crescent City Harbor District for dredging / marine-construction posts");
  lastDredgingError = undefined;
  try {
    const rows = parseHarborSitemap(await fetchHarborSitemap());
    const report = buildDredgingReport(rows);

    await mkdir(outputDir(), { recursive: true });
    await writeJsonAtomic(dredgingCurrentPath(), report);
    await appendDredgingHistory(report.items, report.fetchedAt);

    if (report.relevantCount > 0) {
      logger.warn("Harbor dredging: " + report.summary);
    } else {
      logger.info("Harbor dredging check: " + report.summary);
    }
    return report;
  } catch (err) {
    lastDredgingError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to check the harbor sitemap", { error: lastDredgingError });
    return null;
  }
}

if (import.meta.main) {
  runDredgingMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Harbor dredging check failed — see logs");
  });
}
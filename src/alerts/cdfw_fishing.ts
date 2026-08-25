/**
 * CDFW Commercial Fishing & Dungeness Crab Season Monitor
 * for Crescent City, CA.
 *
 * Crescent City is one of California's primary Dungeness crab landing ports.
 * This module fetches current CDFW marine bulletins and fishing season status.
 *
 * Data sources:
 * - CDFW Marine Bulletins: https://nrm.dfg.ca.gov/FileHandler.ashx?DocumentID=X
 * - CDFW Ocean Fishing Regulations: https://wildlife.ca.gov/Fishing/Ocean/Regulations
 * - PacFIN landing data: https://pacfin.psmfc.org (requires data sharing agreement)
 *
 * Output: output/fishing/fishing-<timestamp>.json
 */
import { createLogger } from "../logger.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { SOURCE_FETCH_TIMEOUT_MS, appendBoundedJsonl } from "../shared/source_health.js";

const logger = createLogger("cdfw-fishing");

const OUTPUT_DIR = join(process.cwd(), "output", "fishing");
// NB: must be `history.jsonl` in output/fishing/ — alert_analytics.ts reads this
// exact path for the unified alert timeline. Previously the fishing monitor wrote
// no history file at all, so fishing never appeared in the timeline/stats.
export const FISHING_HISTORY_PATH = join(OUTPUT_DIR, "history.jsonl");

// ─── Types ────────────────────────────────────────────────────────

export interface CrabSeasonStatus {
  fetchedAt: string;
  /** Whether the commercial Dungeness crab season is currently open */
  commercialOpen: boolean;
  /** Whether the recreational Dungeness crab season is currently open */
  recreationalOpen: boolean;
  /** Description of current status */
  statusNote: string;
  /** Source URL */
  sourceUrl: string;
}

export interface FishingBulletin {
  fetchedAt: string;
  title: string;
  date: string;
  content: string;
  url: string;
  /** Full article body text fetched from the linked page, if available. */
  fullContent?: string;
}

export interface FishingReport {
  fetchedAt: string;
  crabStatus: CrabSeasonStatus;
  bulletins: FishingBulletin[];
  summary: string;
}

// ─── HTML body extraction ─────────────────────────────────────────

/**
 * Extract the main article body text from a CDFW Marine Management News HTML
 * page. Tries common article containers in order, then falls back to joining
 * all <p> tags. Returns plain text with HTML stripped.
 */
export function extractBulletinBody(html: string): string {
  // Try <article>...</article> first
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let body = articleMatch ? articleMatch[1] : html;

  // Try <main> or #content or .content if <article> was not found
  if (!articleMatch) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) {
      body = mainMatch[1];
    } else {
      const contentMatch = html.match(/<div[^>]*(?:id=["']content["']|class=["'][^"']*content[^"']*["'])[^>]*>([\s\S]*?)<\/div>/i);
      if (contentMatch) {
        body = contentMatch[1];
      }
    }
  }

  // Extract <p> tag text, join with newlines
  const pMatches = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  let text: string;
  if (pMatches.length > 0) {
    text = pMatches.map(m => m[1]).join("\n\n");
  } else {
    // Fallback: strip all HTML tags
    text = body.replace(/<[^>]+>/g, "").trim();
  }

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Fetch the full body text of a CDFW Marine Management News bulletin page.
 * Gracefully returns an empty string on any failure (network error, timeout,
 * non-200, or parse failure). Never throws.
 */
export async function fetchBulletinBody(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      logger.warn(`Bulletin body fetch returned HTTP ${resp.status} for ${url}`);
      return "";
    }

    const html = await resp.text();
    const body = extractBulletinBody(html);

    if (!body) {
      logger.warn(`Could not extract body text from ${url}`);
      return "";
    }

    return body;
  } catch (err: any) {
    logger.warn(`Failed to fetch bulletin body from ${url}`, { error: err.message });
    return "";
  }
}

// ─── CDFW Bulletin Fetch ──────────────────────────────────────────

/**
 * Fetch the current CDFW marine bulletin page for North Coast (Districts 1-3).
 * Returns parsed bulletin items, or empty array if unavailable.
 */
export async function fetchCdfwBulletins(): Promise<FishingBulletin[]> {
  const url = "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins";
  logger.info("Fetching CDFW marine bulletins", { url });

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      logger.warn(`CDFW bulletins returned HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const bulletins: FishingBulletin[] = [];

    // Parse bulletin links — CDFW uses anchored list items with dates
    // Pattern: <a href="...">BULLETIN TITLE</a> ... date text
    const linkPattern = /<a\s+href="([^"]+)"[^>]*>([^<]+bulletin[^<]*)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = linkPattern.exec(html)) !== null) {
      const href = match[1];
      const title = match[2].trim();
      const fullUrl = href.startsWith("http") ? href : `https://wildlife.ca.gov${href}`;

      // Only include bulletins relevant to North Coast / crab
      const lowerTitle = title.toLowerCase();
      if (
        lowerTitle.includes("dungeness") ||
        lowerTitle.includes("crab") ||
        lowerTitle.includes("north coast") ||
        lowerTitle.includes("district 1") ||
        lowerTitle.includes("district 2") ||
        lowerTitle.includes("district 3") ||
        lowerTitle.includes("crescent city")
      ) {
        // The anchor/link sometimes carries a publish date (YYYY-MM-DD or
        // MM/DD/YYYY). Extract it if present rather than stamping every bulletin
        // with today's date (the prior behavior misrepresented publish date).
        // When no date is parseable, leave it empty (honest "unknown").
        const dateMatch = `${href} ${title}`.match(/(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        const date = dateMatch
          ? (dateMatch[1]
              ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
              : `${dateMatch[6]}-${String(dateMatch[4]).padStart(2, "0")}-${String(dateMatch[5]).padStart(2, "0")}`)
          : "";
        bulletins.push({
          fetchedAt: new Date().toISOString(),
          title,
          date,
          content: `CDFW bulletin: ${title}`,
          url: fullUrl,
        });
      }
    }

    // Fetch full body text for each bulletin URL in parallel
    if (bulletins.length > 0) {
      const bodies = await Promise.all(
        bulletins.map(b => fetchBulletinBody(b.url))
      );
      for (let i = 0; i < bulletins.length; i++) {
        if (bodies[i]) {
          bulletins[i].fullContent = bodies[i];
        }
      }
    }

    logger.info(`Found ${bulletins.length} relevant CDFW bulletins`);
    return bulletins;
  } catch (err: any) {
    logger.error("Failed to fetch CDFW bulletins", { error: err.message });
    return [];
  }
}

/**
 * Determine current Dungeness crab season status based on California regulations.
 *
 * Standard CA commercial Dungeness crab season:
 * - Commercial: Opens first Tuesday on or after Nov 15 (Districts 1-4)
 * - Closes June 30 of following year (unless extended/delayed by CDFW)
 * - Recreational: Nov 4 – June 30
 *
 * This is a rule-based estimate; actual opener may be delayed by CDFW
 * for domoic acid or whale entanglement concerns.
 */
export function estimateCrabSeasonStatus(): CrabSeasonStatus {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-based
  const day = now.getDate();

  // Recreational season: Nov 4 – Jun 30
  const recreationalOpen =
    (month === 11 && day >= 4) ||
    (month === 12) ||
    (month >= 1 && month <= 6);

  // Commercial season: ~Nov 15 (first Tue on/after) – Jun 30
  const commercialOpen =
    (month === 11 && day >= 15) ||
    (month === 12) ||
    (month >= 1 && month <= 6);

  const status = commercialOpen
    ? "Commercial and recreational Dungeness crab seasons are estimated OPEN (verify with latest CDFW bulletin for domoic acid/entanglement delays)"
    : month === 11
    ? "Pre-season: commercial opener expected on/after Nov 15 — check CDFW for official opener"
    : "Dungeness crab season is estimated CLOSED (July–October)";

  return {
    fetchedAt: new Date().toISOString(),
    commercialOpen,
    recreationalOpen,
    statusNote: status,
    sourceUrl: "https://wildlife.ca.gov/Fishing/Ocean/Regulations/Bulletins",
  };
}

// ─── Main report ─────────────────────────────────────────────────

/** Run the full fishing monitor: season status + CDFW bulletins. */
export async function monitorFishing(): Promise<FishingReport> {
  logger.info("=== Starting CDFW Crescent City Fishing Monitor ===");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const [bulletins, crabStatus] = await Promise.all([
    fetchCdfwBulletins(),
    Promise.resolve(estimateCrabSeasonStatus()),
  ]);

  const summary = [
    `Crab commercial: ${crabStatus.commercialOpen ? "OPEN (estimated)" : "CLOSED (estimated)"}`,
    `Crab recreational: ${crabStatus.recreationalOpen ? "OPEN (estimated)" : "CLOSED (estimated)"}`,
    `CDFW bulletins found: ${bulletins.length}`,
  ].join(" | ");

  const report: FishingReport = {
    fetchedAt: new Date().toISOString(),
    crabStatus,
    bulletins,
    summary,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(OUTPUT_DIR, `fishing-${ts}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2));

  // Append a one-line history record so the fishing monitor appears in the
  // unified alert timeline/analytics (it previously wrote no history file at all).
  const closureActive = !report.crabStatus.commercialOpen || !report.crabStatus.recreationalOpen;
  await appendBoundedJsonl(FISHING_HISTORY_PATH, {
    fetchedAt: report.fetchedAt,
    crabCommercialOpen: report.crabStatus.commercialOpen,
    crabRecreationalOpen: report.crabStatus.recreationalOpen,
    level: closureActive ? "WATCH" : "CALM",
    summary,
  });

  logger.info(summary);
  logger.info(`Fishing report saved: ${outPath}`);
  logger.info("=== CDFW Fishing Monitor Complete ===");
  return report;
}

// CLI entry point
if (import.meta.main) {
  monitorFishing().catch((err: any) => {
    logger.error("Fishing monitor failed", { error: err.message });
    process.exit(1);
  });
}

#!/usr/bin/env bun
import { outputRoot } from "../shared/paths.js";
/**
 * PG&E Public Safety Power Shutoff (PSPS) Monitor for Del Norte County.
 *
 * Fetches PSPS event data from PG&E and checks whether Del Norte County
 * is in an active, planned, or monitored PSPS event.
 *
 * Source: the official browser-rendered PG&E PSPS event page.
 *
 * Usage:
 *   bun run src/alerts/pge_psps.ts
 *
 * Output: output/alerts/psps/current.json
 */
import { createLogger } from "../logger.js";
import { mkdir } from "fs/promises";
import { join } from "path";
import { launchBrowser, closeBrowser } from "../browser.js";
import type { Page } from "playwright";
import { writeJsonAtomic } from "../shared/source_health.js";

const logger = createLogger("pge_psps_alert");

function HISTORY_DIR(): string { return join(outputRoot(), "alerts", "psps"); }
function CURRENT_FILE(): string { return join(HISTORY_DIR(), "current.json"); }
let lastPspsError: string | undefined;

export function getLastPspsError(): string | undefined {
  return lastPspsError;
}

export type PspsStatus = "NONE" | "MONITORED" | "PLANNED" | "ACTIVE" | "RESTORATION";

export interface PspsEvent {
  /** Event ID */
  id: string;
  /** Event name */
  name: string;
  /** Current PSPS status */
  status: PspsStatus;
  /** Counties affected */
  counties: string[];
  /** Number of customers affected */
  customersAffected: number | null;
  /** Event start date ISO */
  startDate: string | null;
  /** Estimated restoration date ISO */
  estimatedRestoration: string | null;
  /** Whether Del Norte County is specifically affected */
  affectsDelNorte: boolean;
}

export interface PspsReport {
  timestamp: string;
  /** All active PSPS events affecting the region */
  events: PspsEvent[];
  /** Total events found */
  totalEvents: number;
  /** Overall PSPS status for Del Norte County */
  overallStatus: PspsStatus;
  /** Whether any event is active in Del Norte County */
  delNorteAffected: boolean;
  /** Human-readable summary */
  summary: string;
}

export function classifyPspsStatus(statusText: string): PspsStatus {
  const s = statusText.trim().toLowerCase();
  if (s.includes("active")) return "ACTIVE";
  if (s.includes("planned") || s.includes("warning")) return "PLANNED";
  if (s.includes("monitor")) return "MONITORED";
  if (s.includes("restor")) return "RESTORATION";
  return "NONE";
}

/**
 * PG&E PSPS event-state reader (browser-rendered; verified live 2026-08-30).
 * The official event page embeds only i18n template copy in its static HTML;
 * the real state ("no active PSPS events" vs announced events)
 * is rendered client-side. We render the page with the repo's existing
 * Playwright browser and read the settled text; an unrecognized state is an
 * error, never a guess.
 */
export const PGE_PSPS_PAGE_URL = "https://pgealerts.alerts.pge.com/pg-e-partners/psps-events/";

export interface PspsPageState {
  active: boolean;
  /**
   * Whether the page text names Del Norte County in the context of the event.
   *
   * `null` means the page was read but carried no county list to judge from —
   * a real fact about our confidence, and materially different from `false`
   * ("PG&E named counties, none of them Del Norte"). It is what lets
   * `delNorteAffected` be derived instead of hardcoded: the composite's
   * documented WARNING tier is "an active PSPS event *in Del Norte*", and with
   * the flag pinned to `false` that tier was unreachable on the live path, so
   * an ACTIVE PSPS in Crescent City rendered as a regional WATCH.
   */
  delNorteAffected: boolean | null;
  statusText: string;
}

/** The counties Crescent City actually sits in, as PG&E names them. */
const DEL_NORTE_COUNTY = /\bdel\s+norte\b/i;

export async function fetchPspsPageState(): Promise<PspsPageState> {
  const ctx = await launchBrowser();
  let page: Page | null = null;
  try {
    page = await ctx.newPage();
    await page.goto(PGE_PSPS_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000);
    const text = await page.evaluate(() => document.body.innerText);
    const hasNoActive = /no active PSPS events/i.test(text);
    const hasAnnounced = !hasNoActive && /has been announced/i.test(text);
    if (!hasNoActive && !hasAnnounced) {
      throw new Error("PG&E PSPS page state unrecognized - refusing to guess");
    }
    // Derive the county flag from the page rather than hardcoding it. The
    // "no active events" page is authoritative evidence that Del Norte is NOT
    // affected; an announced-events page is not, so it reports the county list
    // only when the text actually names one.
    const delNorteAffected = hasAnnounced
      ? (DEL_NORTE_COUNTY.test(text) ? true : null)
      : false;
    return {
      active: hasAnnounced,
      delNorteAffected,
      statusText: hasAnnounced
        ? delNorteAffected === true
          ? "PSPS activity announced on the official PG&E event page; Del Norte County named"
          : "PSPS activity announced on the official PG&E event page; open the event page for county details."
        : "No active PSPS events (official PG&E event page)",
    };
  } finally {
    await closeBrowser();
  }
}

/** Main monitor entry point */
export async function runPSPSMonitor(): Promise<PspsReport | null> {
  logger.info("Checking PG&E PSPS events for Del Norte County");
  lastPspsError = undefined;

  // PRIMARY: official event-page state (verified live 2026-08-30).
  try {
    const state = await fetchPspsPageState();
    const overallStatus: PspsStatus = state.active ? "ACTIVE" : "NONE";
    const report: PspsReport = {
      timestamp: new Date().toISOString(),
      events: [],
      totalEvents: 0,
      overallStatus,
      // Derived from the page. `null` (announced, but no county list) is not
      // `false`: it means "cannot tell", and severity.ts treats the three
      // states differently so an active event in Del Norte can reach its
      // documented WARNING tier instead of being flattened to a regional WATCH.
      delNorteAffected: state.delNorteAffected === true,
      summary: state.statusText,
    };
    await mkdir(HISTORY_DIR(), { recursive: true });
    await writeJsonAtomic(CURRENT_FILE(), report);
    if (state.active) logger.warn("PSPS ACTIVE: " + report.summary);
    else logger.info("PSPS check: " + report.summary);
    return report;
  } catch (err) {
    lastPspsError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to read PG&E PSPS event page", { error: lastPspsError });
    return null;
  }
}

if (import.meta.main) {
  runPSPSMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("PSPS monitor check failed --- see logs");
  });
}

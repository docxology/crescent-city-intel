#!/usr/bin/env bun
/**
 * PG&E Public Safety Power Shutoff (PSPS) Monitor for Del Norte County.
 *
 * Fetches PSPS event data from PG&E and checks whether Del Norte County
 * is in an active, planned, or monitored PSPS event.
 *
 * API: PG&E PSPS API (https://pge-psps-updates.us-east-1.linodeobjects.com or pge.com/api/psps/alerts)
 *
 * See: https://www.pge.com/en/outages-and-safety-safety/psps-updates.html
 *
 * Usage:
 *   bun run src/alerts/pge_psps.ts
 *
 * Output: output/alerts/psps/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { launchBrowser, closeBrowser } from "../browser.js";
import type { Page } from "playwright";
import { SOURCE_FETCH_TIMEOUT_MS, writeJsonAtomic, appendBoundedJsonlSync } from "../shared/source_health.js";

const logger = createLogger("pge_psps_alert");

/** Public PG&E PSPS event data endpoint. */
export const PGE_PSPS_API_URL = "https://pge-psps-updates.us-east-1.linodeobjects.com/psps_events.json";
/** PG&E PSPS updates page (used as fallback source-of-truth URL). */
export const PGE_PSPS_WEB_URL = "https://www.pge.com/en/outages-and-safety-safety/psps-updates.html";

const TARGET_COUNTIES = ["Del Norte", "Humboldt", "Siskiyou", "Trinity"];
const HISTORY_DIR = join(process.cwd(), "output", "alerts", "psps");
const HISTORY_FILE = join(HISTORY_DIR, "history.jsonl");
const CURRENT_FILE = join(HISTORY_DIR, "current.json");
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

const PSPS_SEVERITY: Record<PspsStatus, number> = {
  NONE: 0,
  MONITORED: 1,
  PLANNED: 2,
  ACTIVE: 3,
  RESTORATION: 1,
};

function loadProcessedIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(HISTORY_FILE)) return ids;
  try {
    const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { ids.add(JSON.parse(line).id); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function appendHistory(event: PspsEvent): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const record = JSON.stringify({ ...event, fetchedAt: new Date().toISOString() });
    appendBoundedJsonlSync(HISTORY_FILE, record);
  } catch (err) {
    logger.warn("Failed to append PSPS history", { error: String(err) });
  }
}

export function classifyPspsStatus(statusText: string): PspsStatus {
  const s = statusText.trim().toLowerCase();
  if (s.includes("active")) return "ACTIVE";
  if (s.includes("planned") || s.includes("warning")) return "PLANNED";
  if (s.includes("monitor")) return "MONITORED";
  if (s.includes("restor")) return "RESTORATION";
  return "NONE";
}

function normalizeCounty(name: string): string {
  return name.trim().toLowerCase().replace(/ co(u|n)ty$/, "").trim();
}

/** Fetch PSPS events from PG&E. */
/**
 * PG&E PSPS event-state reader (browser-rendered; verified live 2026-08-30).
 * The old pge-psps-updates.linodeobjects.com JSON now 404s, and the official
 * pgealerts.alerts.pge.com event page embeds only i18n template copy in its
 * static HTML - the real state ("no active PSPS events" vs announced events)
 * is rendered client-side. We render the page with the repo's existing
 * Playwright browser and read the settled text; an unrecognized state is an
 * error, never a guess.
 */
export const PGE_PSPS_PAGE_URL = "https://pgealerts.alerts.pge.com/pg-e-partners/psps-events/";

export interface PspsPageState {
  active: boolean;
  statusText: string;
}

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
    return {
      active: hasAnnounced,
      statusText: hasAnnounced
        ? "PSPS activity indicated on the official PG&E event page"
        : "No active PSPS events (official PG&E event page)",
    };
  } finally {
    await closeBrowser();
  }
}


export async function fetchPspsEventsLegacy(): Promise<PspsEvent[]> {
  const response = await fetch(PGE_PSPS_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("PG&E PSPS API returned " + response.status + ": " + response.statusText);
  }
  const payload = await response.json() as any;

  // Handle both array and { events: [...] } wrappers
  const rawEvents: any[] = Array.isArray(payload)
    ? payload
    : payload?.events ?? payload?.data ?? [];

  const events: PspsEvent[] = [];
  for (const raw of rawEvents) {
    const rawCounties: string[] = raw.counties ?? raw.affectedCounties ?? raw.impactedAreas ?? [];
    const countyList = rawCounties.map((c: any) => String(c));

    const matches = TARGET_COUNTIES.some(tc =>
      countyList.some((rc: string) => normalizeCounty(rc) === normalizeCounty(tc))
    );
    if (!matches) continue;

    const statusText = String(raw.status ?? raw.pspsStatus ?? raw.eventStatus ?? "");
    const status = classifyPspsStatus(statusText);
    const countyNames = countyList.filter((c: string) =>
      TARGET_COUNTIES.some(tc => normalizeCounty(c) === normalizeCounty(tc))
    );

    const ev: PspsEvent = {
      id: String(raw.id ?? raw.eventId ?? raw.pspsId ?? ""),
      name: String(raw.name ?? raw.eventName ?? raw.title ?? "PSPS Event"),
      status,
      counties: countyList,
      customersAffected: Number.isFinite(Number(raw.customersAffected ?? raw.customers ?? 0))
        ? Number(raw.customersAffected ?? raw.customers ?? 0) || null
        : null,
      startDate: raw.startDate ?? raw.startedAt ?? raw.estimatedStart ?? null,
      estimatedRestoration: raw.estimatedRestoration ?? raw.restorationDate ?? raw.estimatedRestore ?? null,
      affectsDelNorte: countyNames.some(c => normalizeCounty(c) === normalizeCounty("Del Norte")),
    };
    events.push(ev);
  }

  return events;
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
      delNorteAffected: false,
      summary: state.active
        ? "PG&E official event page indicates PSPS activity; open the event page for county details."
        : "No active PSPS events (official PG&E event page).",
    };
    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);
    if (state.active) logger.warn("PSPS ACTIVE: " + report.summary);
    else logger.info("PSPS check: " + report.summary);
    return report;
  } catch (err) {
    lastPspsError = err instanceof Error ? err.message : String(err);
    logger.warn("PSPS page-state check failed; trying legacy JSON events", { error: lastPspsError });
  }

  // FALLBACK: legacy linode JSON (404 since ~2026-08; retained for restoration).
  try {
    const events = await fetchPspsEventsLegacy();

    let overallStatus: PspsStatus = "NONE";
    let delNorteAffected = false;
    for (const ev of events) {
      if (PSPS_SEVERITY[ev.status] > PSPS_SEVERITY[overallStatus]) {
        overallStatus = ev.status;
      }
      if (ev.affectsDelNorte) delNorteAffected = true;
    }

    const report: PspsReport = {
      timestamp: new Date().toISOString(),
      events,
      totalEvents: events.length,
      overallStatus,
      delNorteAffected,
      summary: events.length === 0
        ? "No active PSPS events in Del Norte region"
        : overallStatus + " PSPS: " + events.length + " event(s)" +
          (delNorteAffected ? " - Del Norte County affected" : " - Del Norte not directly affected") +
          ". " + events.map(e => e.name + " (" + e.status + ")").join("; "),
    };

    await mkdir(HISTORY_DIR, { recursive: true });
    await writeJsonAtomic(CURRENT_FILE, report);

    if (delNorteAffected && overallStatus === "ACTIVE") {
      logger.warn("PSPS ACTIVE: " + report.summary);
    } else if (overallStatus === "PLANNED") {
      logger.warn("PSPS PLANNED: " + report.summary);
    } else {
      logger.info("PSPS check: " + report.summary);
    }
    return report;
  } catch (err: any) {
    lastPspsError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to fetch PSPS data", { error: lastPspsError });
    return null;
  }
}

if (import.meta.main) {
  runPSPSMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("PSPS monitor check failed --- see logs");
  });
}

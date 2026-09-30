#!/usr/bin/env bun
/**
 * PacFIN (Pacific Fisheries Information Network) report-catalog monitor (#19).
 *
 * PacFIN is the joint federal/state commercial-fisheries data network
 * (PSMFC) whose fish-ticket data covers Crescent City landings. Its APEX
 * Reports Dashboard (reports.psmfc.org/pacfin/) is publicly reachable and
 * server-renders the FULL catalog of its ~76 reports as an embedded JSON
 * tree (`gTree…Data = {…}`) — that catalog is what this monitor parses.
 *
 * What this monitor observes, stated honestly: the public REPORT CATALOG
 * (report ids like ALL001, labels, tooltips), watched for new or edited
 * reports. The landing FIGURES themselves (pounds/dollars by port and
 * species) require a PacFIN account to execute — every probe without
 * credentials lands on the Public Login wall — so this monitor NEVER
 * publishes a landing reading. `landingDataAvailable` is false and the
 * report's summary says so; absent landings data is an explicit
 * unavailable state, never a fabricated catch total. A credential
 * (`PACFIN_SESSION_COOKIE`) can be supplied later to extend the connector
 * to a configured report; the connector accepts and forwards it, and
 * without it the catalog watch still runs.
 *
 * Fetch plan (bounded): one GET of the dashboard (~90 KB), one retry.
 * Parsing is strict: a page with no report-tree JSON or an empty tree
 * throws, so a dashboard redesign is a loud unavailable error.
 *
 * Usage: bun run src/alerts/pacfin.ts
 * Output: output/alerts/pacfin/current.json + history.jsonl
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

const logger = createLogger("pacfin_alert");

export const PACFIN_DASHBOARD_URL = "https://reports.psmfc.org/pacfin/";
export const PACFIN_SOURCE_NAME = "PacFIN Reports Dashboard";
/** Optional credential for the login-walled report executor. */
export const PACFIN_COOKIE_ENV = "PACFIN_SESSION_COOKIE";

const outputDir = (): string => join(outputRoot(), "alerts", "pacfin");
export function pacfinHistoryPath(): string {
  return join(outputDir(), "history.jsonl");
}
export function pacfinCurrentPath(): string {
  return join(outputDir(), "current.json");
}
export function pacfinSeenPath(): string {
  return join(outputDir(), "seen-ids.json");
}

let lastPacfinError: string | undefined;
export function getLastPacfinError(): string | undefined {
  return lastPacfinError;
}

export type PacfinLevel = "CALM" | "ADVISORY";

export interface PacfinReportNode {
  /** APEX tree node id. */
  id: string;
  /** Report code + name, e.g. "ALL001 - ALL001 WOC All Species". */
  label: string;
  /** Category path from the tree root, e.g. "All Species Reports (ALL)". */
  categoryPath: string;
  /** Public methodology tooltip, trimmed. */
  tooltip: string;
}

export interface PacfinMonitorReport {
  fetchedAt: string;
  sourceUrl: string;
  /** The public report catalog as parsed this run. */
  reports: PacfinReportNode[];
  reportCount: number;
  /** Reports that are new or whose label/tooltip changed since the last observation. */
  changedReports: Array<{ id: string; label: string; change: "new" | "edited" }>;
  /**
   * Always false today: landing figures require PacFIN credentials. When true
   * (a future credentialed connector), landing fields join this report.
   */
  landingDataAvailable: boolean;
  limitation: string;
  worstLevel: PacfinLevel;
  summary: string;
}

/**
 * Extract the APEX tree JSON and flatten it to report nodes. The dashboard
 * embeds the catalog as `gTree<digits>Data = {…}` — the numeric suffix is a
 * session-region id, so the parser matches the shape, never a literal name.
 * THROWS when no tree JSON is present or the tree carries zero leaf reports —
 * a login wall or redesign must surface as an unavailable error, never as a
 * silent "no reports".
 */
export function parsePacfinReportTree(html: string): PacfinReportNode[] {
  const varMatch = html.match(/(?:var\s+)?gTree\d+Data\s*=\s*/);
  if (!varMatch || varMatch.index === undefined) {
    throw new Error("PacFIN dashboard carried no report-tree JSON (gTree…Data absent) — source format changed or login-walled");
  }
  const start = html.indexOf("{", varMatch.index);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error("PacFIN report-tree JSON was truncated — source format changed");
  let tree: any;
  try {
    tree = JSON.parse(html.slice(start, end));
  } catch {
    throw new Error("PacFIN report-tree JSON did not parse — source format changed");
  }
  const reports: PacfinReportNode[] = [];
  const walk = (node: any, path: string[]): void => {
    for (const child of node?.children ?? []) {
      const childPath = [...path, String(child.label ?? "")];
      if (child.children && child.children.length > 0) {
        walk(child, childPath);
      } else if (child.label) {
        reports.push({
          id: String(child.id ?? ""),
          label: String(child.label),
          categoryPath: path.join(" > "),
          tooltip: String(child.tooltip ?? "").trim(),
        });
      }
    }
  };
  walk(tree?.data ?? tree, []);
  if (reports.length === 0) {
    throw new Error("PacFIN report tree parsed to zero reports — source format changed");
  }
  return reports;
}

/** Content hash over one report node's identity. */
async function reportContentHash(report: PacfinReportNode): Promise<string> {
  return hashContent(`${report.label}|${report.categoryPath}|${report.tooltip}`);
}

/**
 * Diff the parsed catalog against the shared idempotency store. The first
 * ever observation (empty store) is a baseline, not an alarm.
 */
export async function detectPacfinReportChanges(
  reports: PacfinReportNode[],
  store: IdempotencyStore,
): Promise<Array<{ id: string; label: string; change: "new" | "edited" }>> {
  const wasEmpty = store.size === 0;
  const changed: Array<{ id: string; label: string; change: "new" | "edited" }> = [];
  for (const report of reports) {
    const result = store.seen(`pacfin-report-${report.id}`, await reportContentHash(report), { label: report.label });
    if (wasEmpty) continue;
    if (result.isNew) changed.push({ id: report.id, label: report.label, change: "new" });
    else if (result.changed) changed.push({ id: report.id, label: report.label, change: "edited" });
  }
  return changed;
}

/** Build the monitor report from parsed report nodes (pure; no I/O). */
export function buildPacfinReport(
  reports: PacfinReportNode[],
  changedReports: Array<{ id: string; label: string; change: "new" | "edited" }>,
  now = new Date().toISOString(),
): PacfinMonitorReport {
  const worstLevel: PacfinLevel = changedReports.length > 0 ? "ADVISORY" : "CALM";
  const summary = changedReports.length === 0
    ? `PacFIN report catalog unchanged (${reports.length} public reports); landing figures remain credential-gated and are NOT read.`
    : `${changedReports.length} PacFIN report catalog change(s): ` +
      changedReports.slice(0, 3).map(report => `${report.label} (${report.change})`).join(", ") +
      (changedReports.length > 3 ? `, +${changedReports.length - 3} more` : "") +
      ". Landing figures remain credential-gated and are NOT read.";
  return {
    fetchedAt: now,
    sourceUrl: PACFIN_DASHBOARD_URL,
    reports,
    reportCount: reports.length,
    changedReports,
    landingDataAvailable: false,
    limitation: "PacFIN landing figures require PacFIN credentials; the public catalog is monitored and no catch total is fabricated.",
    worstLevel,
    summary,
  };
}

/** Append one history record per catalog change. */
export async function appendPacfinHistory(
  changedReports: Array<{ id: string; label: string; change: "new" | "edited" }>,
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  if (changedReports.length === 0) return;
  await mkdir(outputDir(), { recursive: true });
  for (const report of changedReports) {
    const labelHash = await hashContent(report.label);
    appendBoundedJsonlSync(pacfinHistoryPath(), JSON.stringify({
      id: `pacfin-${report.id}-${labelHash.slice(0, 8)}`,
      type: "pacfin",
      reportId: report.id,
      label: report.label,
      change: report.change,
      level: "ADVISORY",
      summary: `PacFIN report catalog ${report.change}: ${report.label}`,
      url: PACFIN_DASHBOARD_URL,
      fetchedAt,
    }));
  }
}

const REQUEST_HEADERS = {
  "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)",
  Accept: "text/html",
} as const;

/**
 * robots.txt posture (checked live 2026-09-29): reports.psmfc.org publishes
 * `User-agent: * / Disallow: /` — automated retrieval is declined by the
 * publisher. The connector still runs the bounded fetch through the shared
 * robots gate so that decision is re-verified each run: if PacFIN ever lifts
 * the disallow (or grants a data agreement an authorized connector can rely
 * on), the catalog watch resumes without a code change; today the monitor
 * degrades to an explicit unavailable-with-reason state instead of scraping
 * against a published content-use signal.
 */
export const PACFIN_MAX_BYTES = 1_000_000;

function fetchPacfinDashboard(): Promise<string> {
  const cookie = process.env[PACFIN_COOKIE_ENV] ?? "";
  return boundedFetchText(PACFIN_DASHBOARD_URL, {
    label: "PacFIN reports dashboard",
    maxBytes: PACFIN_MAX_BYTES,
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

/** Run the monitor: fetch, parse the public catalog, diff, persist. */
export async function runPacfinMonitor(): Promise<PacfinMonitorReport | null> {
  logger.info("Checking PacFIN public report catalog (landing figures stay credential-gated)");
  lastPacfinError = undefined;
  try {
    const html = await fetchPacfinDashboard();
    const reports = parsePacfinReportTree(html);
    const store = new IdempotencyStore(pacfinSeenPath());
    await store.load();
    const changedReports = await detectPacfinReportChanges(reports, store);
    await store.save();
    const report = buildPacfinReport(reports, changedReports);

    await mkdir(outputDir(), { recursive: true });
    await writeJsonAtomic(pacfinCurrentPath(), report);
    await appendPacfinHistory(report.changedReports, report.fetchedAt);

    if (report.worstLevel === "ADVISORY") {
      logger.warn("PacFIN: " + report.summary);
    } else {
      logger.info("PacFIN check: " + report.summary);
    }
    return report;
  } catch (err) {
    lastPacfinError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to check the PacFIN dashboard", { error: lastPacfinError });
    return null;
  }
}

if (import.meta.main) {
  runPacfinMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("PacFIN check failed — see logs");
  });
}

#!/usr/bin/env bun
/**
 * City of Crescent City building-permit portal monitor (monitor #16).
 *
 * The City of Crescent City accepts building-permit applications through the MyGov public portal
 * (linked from the Building Department page:
 * https://www.crescentcity.org/departments/building/). The portal's Permits
 * module page (module=pi) is a server-rendered public catalog of the permit
 * application types the City publishes (over-the-counter, encroachment, ...),
 * each with a department, description and apply link.
 *
 * What this monitor observes — stated honestly: the City does NOT publish a
 * public register of *issued* permits (the portal's issuance lists require a
 * collaborator login), so this monitor watches the PUBLIC permit catalog for
 * newly published or edited permit types, which is the keyless, bounded slice
 * of permit activity the City actually exposes. Landing a true issued-permit
 * register would need a collaborator credential — the same honest
 * needs-credentials posture as the PacFIN monitor.
 *
 * Fetch plan (bounded): one GET of the Permits module page, one retry.
 * Parsing is strict: a page with zero catalog entries throws, so a source
 * format change is a loud unavailable error, never a silent "no permits".
 *
 * Usage: bun run src/alerts/permits.ts
 * Output: output/alerts/permits/current.json + history.jsonl
 */
import { createLogger } from "../logger.js";
import { mkdir } from "fs/promises";
import { join } from "path";
import { computeSha256 } from "../utils.js";
import {
  writeJsonAtomic,
  appendBoundedJsonlSync,
} from "../shared/source_health.js";
import { outputRoot } from "../shared/paths.js";
import { IdempotencyStore, hashContent } from "../shared/idempotency.js";
import { boundedFetchText } from "./connector.js";

const logger = createLogger("permits_alert");

/** Body-size cap for the MyGov module page (live page ~47 KB, 2026-09-29). */
export const PERMITS_MAX_BYTES = 1_000_000;

export const MYGOV_PERMITS_URL =
  "https://public.mygov.us/crescent_city_ca/module?module=pi";
export const PERMITS_SOURCE_NAME = "Crescent City Permits Portal";

/** Resolved per call so the artifact-root seam (CC_OUTPUT_DIR) is honoured at run time. */
const outputDir = (): string => join(outputRoot(), "alerts", "permits");
export function permitsHistoryPath(): string {
  return join(outputDir(), "history.jsonl");
}
export function permitsCurrentPath(): string {
  return join(outputDir(), "current.json");
}
/** Shared (id, contentHash)-keyed store — the one idempotency variant in this repo. */
export function permitsSeenPath(): string {
  return join(outputDir(), "seen-ids.json");
}

let lastPermitsError: string | undefined;
export function getLastPermitsError(): string | undefined {
  return lastPermitsError;
}

export type PermitsLevel = "CALM" | "ADVISORY";

export interface PermitEntry {
  /** MyGov template id — the stable identity of the permit application type. */
  id: string;
  /** Application type name, e.g. "Over the Counter Permit". */
  name: string;
  /** Category label from the entry, usually the same as the name. */
  category: string;
  /** Issuing department, e.g. "Building Department". */
  department: string;
  /** Public description of what the permit covers. */
  description: string;
  /** Absolute URL of the apply page when one is publicly reachable. */
  applyUrl: string;
  /** True when applying requires a MyGov account (the page links a login popup). */
  applyRequiresLogin: boolean;
}

export interface PermitsReport {
  fetchedAt: string;
  sourceUrl: string;
  /** The full public permit catalog as parsed this run. */
  permits: PermitEntry[];
  catalogSize: number;
  /** Entries that are new or whose content changed since the last observation. */
  changedEntries: Array<{ id: string; name: string; change: "new" | "edited" }>;
  /** SHA-256 over the catalog identity; stable when nothing changed. */
  catalogHash: string;
  worstLevel: PermitsLevel;
  summary: string;
}

/** Decode the handful of entities the MyGov page uses. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the server-rendered MyGov permit catalog. Entries are
 * `div.template-element[data-category][data-id][data-name][data-module="pi"]`
 * blocks carrying a title, a department subtitle, a description and an apply
 * link. THROWS when the page carries none — an empty result here means the
 * page shape changed (or a login wall moved in), and that must surface as an
 * unavailable error, never as a silent "no permits published".
 */
export function parsePermitCatalog(html: string): PermitEntry[] {
  if (!html || !html.includes("template-element")) {
    throw new Error("MyGov permits page carried no template-element markup — source format changed");
  }
  const entries: PermitEntry[] = [];
  const starts = [...html.matchAll(/<div\s+class="template-element"\s+data-category="([^"]*)"\s+data-id="(\d+)"\s+data-name="([^"]*)"\s+data-module="pi">/g)];
  for (let i = 0; i < starts.length; i += 1) {
    const [, category, id, name] = starts[i]!;
    const segment = html.slice(starts[i]!.index!, i + 1 < starts.length ? starts[i + 1]!.index! : html.length);
    const department = decodeEntities(segment.match(/class="template-department">([^<]*)</)?.[1] ?? "");
    const description = decodeEntities(segment.match(/class="template-description">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const applyHref = segment.match(/<a[^>]*href="([^"]*)"[^>]*>\s*(?:Apply for Permit|Apply)/i)?.[1] ?? "";
    const applyRequiresLogin = /^javascript/i.test(applyHref);
    const applyUrl = applyHref && !applyRequiresLogin
      ? applyHref.startsWith("http") ? applyHref : `https://public.mygov.us${applyHref}`
      : "";
    if (!name.trim()) continue;
    entries.push({ id, name: decodeEntities(name), category: decodeEntities(category), department, description, applyUrl, applyRequiresLogin });
  }
  if (entries.length === 0) {
    throw new Error("MyGov permits page parsed to zero permit entries — source format changed");
  }
  return entries;
}

/**
 * Deterministic catalog identity: SHA-256 over the sorted, id-prefixed
 * identity lines. Exported for offline tests.
 */
export async function catalogHash(entries: PermitEntry[]): Promise<string> {
  const lines = entries
    .map(entry => `${entry.id}|${entry.name}|${entry.department}|${entry.description}`)
    .sort();
  return computeSha256(lines.join("\n"));
}

/**
 * Diff a parsed catalog against the shared idempotency store. The FIRST ever
 * observation (empty store) is a baseline, not an alarm — a monitor that
 * installs and immediately reports "5 permits changed" has manufactured its
 * own advisory. Exported for offline tests.
 */
export async function detectCatalogChanges(
  entries: PermitEntry[],
  store: IdempotencyStore,
): Promise<Array<{ id: string; name: string; change: "new" | "edited" }>> {
  const wasEmpty = store.size === 0;
  const changed: Array<{ id: string; name: string; change: "new" | "edited" }> = [];
  for (const entry of entries) {
    const contentHash = await hashContent(`${entry.name}|${entry.department}|${entry.description}`);
    const result = store.seen(`mygov-permit-${entry.id}`, contentHash, { name: entry.name });
    if (wasEmpty) continue; // baseline run
    if (result.isNew) changed.push({ id: entry.id, name: entry.name, change: "new" });
    else if (result.changed) changed.push({ id: entry.id, name: entry.name, change: "edited" });
  }
  return changed;
}

/** Build the monitor report from parsed entries (pure; no I/O). */
export async function buildPermitsReport(
  entries: PermitEntry[],
  changedEntries: Array<{ id: string; name: string; change: "new" | "edited" }>,
  now = new Date().toISOString(),
): Promise<PermitsReport> {
  const worstLevel: PermitsLevel = changedEntries.length > 0 ? "ADVISORY" : "CALM";
  const summary = changedEntries.length === 0
    ? `Permit catalog unchanged (${entries.length} published permit types on the MyGov public portal).`
    : `${changedEntries.length} permit catalog change(s): ` +
      changedEntries.slice(0, 3).map(entry => `${entry.name} (${entry.change})`).join(", ") +
      (changedEntries.length > 3 ? `, +${changedEntries.length - 3} more` : "");
  return {
    fetchedAt: now,
    sourceUrl: MYGOV_PERMITS_URL,
    permits: entries,
    catalogSize: entries.length,
    changedEntries,
    catalogHash: await catalogHash(entries),
    worstLevel,
    summary,
  };
}

/** Append one history record per catalog change, deduped by entry + content. */
export async function appendPermitsHistory(
  changedEntries: Array<{ id: string; name: string; change: "new" | "edited" }>,
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  if (changedEntries.length === 0) return;
  await mkdir(outputDir(), { recursive: true });
  for (const entry of changedEntries) {
    const nameHash = await hashContent(entry.name);
    appendBoundedJsonlSync(permitsHistoryPath(), JSON.stringify({
      id: `permits-${entry.id}-${nameHash.slice(0, 8)}`,
      type: "permits",
      permitId: entry.id,
      name: entry.name,
      change: entry.change,
      level: "ADVISORY",
      summary: `Permit catalog ${entry.change}: ${entry.name}`,
      url: MYGOV_PERMITS_URL,
      fetchedAt,
    }));
  }
}

/** Bounded live fetch through the shared connector (rate limit, robots gate, size cap, timeout, one retry). */
function fetchPermitCatalog(): Promise<string> {
  return boundedFetchText(MYGOV_PERMITS_URL, {
    label: "MyGov permit catalog",
    maxBytes: PERMITS_MAX_BYTES,
  });
}

/** Run the monitor: fetch, parse, diff against the shared store, persist. */
export async function runPermitsMonitor(): Promise<PermitsReport | null> {
  logger.info("Checking City of Crescent City permit portal (MyGov public catalog)");
  lastPermitsError = undefined;
  try {
    const html = await fetchPermitCatalog();
    const entries = parsePermitCatalog(html);
    const store = new IdempotencyStore(permitsSeenPath());
    await store.load();
    const changedEntries = await detectCatalogChanges(entries, store);
    await store.save();
    const report = await buildPermitsReport(entries, changedEntries);

    await mkdir(outputDir(), { recursive: true });
    await writeJsonAtomic(permitsCurrentPath(), report);
    await appendPermitsHistory(report.changedEntries, report.fetchedAt);

    if (report.worstLevel === "ADVISORY") {
      logger.warn("Permit portal: " + report.summary);
    } else {
      logger.info("Permit portal check: " + report.summary);
    }
    return report;
  } catch (err) {
    lastPermitsError = err instanceof Error ? err.message : String(err);
    logger.error("Failed to check the permit portal", { error: lastPermitsError });
    return null;
  }
}

if (import.meta.main) {
  runPermitsMonitor().then(report => {
    if (report) console.log(JSON.stringify(report, null, 2));
    else console.log("Permit portal check failed — see logs");
  });
}

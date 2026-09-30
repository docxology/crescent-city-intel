/**
 * Cross-artifact civic insights - deterministic trend detection plus ONE
 * optional LLM-polished paragraph per top-3 insight.
 *
 * Numbers are computed entirely in code from artifacts already recorded under
 * output/ (alert histories via alert_analytics, news, government meetings,
 * YouTube uploads, and the community-events calendar). The LLM never computes
 * a number: it only phrases the deterministic findings, and every failure path
 * falls back to a template narrative built from the same computed numbers.
 *
 * Grounding invariant: each insight carries evidence source URLs recorded from
 * the underlying artifacts; nothing here invents events or facts, undated
 * records are excluded rather than guessed into a window, and an unavailable
 * provider degrades to the template narrative without erasing any metric.
 */
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { buildAlertAnalytics, ALERT_TYPES, type AlertType } from "./alert_analytics.js";
import { outputRoot } from "./shared/paths.js";
import { domains } from "./domains.js";
import { scoreDomainCoverageGaps, type DomainCoverageGap, type DomainGapInput } from "./domains/coverage.js";
import { checkChatProvider, chatWithProvider } from "./llm/provider.js";
import { isCivilDate, parseEventDate } from "./events.js";
import { custodyHash } from "./corpus_editions.js";
import { redactUrl } from "./shared/transport.js";

export const INSIGHTS_SCHEMA = "crescent-city-civic-insights/v1" as const;
/** Where the assembled report is persisted for endpoint/snapshot consumption. */
const civicInsightsPath = () => join(outputRoot(), "state", "civic-insights.json");

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Trend direction classification --------------------------------------

export type TrendDirection = "rising" | "steady" | "falling" | "insufficient";

/**
 * Absolute delta within this band classifies as "steady"; anything larger is
 * rising/falling. Two empty windows are "insufficient" - absence of data must
 * never be presented as an observed trend.
 */
export const STEADY_BAND = 1;
export function directionFor(currentTotal: number, previousTotal: number): TrendDirection {
  if (currentTotal === 0 && previousTotal === 0) return "insufficient";
  const delta = currentTotal - previousTotal;
  if (Math.abs(delta) <= STEADY_BAND) return "steady";
  return delta > 0 ? "rising" : "falling";
}

export interface WindowCounts {
  alerts: number;
  news: number;
  meetings: number;
  youtube: number;
  calendarEvents: number;
}

export interface DomainTrendInsight {
  domainId: string;
  domainName: string;
  /** Half-open (startMs, endMs] epoch-ms window boundaries. */
  currentWindow: { startMs: number; endMs: number };
  previousWindow: { startMs: number; endMs: number };
  current: WindowCounts;
  previous: WindowCounts;
  deltaTotal: number;
  /** Percent change of the total; null when the prior window was empty. */
  momentumPct: number | null;
  direction: TrendDirection;
  /** Up to 4 evidence URLs recorded from matched artifacts. */
  evidenceSources: string[];
}

function emptyCounts(): WindowCounts {
  return { alerts: 0, news: 0, meetings: 0, youtube: 0, calendarEvents: 0 };
}

function total(counts: WindowCounts): number {
  return counts.alerts + counts.news + counts.meetings + counts.youtube + counts.calendarEvents;
}

// --- Record collection (one generic dated-record shape) ------------------

export interface DatedRecord {
  title: string;
  text: string;
  /** Epoch ms of the item; NaN when undated (excluded from window math). */
  atMs: number;
  url: string | null;
  feed: keyof WindowCounts & string;
  /** Monitor type when feed === "alerts"; used for explicit domain mapping. */
  alertType?: string;
  sourceIdentity?: string;
  revisionAtMs?: number;
}

export interface ActivityCollectionReceipt {
  schemaVersion: "civic-activity-evidence/v1";
  inputFiles: number;
  missingInputs: string[];
  malformedFiles: Array<{ path: string; reason: string }>;
  invalidRows: number;
  snapshotRows: number;
  uniqueRecords: number;
  duplicateSnapshots: number;
  revisedItems: number;
  undatedRecords: number;
  countUnits: Record<keyof WindowCounts, string>;
  limitations: string[];
}

/** Alert monitor types carry an implicit domain mapping for fast attribution. */
/**
 * Which civic domains each analysed alert type attributes its records to.
 *
 * `Record<string, string[]>` rather than keyed by `AlertType` on purpose: the
 * domain ids here are the civic vocabulary (`public-safety`,
 * `climate-environment`, …), not the monitor roster, and a type with no
 * meaningful civic attribution should be absent rather than mapped to a
 * catch-all. `tests/insights.test.ts` iterates `ALERT_TYPES` and fails on any
 * unmapped type, so an added monitor cannot slip through unmapped — that test
 * previously iterated a hand-written 8-item list and so did not catch the six
 * civic monitors this map gained entries for.
 */
export const ALERT_TYPE_DOMAINS: Record<AlertType, string[]> = {
  tsunami: ["emergency-management"],
  earthquake: ["emergency-management"],
  weather: ["emergency-management", "climate-environment"],
  // The coastal-waters forecast is a nearshore hazard product, so it attributes
  // to the harbour/marine domain rather than to climate.
  marinezone: ["harbor-marine-operations"],
  tides: ["harbor-marine-operations"],
  marine: ["harbor-marine-operations"],
  fishing: ["harbor-marine-operations"],
  airquality: ["public-health-safety", "climate-environment"],
  wildfire: ["public-safety", "emergency-management"],
  // Drought is the long-horizon climate/water signal, so it also feeds the
  // environment domain the weather type uses.
  drought: ["climate-environment", "environmental-protection"],
  // A public-safety power shutoff is an emergency-management event; a school
  // closure is an education event as much as a public-safety one, so it
  // attributes to both; smoke is an air-quality signal the public-health domain
  // already reads from the measured AQI monitor.
  psps: ["emergency-management", "public-safety"],
  smoke: ["public-health-safety", "climate-environment"],
  roads: ["public-safety", "harbor-marine-operations"],
  schools: ["education-youth", "public-safety"],
  // A Broadcast Notice to Mariners is a navigational hazard, so it attributes
  // to the harbour/marine domain like the other mooring and channel products.
  uscg: ["harbor-marine-operations"],
  // The 2026-09-28 expansion monitors: permit activity is building-code
  // compliance and construction demand, harbor marine-construction and AIS
  // traffic are harbour/marine, fuel is an emergency-resilience economic
  // signal, and PacFIN is the fisheries data network behind the fishing
  // monitor's domain. Domain ids are the civic vocabulary in domains.ts.
  permits: ["public-safety", "business-development"],
  dredging: ["harbor-marine-operations"],
  fuel: ["public-safety"],
  pacfin: ["harbor-marine-operations"],
  ais: ["harbor-marine-operations"],
};

interface AlertTimelineEntry extends Record<string, unknown> {
  timestamp: string;
  description?: string;
  severity?: string;
  type?: string;
}

function timestampOf(record: Record<string, unknown>): number {
  for (const key of ["observedAt", "publishedAt", "pubDate", "date", "uploadDate", "timestamp"]) {
    const value = record[key];
    if (typeof value === "string" && parseEventDate(value)) {
      if (/^\d{8}$/.test(value)) return Date.parse(parseEventDate(value)!);
      if (Number.isFinite(Date.parse(value))) return Date.parse(value);
    }
  }
  return Number.NaN;
}

function urlOf(record: Record<string, unknown>): string | null {
  for (const key of ["link", "url"]) {
    const value = record[key];
    if (typeof value === "string") {
      try {
        const url = new URL(value);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && redactUrl(value) === url.toString()) return url.toString();
      } catch { /* malformed or credential-bearing evidence is not public provenance */ }
    }
  }
  const videoId = record.videoId;
  return typeof videoId === "string" && /^[A-Za-z0-9_-]{6,}$/.test(videoId)
    ? `https://www.youtube.com/watch?v=${videoId}`
    : null;
}

/**
 * Collect dated records per feed from an output root (fixture-friendly).
 * Reads only artifacts previously written by monitors - never fetches,
 * never guesses dates that are not recorded in the artifact.
 */
export async function collectActivityEvidence(root: string): Promise<{ records: DatedRecord[]; receipt: ActivityCollectionReceipt }> {
  const records: DatedRecord[] = [];
  const receipt: ActivityCollectionReceipt = { schemaVersion: "civic-activity-evidence/v1", inputFiles: 0, missingInputs: [], malformedFiles: [], invalidRows: 0, snapshotRows: 0, uniqueRecords: 0, duplicateSnapshots: 0, revisedItems: 0, undatedRecords: 0,
    countUnits: { alerts: "distinct recorded observations", news: "unique published source items", meetings: "unique dated meeting records", youtube: "unique video publications", calendarEvents: "unique calendar occurrences" },
    limitations: ["Collection cadence is not normalized; observation counts do not measure hazard frequency", "A recorded timestamp does not by itself prove an upstream observation time", "Source coverage and missing artifacts are evaluated separately from activity", "Identity without a source ID uses the recorded URL/title and date; reviewed identity reconciliation remains source-specific"] };
  const relative = (path: string) => path.slice(root.replace(/\/+$/, "").length + 1);
  async function readJson(path: string): Promise<unknown> {
    try { const text = await readFile(path, "utf8"); receipt.inputFiles++; return JSON.parse(text); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") receipt.missingInputs.push(relative(path)); else receipt.malformedFiles.push({ path: relative(path), reason: error instanceof SyntaxError ? "invalid-json" : "unreadable" }); return null; }
  }
  async function jsonlRecords(path: string): Promise<Array<Record<string, unknown>>> {
    let text: string; try { text = await readFile(path, "utf8"); receipt.inputFiles++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") receipt.missingInputs.push(relative(path)); else receipt.malformedFiles.push({ path: relative(path), reason: "unreadable" }); return []; }
    const result: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n").filter(line => line.trim())) {
      try { const value: unknown = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) { receipt.invalidRows++; continue; } result.push(value as Record<string, unknown>); }
      catch { receipt.invalidRows++; receipt.malformedFiles.push({ path: relative(path), reason: "invalid-jsonl-row" }); }
    }
    return result;
  }
  function identityOf(raw: Record<string, unknown>): string | undefined {
    const id = raw.sourceId ?? raw.source ?? raw.channel ?? "";
    const recordId = raw.id ?? raw.eventId ?? raw.incidentId ?? raw.videoId;
    const fallback = urlOf(raw);
    return typeof recordId === "string" || typeof recordId === "number" ? `${typeof id === "string" ? id : ""}|${recordId}` : fallback ? `${typeof id === "string" ? id : ""}|${fallback}` : undefined;
  }
  function revisionOf(raw: Record<string, unknown>): number | undefined {
    return typeof raw.fetchedAt === "string" && Number.isFinite(Date.parse(raw.fetchedAt)) ? Date.parse(raw.fetchedAt) : undefined;
  }

  // Alerts: per-type history.jsonl files under output/alerts/<type>/ plus the
  // standalone tides/fishing histories.
  for (const type of ALERT_TYPES.filter(type => type !== "tides" && type !== "fishing")) {
    for (const record of await jsonlRecords(join(root, "alerts", type, "history.jsonl"))) {
      records.push({
        title: String(record.headline ?? record.summary ?? `${type} alert`),
        text: String(record.summary ?? record.description ?? ""),
        atMs: timestampOf(record),
        url: urlOf(record),
        feed: "alerts",
        alertType: type,
        sourceIdentity: identityOf(record), revisionAtMs: revisionOf(record),
      });
    }
  }
  for (const dirName of ["tides", "fishing"] as const) {
    for (const record of await jsonlRecords(join(root, dirName, "history.jsonl"))) {
      records.push({
        title: String(record.summary ?? "hazard record"),
        text: "",
        atMs: timestampOf(record),
        url: urlOf(record),
        feed: "alerts",
        alertType: dirName === "tides" ? "tides" : "fishing",
        sourceIdentity: identityOf(record), revisionAtMs: revisionOf(record),
      });
    }
  }

  // News / government meetings / YouTube batch directories.
  const batches: Array<{ dir: string; feed: "news" | "meetings" | "youtube" }> = [
    { dir: "news", feed: "news" },
    { dir: "gov_meetings", feed: "meetings" },
    { dir: "youtube", feed: "youtube" },
  ];
  for (const batch of batches) {
    const batchDir = join(root, batch.dir);
    if (!existsSync(batchDir)) { receipt.missingInputs.push(batch.dir); continue; }
    let files: string[];
    try {
      files = (await readdir(batchDir)).filter(f => f.endsWith(".json") && f !== "source-health.json").sort();
    } catch { receipt.malformedFiles.push({ path: batch.dir, reason: "unreadable-directory" }); continue; }
    for (const file of files) {
      const parsed = await readJson(join(batchDir, file));
      const array: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === "object"
          ? (Array.isArray((parsed as Record<string, unknown>).items)
              ? (parsed as Record<string, unknown>).items as unknown[]
              : [parsed])
          : [];
      for (const raw of array) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { receipt.invalidRows++; continue; }
        const record = raw as Record<string, unknown>;
        const title = typeof record.title === "string" ? record.title : "";
        if (!title.trim()) { receipt.invalidRows++; continue; }
        records.push({
          title,
          text: typeof record.summary === "string" ? record.summary : typeof record.description === "string" ? record.description : typeof record.content === "string" ? record.content : "",
          atMs: timestampOf(record),
          url: urlOf(record),
          feed: batch.feed,
          sourceIdentity: identityOf(record), revisionAtMs: revisionOf(record),
        });
      }
    }
  }

  // Community events calendar artifact.
  const eventsParsed = await readJson(join(root, "events", "events.json"));
  if (eventsParsed && typeof eventsParsed === "object") {
    const list = (eventsParsed as Record<string, unknown>).events;
    if (Array.isArray(list)) {
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const event = raw as Record<string, unknown>;
        const title = typeof event.title === "string" ? event.title : "";
        if (!title.trim()) continue;
        // Calendar events carry yyyy-mm-dd dateStart values.
        const dateStart = typeof event.dateStart === "string" ? event.dateStart : null;
        records.push({
          title,
          text: `${typeof event.location === "string" ? event.location : ""} ${typeof event.description === "string" ? event.description : ""}`,
          atMs: dateStart && isCivilDate(dateStart) ? Date.parse(dateStart) : Number.NaN,
          url: Array.isArray(event.sourceLinks) ? urlOf({ link: event.sourceLinks[0] }) : null,
          feed: "calendarEvents",
          sourceIdentity: identityOf(event), revisionAtMs: revisionOf(event),
        });
      }
    }
  }

  const unique = new Map<string, DatedRecord>();
  const versions = new Map<string, Set<string>>();
  for (const record of records) {
    const sourceIdentity = record.sourceIdentity ?? record.url ?? record.title;
    const occurrence = record.feed === "news" || record.feed === "youtube" ? "" : `|${record.atMs}`;
    const identity = `${record.feed}|${record.alertType ?? ""}|${sourceIdentity}${occurrence}`;
    const hash = custodyHash(JSON.stringify([record.title, record.text, record.url, Number.isFinite(record.atMs) ? record.atMs : null]));
    if (!versions.has(identity)) versions.set(identity, new Set());
    versions.get(identity)!.add(hash);
    const prior = unique.get(identity);
    if (!prior || (record.revisionAtMs ?? 0) >= (prior.revisionAtMs ?? 0)) unique.set(identity, record);
  }
  const result = [...unique.values()];
  receipt.snapshotRows = records.length; receipt.uniqueRecords = result.length; receipt.duplicateSnapshots = records.length - result.length;
  receipt.revisedItems = [...versions.values()].filter(version => version.size > 1).length;
  receipt.undatedRecords = result.filter(record => !Number.isFinite(record.atMs)).length;
  receipt.missingInputs.sort(); receipt.malformedFiles.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return { records: result, receipt };
}

// --- Domain attribution ---------------------------------------------------

function domainKeywords(domain: { topics: Array<{ name: string; tags: string[] }> }): Set<string> {
  const words = new Set<string>();
  for (const topic of domain.topics) {
    for (const token of topic.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 4) words.add(token);
    }
    for (const tag of topic.tags) {
      for (const token of tag.toLowerCase().split(/[^a-z0-9]+/)) {
        // Tags carry year markers like dt:1964 - skip numeric-only fragments.
        if (token.length >= 4 && !/^\d+$/.test(token)) words.add(token);
      }
    }
  }
  return words;
}

/**
 * Assign every record to every domain whose keyword set overlaps its text.
 * Multi-domain attribution is intentional (a wildfire alert is both a safety
 * and an emergency-management signal); counts are independent per-domain views.
 * Records with NaN timestamps are kept for keyword presence but excluded from
 * all window arithmetic downstream.
 */
export function attributeRecords(records: DatedRecord[]): Map<string, DatedRecord[]> {
  const lowerTexts = records.map(record => `${record.title} ${record.text}`.toLowerCase());
  const buckets = new Map<string, DatedRecord[]>();
  for (const domain of domains) {
    buckets.set(domain.id, []);
  }
  domains.forEach(domain => {
    const keywords = [...domainKeywords(domain)];
    const mine = buckets.get(domain.id)!;
    records.forEach((record, index) => {
      const mappedAlert =
        record.feed === "alerts" &&
        record.alertType !== undefined &&
        (ALERT_TYPE_DOMAINS as Record<string, string[]>)[record.alertType]?.includes(domain.id);
      if (mappedAlert || keywords.some(keyword => lowerTexts[index].includes(keyword))) {
        mine.push(record);
      }
    });
  });
  return buckets;
}

// --- Window trend computation --------------------------------------------

/**
 * Compute per-domain current-vs-previous window trends relative to nowMs:
 * current covers (now - W, now], previous covers (now - 2W, now - W].
 * Undated records count in NEITHER window.
 */
export function computeDomainTrends(
  buckets: Map<string, DatedRecord[]>,
  options: { nowMs: number; windowDays?: number },
): DomainTrendInsight[] {
  const windowDays = options.windowDays ?? 30;
  const endMs = options.nowMs;
  const midMs = endMs - windowDays * DAY_MS;
  const startMs = midMs - windowDays * DAY_MS;

  const trends: DomainTrendInsight[] = [];
  for (const domain of domains) {
    const current = emptyCounts();
    const previous = emptyCounts();
    const evidenceSources: string[] = [];
    for (const record of buckets.get(domain.id) ?? []) {
      if (!Number.isFinite(record.atMs)) continue;
      const inCurrent = record.atMs > midMs && record.atMs <= endMs;
      const inPrevious = record.atMs > startMs && record.atMs <= midMs;
      if (!inCurrent && !inPrevious) continue;
      const bucket = inCurrent ? current : previous;
      bucket[record.feed as keyof WindowCounts] += 1;
      if (record.url && !evidenceSources.includes(record.url)) evidenceSources.push(record.url);
    }
    const deltaTotal = total(current) - total(previous);
    trends.push({
      domainId: domain.id,
      domainName: domain.name,
      currentWindow: { startMs: midMs, endMs },
      previousWindow: { startMs, endMs: midMs },
      current,
      previous,
      deltaTotal,
      momentumPct: total(previous) > 0 ? Math.round((deltaTotal / total(previous)) * 10000) / 100 : null,
      direction: directionFor(total(current), total(previous)),
      evidenceSources: evidenceSources.slice(0, 4),
    });
  }

  // Most decisive moves first: largest absolute momentum, then raw delta size.
  return trends.sort((a, b) => {
    const aMomentum = Math.abs(a.momentumPct ?? (a.direction === "insufficient" ? -1 : Number.POSITIVE_INFINITY));
    const bMomentum = Math.abs(b.momentumPct ?? (b.direction === "insufficient" ? -1 : Number.POSITIVE_INFINITY));
    if (aMomentum !== bMomentum) return bMomentum - aMomentum;
    if (Math.abs(a.deltaTotal) !== Math.abs(b.deltaTotal)) return Math.abs(b.deltaTotal) - Math.abs(a.deltaTotal);
    return a.domainId.localeCompare(b.domainId);
  });
}

// --- Coverage-gap bridging -----------------------------------------------

export interface CoverageGapContext {
  domainId: string;
  alertEvents: number;
  newsCount: number;
  latestNewsAtMs: number | null;
  meetingsCount: number;
}

/**
 * Build gap-scoring inputs directly from attributed records so the coverage
 * gap scorer in domains/coverage.ts and the trend detector see identical data.
 * Only the trailing 60 days (relative to nowMs) count as "recent signal".
 */
export function coverageGapInputs(buckets: Map<string, DatedRecord[]>, nowMs: number): CoverageGapContext[] {
  return domains.map(domain => {
    let newsCount = 0;
    let latestNewsAtMs: number | null = null;
    let meetingsCount = 0;
    let alertEvents = 0;
    for (const record of buckets.get(domain.id) ?? []) {
      if (!Number.isFinite(record.atMs) || record.atMs > nowMs || record.atMs <= nowMs - 60 * DAY_MS) continue;
      if (record.feed === "news") {
        newsCount += 1;
        latestNewsAtMs = latestNewsAtMs === null ? record.atMs : Math.max(latestNewsAtMs, record.atMs);
      } else if (record.feed === "meetings") {
        meetingsCount += 1;
      } else if (record.feed === "alerts") {
        alertEvents += 1;
      }
    }
    return { domainId: domain.id, alertEvents, newsCount, latestNewsAtMs, meetingsCount };
  });
}

export function evaluateCoverageGaps(contexts: CoverageGapContext[], nowMs: number): DomainCoverageGap[] {
  const inputs: DomainGapInput[] = contexts.map(context => ({ ...context, checkedAtMs: nowMs }));
  return scoreDomainCoverageGaps(inputs);
}

// --- Narrative layer: one LLM paragraph per top-3 insight ----------------

export const INSIGHT_NARRATIVE_PROMPT_VERSION = "2026-08-26-insight-narrative-v1";
export const INSIGHT_NARRATIVE_SYSTEM_PROMPT =
  'You are polishing a computed civic-intelligence finding for a local Crescent City dashboard. ' +
  'All numbers are provided and MUST be repeated exactly as given - do NOT compute, adjust, or invent any figure, cause, or event. ' +
  'Respond as JSON: {"paragraph": "..."} containing one concise factual paragraph.';

interface NarrativeResult {
  status: "llm" | "template";
  provider: string | null;
  model: string | null;
  text: string;
}

export function templateNarrative(insight: DomainTrendInsight, gapDetail: string | null): string {
  const deltaText = insight.deltaTotal >= 0 ? `+${insight.deltaTotal}` : String(insight.deltaTotal);
  const momentum = insight.momentumPct === null
    ? ""
    : ` (${insight.momentumPct >= 0 ? "+" : ""}${insight.momentumPct}% versus the prior window)`;
  const parts = [
    `${insight.domainName} recorded ${total(insight.current)} tracked signals in the last window versus ${total(insight.previous)} previously - a ${insight.direction} move (${deltaText})${momentum}.`,
  ];
  if (gapDetail) parts.push(`Coverage note: ${gapDetail}`);
  return parts.join(" ");
}

async function polishNarrative(insight: DomainTrendInsight): Promise<NarrativeResult> {
  try {
    const health = await checkChatProvider();
    if (!health.configured || !health.reachable) {
      return { status: "template", provider: health.provider ?? null, model: health.model ?? null, text: "" };
    }
    const payload = JSON.stringify({
      domain: insight.domainName,
      direction: insight.direction,
      currentTotals: insight.current,
      previousTotals: insight.previous,
      delta: insight.deltaTotal,
      momentumPercent: insight.momentumPct,
    });
    const response = await chatWithProvider([{ role: "user", content: payload }]);
    let text: string | null = null;
    try {
      const parsed = JSON.parse(response) as Record<string, unknown>;
      text = typeof parsed.paragraph === "string" ? parsed.paragraph.trim() : null;
    } catch {
      text = response.trim().length > 0 ? response.trim() : null;
    }
    if (!text) throw new Error("provider returned an empty insight paragraph");
    return { status: "llm", provider: health.provider, model: health.model ?? null, text };
  } catch {
    return { status: "template", provider: null, model: null, text: "" };
  }
}

// --- Report assembly -------------------------------------------------------

export interface InsightReport {
  schemaVersion: typeof INSIGHTS_SCHEMA;
  generatedAt: string;
  windowDays: number;
  narrativePromptVersion: string;
  narrative: {
    requested: boolean;
    status: "ok" | "unavailable" | "skipped";
    provider: string | null;
    model: string | null;
    polishedCount: number;
  };
  provenance: {
    feeds: string[];
    rule: string;
    activity: ActivityCollectionReceipt;
  };
  trends: DomainTrendInsight[];
  top: Array<{
    rank: number;
    domainId: string;
    direction: TrendDirection;
    deltaTotal: number;
    momentumPct: number | null;
    paragraph: string;
    narrativeKind: NarrativeResult["status"] | "skipped";
    evidenceSources: string[];
  }>;
  coverageGaps: DomainCoverageGap[];
}

export interface BuildInsightOptions {
  generatedAt?: string;
  windowDays?: number;
  /** Ask the configured chat provider to phrase the top-3 narratives (template fallback always applies). */
  polish?: boolean;
  /** Fixture-friendly artifact root. Defaults to ./output. */
  outputRoot?: string;
}

export async function buildInsightReport(options: BuildInsightOptions = {}): Promise<InsightReport> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const windowDays = options.windowDays ?? 30;
  const nowMs = Date.parse(generatedAt);
  const root = options.outputRoot ?? outputRoot();

  const { records, receipt } = await collectActivityEvidence(root);
  const buckets = attributeRecords(records);
  const trends = computeDomainTrends(buckets, { nowMs, windowDays });
  const gaps = evaluateCoverageGaps(coverageGapInputs(buckets, nowMs), nowMs);
  const gapByDomain = new Map(gaps.map(gap => [gap.domainId, gap]));

  // Top-3 selection mirrors the trend sort but skips observations with no data
  // in either window - insufficient evidence must never headline the brief.
  const top = trends.filter(trend => trend.direction !== "insufficient").slice(0, 3);

  const narrativeMeta: InsightReport["narrative"] = {
    requested: Boolean(options.polish),
    status: options.polish ? "ok" : "skipped",
    provider: null,
    model: null,
    polishedCount: 0,
  };
  const narratives = new Map<number, NarrativeResult>();
  if (options.polish && top.length > 0) {
    for (const [index, insight] of top.entries()) {
      narratives.set(index, await polishNarrative(insight));
    }
    const successes = [...narratives.values()].filter(result => result.status === "llm");
    narrativeMeta.polishedCount = successes.length;
    narrativeMeta.status = successes.length > 0 ? "ok" : "unavailable";
    narrativeMeta.provider = successes[0]?.provider ?? null;
    narrativeMeta.model = successes[0]?.model ?? null;
  }

  return {
    schemaVersion: INSIGHTS_SCHEMA,
    generatedAt,
    windowDays,
    narrativePromptVersion: INSIGHT_NARRATIVE_PROMPT_VERSION,
    narrative: narrativeMeta,
    provenance: {
      activity: receipt,
      feeds: [
        "output/alerts/*/history.jsonl",
        "output/tides/history.jsonl",
        "output/fishing/history.jsonl",
        "output/news",
        "output/gov_meetings",
        "output/youtube",
        "output/events/events.json",
      ],
      rule:
        "numbers computed deterministically in code; the LLM only phrases them; records without dates or source URLs are excluded from evidence rather than guessed",
    },
    trends,
    top: top.map((insight, index) => {
      const narrative = narratives.get(index);
      const gap = gapByDomain.get(insight.domainId);
      return {
        rank: index + 1,
        domainId: insight.domainId,
        direction: insight.direction,
        deltaTotal: insight.deltaTotal,
        momentumPct: insight.momentumPct,
        paragraph:
          narrative && narrative.text.length > 0
            ? narrative.text
            : templateNarrative(insight, gap ? `${gap.detail} (gap score ${gap.score})` : null),
        narrativeKind: narrative ? narrative.status : ("skipped" as const),
        evidenceSources: insight.evidenceSources,
      };
    }),
    coverageGaps: gaps,
  };
}

/** Persist the report; creates parent directories on demand. */
export async function writeCivicInsights(report: InsightReport, path = civicInsightsPath()): Promise<void> {
  const { mkdir, writeFile } = await import("fs/promises");
  const { dirname } = await import("path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}

/** Read back a previously written artifact; returns null when absent/mismatched. */
export async function readCivicInsights(path = civicInsightsPath()): Promise<InsightReport | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as InsightReport;
    return parsed.schemaVersion === INSIGHTS_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

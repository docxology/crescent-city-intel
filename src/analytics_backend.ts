/**
 * Cross-surface analytics backend.
 *
 * This is the shared evidence envelope for the local GUI, the weekly
 * pipeline, and the public Pages export. Deterministic observations are kept
 * separate from the optional LLM narrative so a provider outage cannot erase
 * metrics or turn an unavailable source into a calm one.
 */
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { buildAlertAnalytics, type AlertAnalyticsReport } from "./alert_analytics.js";
import { getCodeStats, type CodeStats } from "./gui/analytics.js";
import { llmConfig } from "./llm/config.js";
import { checkChatProvider, chatWithProvider, configuredChatModel } from "./llm/provider.js";
import { buildSourceDiscoveryReport, getSourceRegistry, sourceRegistryFingerprint } from "./source_registry.js";
import { isActiveNewsSource } from "./news_monitor.js";
import { paths } from "./shared/paths.js";
import { completeSourceHealth, summarizeSourceHealth, writeJsonAtomic } from "./shared/source_health.js";
import { computeSha256, truncateText } from "./utils.js";
import type { SourceHealth, SourceHealthSummary } from "./types.js";

export const ANALYTICS_OVERVIEW_SCHEMA = "1.0.0" as const;
export const ANALYTICS_SUMMARY_PROMPT_VERSION = "2026-07-24-analytics-overview-v1";
const MAX_RECENT_ITEMS = 6;

type JsonRecord = Record<string, unknown>;
type OverviewStatus = "ok" | "degraded" | "unavailable";
type SignalSeverity = "info" | "watch" | "warning";

export interface OverviewSignal {
  id: string;
  category: "source" | "alert" | "content" | "code" | "pipeline";
  severity: SignalSeverity;
  title: string;
  detail: string;
  evidence: string[];
  nextStep: string;
  /** §5.5: operator-only signals (e.g. missing build-machine executables) are
   * routed to operator channels; public surfaces render a neutral notice. */
  operatorOnly?: boolean;
}

/** §5.5: a signal detail reporting a missing executable is an operator
 * problem, not civic intelligence; it must never be published to readers. */
export function isOperatorOnlySignal(signal: OverviewSignal): boolean {
  if (signal.operatorOnly === true) return true;
  return /not found in \$PATH/i.test(signal.detail);
}

/** §5.5: public replacement copy for operator-only signals. */
export function publicSignalNotice(signal: OverviewSignal): OverviewSignal {
  const source = String(signal.title || "").replace(/\s*needs review\s*$/, "").trim() || "A data source";
  return {
    ...signal,
    severity: "watch",
    title: `${source} monitoring unavailable`,
    detail: `${source} monitoring is unavailable this edition. This is an operator-side condition; no availability or calmness should be inferred from it.`,
    evidence: [],
    nextStep: "Check the operator build log; the underlying source data will return in a later edition.",
  };
}

/** §5.5: split signals into the public set and the operator-only set. */
export function splitPublicOperatorSignals(signals: OverviewSignal[]): { publicSignals: OverviewSignal[]; operatorSignals: OverviewSignal[] } {
  const publicSignals: OverviewSignal[] = [];
  const operatorSignals: OverviewSignal[] = [];
  for (const signal of signals) {
    if (isOperatorOnlySignal(signal)) operatorSignals.push(signal);
    else publicSignals.push(signal);
  }
  return { publicSignals, operatorSignals };
}

export interface OverviewItem {
  id: string;
  title: string;
  source: string;
  url: string | null;
  date: string | null;
  summary?: string;
}

export interface AnalyticsOverview {
  schemaVersion: typeof ANALYTICS_OVERVIEW_SCHEMA;
  generatedAt: string;
  inputFingerprint: string;
  status: OverviewStatus;
  headline: string;
  summary: string;
  entryPoint: {
    title: string;
    startHere: string;
    readOrder: string[];
    interpretation: string;
  };
  metrics: {
    code: { articles: number; sections: number; words: number; avgWordsPerSection: number };
    sources: SourceHealthSummary & { registryCount: number; monitoredCount: number; discoveryOnlyCount: number; referenceOnlyCount: number };
    content: { news: number; meetings: number; youtube: number; curated: number; searchQueries: number };
    alerts: { totalEvents: number; mostActiveType: string | null; mostRecent: string | null };
  };
  code: CodeStats;
  sources: {
    missing: Array<{ source: string; status: string; error?: string; checkedAt: string }>;
    /** Compatibility alias; use `missing` in new clients. */
    degraded: Array<{ source: string; status: string; error?: string; checkedAt: string }>;
    coverageGaps: string[];
    registryFingerprint: string;
  };
  alerts: {
    level: string;
    reason: string;
    assessedAt: string | null;
    analytics: Pick<AlertAnalyticsReport, "totalEvents" | "mostActiveType" | "mostRecentAlert" | "typeStats">;
  };
  content: { recent: OverviewItem[]; curated: OverviewItem[] };
  pipeline: {
    status: string | null;
    runId: string | null;
    completedAt: string | null;
    curationProvider: string | null;
    curationModel: string | null;
    reportPeriod: string | null;
  };
  signals: OverviewSignal[];
  /** §5.5 (lane A r2): operator-only signals routed out of the public set,
   * each rewritten by `publicSignalNotice` — no binary names, PATH strings, or
   * stack traces. The exporter mirrors this array to data/operator-signals.json
   * so the operator keeps the routed detail without it ever reaching a page. */
  operatorSignalsNoticed: OverviewSignal[];
  llm: {
    status: "ok" | "unavailable" | "not-requested";
    provider: string;
    model: string;
    promptVersion: string;
    inputFingerprint: string;
    summarizedAt: string | null;
    error?: string;
  };
}

interface OverviewBuildOptions { generatedAt?: string }
interface OverviewWriteOptions extends OverviewBuildOptions { summarize?: boolean }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

async function readHealthReports(checkedAt = new Date().toISOString()): Promise<SourceHealth[]> {
  const files = [paths.newsHealth, paths.govMeetingsHealth, paths.youtubeHealth, paths.triplicateHealth, paths.alertsHealth];
  const reports = await Promise.all(files.map(path => readJson<{ sources?: SourceHealth[] }>(path)));
  return completeSourceHealth(reports.flatMap(report => Array.isArray(report?.sources) ? report.sources : []), checkedAt);
}

async function readSearchAnalytics(): Promise<{ totalQueries: number; totalBytes: string; topTerms: Array<{ term: string; count: number }> }> {
  const logPath = join(process.cwd(), "output", "search-queries.jsonl");
  if (!existsSync(logPath)) return { totalQueries: 0, totalBytes: "0", topTerms: [] };
  try {
    // Snapshot the input at call time: one atomic byte read feeds both the
    // counters and the fingerprint, so a concurrent append can never split
    // the read into two different views (the inputFingerprint flake root cause).
    // A trailing line without a terminating newline is a torn concurrent write
    // and is excluded from the snapshot rather than half-counted.
    const bytes = new Uint8Array(await readFile(logPath));
    const text = new TextDecoder().decode(bytes);
    const completeText = text.endsWith("\n") || text.length === 0 ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    const snapshotHash = new Bun.CryptoHasher("sha256").update(bytes.subarray(0, Buffer.byteLength(completeText, "utf8"))).digest("hex");
    const lines = completeText.split(/\r?\n/).filter(Boolean);
    const counts = new Map<string, number>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonRecord;
        const query = String(entry.query ?? entry.q ?? "").toLowerCase();
        for (const term of query.split(/\s+/).map(value => value.replace(/[^a-z0-9.-]/g, "")).filter(value => value.length > 2)) {
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      } catch { /* one malformed request log must not hide all analytics */ }
    }
    return {
      totalQueries: lines.length,
      totalBytes: snapshotHash,
      topTerms: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([term, count]) => ({ term, count })),
    };
  } catch { return { totalQueries: 0, totalBytes: "0", topTerms: [] }; }
}

function itemDate(item: JsonRecord): number {
  for (const key of ["pubDate", "date", "fetchedAt", "curatedAt", "uploadDate"]) {
    const value = item[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  }
  return 0;
}

function normalizeItem(item: JsonRecord, fallbackSource: string): OverviewItem | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!title) return null;
  const url = typeof item.link === "string" && /^https?:\/\//i.test(item.link)
    ? item.link
    : typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : null;
  const dateKey = ["pubDate", "date", "fetchedAt", "curatedAt", "uploadDate"].find(key => typeof item[key] === "string");
  return {
    id: typeof item.id === "string" ? item.id : typeof item.videoId === "string" ? item.videoId : url ?? title,
    title,
    source: typeof item.source === "string" ? item.source : typeof item.channel === "string" ? item.channel : fallbackSource,
    url,
    date: dateKey ? String(item[dateKey]) : null,
    ...(typeof item.summary === "string" ? { summary: truncateText(item.summary, 500) } : {}),
  };
}

async function collectBatchItems(directory: string, fallbackSource: string, include: (item: JsonRecord) => boolean = () => true): Promise<OverviewItem[]> {
  if (!existsSync(directory)) return [];
  try {
    const files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort();
    const items: OverviewItem[] = [];
    for (const file of files) {
      const parsed = await readJson<unknown>(join(directory, file));
      const batch = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed)
          ? (Array.isArray(parsed.items) ? parsed.items : [parsed])
          : [];
      for (const item of batch) if (isRecord(item) && include(item)) {
        const normalized = normalizeItem(item, fallbackSource);
        if (normalized) items.push(normalized);
      }
    }
    const seen = new Set<string>();
    return items
      .sort((a, b) => itemDate({ date: b.date }) - itemDate({ date: a.date }) || a.id.localeCompare(b.id))
      .filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
  } catch { return []; }
}

async function collectYouTubeItems(): Promise<OverviewItem[]> {
  if (!existsSync(paths.youtube)) return [];
  try {
    const files = (await readdir(paths.youtube)).filter(file => file.endsWith(".json")).sort();
    const items: OverviewItem[] = [];
    for (const file of files) {
      const parsed = await readJson<JsonRecord>(join(paths.youtube, file));
      if (!parsed || parsed.status === "error" || parsed.status === "unavailable") continue;
      const videoId = String(parsed.videoId ?? "");
      const normalized = normalizeItem({ ...parsed, source: parsed.channel ?? "YouTube", link: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "" }, "YouTube");
      if (normalized) items.push(normalized);
    }
    return items.sort((a, b) => itemDate({ date: b.date }) - itemDate({ date: a.date }) || a.id.localeCompare(b.id)).slice(0, MAX_RECENT_ITEMS);
  } catch { return []; }
}

async function collectCuratedItems(): Promise<OverviewItem[]> {
  const items = await collectBatchItems(paths.curated, "LLM curation");
  return items.filter(item => Boolean(item.summary));
}

function deterministicSummary(input: { status: OverviewStatus; alertLevel: string; sourceSummary: SourceHealthSummary; curatedCount: number; recentCount: number }): string {
  const sourceSentence = input.sourceSummary.missing > 0
    ? `${input.sourceSummary.present} of ${input.sourceSummary.total} source checks established a current state (${input.sourceSummary.coveragePercent}% coverage); ${input.sourceSummary.missing} are unavailable or stale and are listed as coverage gaps.`
    : `All ${input.sourceSummary.present} recorded source checks established a current state.`;
  const alertSentence = input.alertLevel && input.alertLevel !== "CALM"
    ? `The composite safety level is ${input.alertLevel}; review the alert evidence before local decisions.`
    : "No non-calm composite alert level is recorded in the current snapshot.";
  return `This ${input.status} Crescent City intelligence snapshot contains ${input.recentCount} recent public items and ${input.curatedCount} source-grounded briefs. ${alertSentence} ${sourceSentence}`;
}

function buildSignals(input: { health: SourceHealth[]; alerts: JsonRecord | null; alertAnalytics: AlertAnalyticsReport; code: CodeStats; curated: OverviewItem[]; pipeline: JsonRecord | null }): OverviewSignal[] {
  const signals: OverviewSignal[] = [];
  for (const source of input.health.filter(source => source.status === "unavailable" || source.status === "stale")) {
    const detail = source.error ?? `The source is ${source.status}; no availability or calmness should be inferred.`;
    // §5.5: a missing build-machine executable routes to the operator log; the
    // public surface renders the neutral monitoring-unavailable notice.
    const operatorOnly = /not found in \$PATH/i.test(detail);
    signals.push({
      id: `source-${source.source.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      category: "source",
      severity: "warning",
      title: `${source.source} needs review`,
      detail,
      evidence: [`status=${source.status}`, `checkedAt=${source.checkedAt}`],
      nextStep: "Open Source health and inspect the source record or retry its monitor.",
      ...(operatorOnly ? { operatorOnly: true } : {}),
    });
  }
  const alertLevel = String(input.alerts?.level ?? "CALM");
  if (alertLevel !== "CALM") {
    signals.push({
      id: "composite-alert-level",
      category: "alert",
      severity: alertLevel === "EMERGENCY" || alertLevel === "WARNING" ? "warning" : "watch",
      title: `Composite alert level: ${alertLevel}`,
      detail: String(input.alerts?.reason ?? "A non-calm composite assessment is recorded."),
      evidence: [`assessedAt=${String(input.alerts?.assessedAt ?? "not recorded")}`, `events=${input.alertAnalytics.totalEvents}`],
      nextStep: "Open Safety & live alerts and follow the individual monitor evidence.",
    });
  }
  if (input.curated.length === 0) {
    signals.push({ id: "curation-empty", category: "content", severity: "watch", title: "No LLM briefs are available", detail: "The public feed may still contain source items, but no provider-generated brief is currently recorded.", evidence: ["curatedCount=0"], nextStep: "Run `bun run curate` after the configured provider is reachable." });
  }
  if (input.code.totalSections === 0) {
    signals.push({ id: "code-missing", category: "code", severity: "warning", title: "Municipal code is not loaded", detail: "Code analytics cannot be interpreted until the scraper has produced article data.", evidence: ["totalSections=0"], nextStep: "Run `bun run scrape`, then `bun run verify` and `bun run export`." });
  }
  if (input.pipeline?.status === "failed") {
    signals.push({ id: "pipeline-failed", category: "pipeline", severity: "warning", title: "Latest pipeline run failed", detail: String(input.pipeline.runId ?? "The latest pipeline envelope is marked failed."), evidence: [String(input.pipeline.completedAt ?? "completedAt=unknown")], nextStep: "Inspect the latest pipeline envelope and rerun the failed stage." });
  }
  return signals.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "warning" ? -1 : b.severity === "warning" ? 1 : a.severity === "watch" ? -1 : 1));
}

function stableInput(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

export async function buildAnalyticsOverview(options: OverviewBuildOptions = {}): Promise<AnalyticsOverview> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const [code, health, alertAnalytics, alerts, curation, pipeline, reportMetadata, discovery, search] = await Promise.all([
    getCodeStats(),
    readHealthReports(generatedAt),
    Promise.resolve(buildAlertAnalytics()),
    readJson<JsonRecord>(join(process.cwd(), "output", "alerts", "composite", "current.json")),
    readJson<JsonRecord>(paths.curationReport),
    readJson<JsonRecord>(paths.pipelineRun),
    readJson<JsonRecord>(paths.latestReportMetadata),
    readJson<JsonRecord>(paths.sourceDiscovery),
    readSearchAnalytics(),
  ]);
  const registry = getSourceRegistry();
  const registryFingerprint = await sourceRegistryFingerprint(registry);
  const sourceSummary = summarizeSourceHealth(health, generatedAt);
  const sourceDiscovery = isRecord(discovery) && discovery.registryFingerprint === registryFingerprint
    ? discovery
    : await buildSourceDiscoveryReport({ checkedAt: generatedAt, health, registry });
  const [news, meetings, youtube, curatedItems] = await Promise.all([
    collectBatchItems(paths.news, "News", item => isActiveNewsSource(item.source)),
    collectBatchItems(paths.govMeetings, "Government meetings"),
    collectYouTubeItems(),
    collectCuratedItems(),
  ]);
  const curated = curatedItems.slice(0, MAX_RECENT_ITEMS);
  const recent = [...news, ...meetings, ...youtube]
    .sort((a, b) => itemDate({ date: b.date }) - itemDate({ date: a.date }) || a.id.localeCompare(b.id))
    .slice(0, MAX_RECENT_ITEMS);
  const missing = health.filter(source => source.status === "unavailable" || source.status === "stale").map(source => ({ source: source.source, status: source.status, ...(source.error ? { error: source.error } : {}), checkedAt: source.checkedAt }));
  // Source gaps are represented by sourceSummary.missing. Only an actual
  // failed pipeline envelope can make the analytical artifact degraded.
  // A missing/empty municipal-code corpus is genuine degradation even when the
  // source-health records exist — "ok" would falsely imply the analytical
  // view is complete while the code backbone is absent.
  const status: OverviewStatus = code.totalSections === 0
    ? (health.length === 0 ? "unavailable" : "degraded")
    : (pipeline?.status === "failed" ? "degraded" : "ok");
  const alertLevel = String(alerts?.level ?? "CALM");
  const allSignals = buildSignals({ health, alerts, alertAnalytics, code, curated, pipeline });
  // §5.5: public analytics never publish operator-side error strings. The
  // operator-only set is carried separately as an operator channel (stripped
  // from public export surfaces), never silently dropped.
  const { publicSignals, operatorSignals } = splitPublicOperatorSignals(allSignals);
  const signals = publicSignals.map(signal => isOperatorOnlySignal(signal) ? publicSignalNotice(signal) : signal);
  const operatorSignalsNoticed = operatorSignals.map(publicSignalNotice);
  const evidence = {
    code: { totalArticles: code.totalArticles, totalSections: code.totalSections, totalWords: code.totalWords, titleBreakdown: code.titleBreakdown },
    // Exclude check timestamps: polling an unchanged source should not trigger
    // a duplicate LLM completion. State/content changes remain fingerprinted.
    health: health.map(source => ({ source: source.source, status: source.status, itemCount: source.itemCount, freshness: source.freshness, error: source.error })),
    registryFingerprint,
    alerts: { level: alertLevel, reason: alerts?.reason ?? null, totalEvents: alertAnalytics.totalEvents, typeStats: alertAnalytics.typeStats, recent: alertAnalytics.mostRecentAlert ? { timestamp: alertAnalytics.mostRecentAlert.timestamp, type: alertAnalytics.mostRecentAlert.type, severity: alertAnalytics.mostRecentAlert.severity, description: alertAnalytics.mostRecentAlert.description } : null },
    content: { recent, curated },
    curation: curation ? { provider: curation.provider, model: curation.model, succeededCount: curation.succeededCount, retryableCount: curation.retryableCount } : null,
    pipeline: pipeline ? { status: pipeline.status } : null,
    reportPeriod: reportMetadata?.period ?? null,
    search,
    searchLogSnapshot: search.totalBytes,
  };
  const inputFingerprint = await computeSha256(stableInput(evidence));
  const summary = deterministicSummary({ status, alertLevel, sourceSummary, curatedCount: curatedItems.length, recentCount: recent.length });
  return {
    schemaVersion: ANALYTICS_OVERVIEW_SCHEMA,
    generatedAt,
    inputFingerprint,
    status,
    headline: status === "unavailable" ? "Crescent City intelligence is unavailable" : alertLevel !== "CALM" ? `${alertLevel}: inspect safety evidence first` : missing.length > 0 ? "Crescent City intelligence is ready with partial source coverage" : "Crescent City intelligence is ready to explore",
    summary,
    entryPoint: {
      title: "Start with the current signal",
      startHere: "Read the summary, inspect any warning signals, then open the underlying source or code record.",
      readOrder: ["Current summary", "Warnings and source health", "LLM-curated briefs with citations", "Municipal code and reports"],
      interpretation: "Empty means no matching event was recorded. Unavailable or stale means the system could not establish current state; it never means calm.",
    },
    metrics: {
      code: { articles: code.totalArticles, sections: code.totalSections, words: code.totalWords, avgWordsPerSection: code.avgWordsPerSection },
      sources: { ...sourceSummary, registryCount: registry.length, monitoredCount: registry.filter(source => source.automation === "monitored").length, discoveryOnlyCount: registry.filter(source => source.automation === "discovery-only").length, referenceOnlyCount: registry.filter(source => source.automation === "reference-only").length },
      content: { news: news.length, meetings: meetings.length, youtube: youtube.length, curated: curatedItems.length, searchQueries: search.totalQueries },
      alerts: { totalEvents: alertAnalytics.totalEvents, mostActiveType: alertAnalytics.mostActiveType, mostRecent: alertAnalytics.mostRecentAlert?.description ?? null },
    },
    code,
    sources: { missing, degraded: missing, coverageGaps: Array.isArray(sourceDiscovery.coverageGaps) ? sourceDiscovery.coverageGaps.map(String) : [], registryFingerprint },
    alerts: { level: alertLevel, reason: String(alerts?.reason ?? "No composite alert reason recorded."), assessedAt: typeof alerts?.assessedAt === "string" ? alerts.assessedAt : null, analytics: { totalEvents: alertAnalytics.totalEvents, mostActiveType: alertAnalytics.mostActiveType, mostRecentAlert: alertAnalytics.mostRecentAlert, typeStats: alertAnalytics.typeStats } },
    content: { recent, curated },
    pipeline: { status: typeof pipeline?.status === "string" ? pipeline.status : null, runId: typeof pipeline?.runId === "string" ? pipeline.runId : null, completedAt: typeof pipeline?.completedAt === "string" ? pipeline.completedAt : null, curationProvider: typeof curation?.provider === "string" ? curation.provider : null, curationModel: typeof curation?.model === "string" ? curation.model : null, reportPeriod: typeof reportMetadata?.period === "string" ? reportMetadata.period : null },
    signals,
    operatorSignalsNoticed,
    llm: { status: "not-requested", provider: llmConfig.provider, model: configuredChatModel(), promptVersion: ANALYTICS_SUMMARY_PROMPT_VERSION, inputFingerprint, summarizedAt: null },
  };
}

function summaryPrompt(overview: AnalyticsOverview): string {
  const signals = overview.signals.slice(0, 8).map(signal => `- ${signal.title}: ${signal.detail}`).join("\n") || "- No warning signals were recorded.";
  const curated = overview.content.curated.slice(0, 6).map(item => `- ${item.title}: ${item.summary ?? "No summary text"}`).join("\n") || "- No LLM-curated briefs are available.";
  return `Write a concise 2-4 sentence executive summary for a local Crescent City, California civic-intelligence dashboard. Use only the evidence below. Explicitly acknowledge unavailable or stale sources. Treat empty as a successful check with no matching records; do not infer that an empty alert feed is calm, do not invent causes or facts, and do not use a preamble or markdown headings.\n\nPipeline status: ${overview.status}\nComposite alert: ${overview.alerts.level} — ${overview.alerts.reason}\nSource coverage: ${overview.metrics.sources.present}/${overview.metrics.sources.total} present (${overview.metrics.sources.coveragePercent}%), ${overview.metrics.sources.missing} missing; states: ${overview.metrics.sources.ok} ok, ${overview.metrics.sources.empty} empty, ${overview.metrics.sources.unavailable} unavailable, ${overview.metrics.sources.stale} stale\nCode: ${overview.metrics.code.sections} sections, ${overview.metrics.code.articles} articles\nRecent public items: ${overview.metrics.content.news + overview.metrics.content.meetings + overview.metrics.content.youtube}\nCurated briefs:\n${curated}\nSignals:\n${signals}`;
}

export async function writeAnalyticsOverview(options: OverviewWriteOptions = {}): Promise<AnalyticsOverview> {
  const overview = await buildAnalyticsOverview(options);
  const previous = await readJson<AnalyticsOverview>(paths.analyticsOverview);
  if (!options.summarize) {
    const reusable = previous?.llm?.status === "ok" && previous.llm.inputFingerprint === overview.inputFingerprint && previous.llm.promptVersion === ANALYTICS_SUMMARY_PROMPT_VERSION;
    if (reusable) {
      overview.summary = previous.summary;
      overview.llm = previous.llm;
    } else {
      overview.llm = { ...overview.llm, status: "not-requested" };
    }
  } else {
    const provider = await checkChatProvider().catch(error => ({ provider: llmConfig.provider, configured: false, reachable: false, model: configuredChatModel(), error: error instanceof Error ? error.message : String(error) }));
    const canReuse = previous?.llm?.status === "ok" && previous.llm.inputFingerprint === overview.inputFingerprint && previous.llm.promptVersion === ANALYTICS_SUMMARY_PROMPT_VERSION && previous.llm.provider === provider.provider && previous.llm.model === provider.model && typeof previous.summary === "string";
    if (canReuse) {
      overview.summary = previous.summary;
      overview.llm = previous.llm;
    } else if (!provider.configured || !provider.reachable) {
      overview.llm = { ...overview.llm, status: "unavailable", provider: provider.provider, model: provider.model, error: provider.error ?? "Configured provider is unavailable" };
    } else {
      try {
        const result = await chatWithProvider([{ role: "user", content: summaryPrompt(overview) }]);
        if (!result.trim()) throw new Error("Provider returned an empty overview summary");
        overview.summary = result.trim();
        overview.llm = { ...overview.llm, status: "ok", provider: provider.provider, model: provider.model, summarizedAt: new Date().toISOString() };
      } catch (error) {
        overview.llm = { ...overview.llm, status: "unavailable", provider: provider.provider, model: provider.model, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  await writeJsonAtomic(paths.analyticsOverview, overview);
  return overview;
}

export async function readAnalyticsOverview(): Promise<AnalyticsOverview | null> {
  const overview = await readJson<AnalyticsOverview>(paths.analyticsOverview);
  return overview?.schemaVersion === ANALYTICS_OVERVIEW_SCHEMA ? overview : null;
}

/**
 * Public GitHub Pages snapshot builder.
 *
 * This is deliberately separate from the Bun GUI: Pages is a static artifact,
 * so it must never pretend that a local API, Ollama, Chroma, or a live feed is
 * available. Only bounded, public-facing summaries are exported. Request logs,
 * chat history, credentials, vector indexes, and Triplicate content are not
 * included; Triplicate metadata remains reference/citation-only.
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import type { SourceDefinition, SourceDiscoveryReport, SourceHealth, SourceHealthStatus, SourceHealthSummary } from "./types.js";
import { completeSourceHealth, summarizeSourceHealth, writeJsonAtomic } from "./shared/source_health.js";
import { runtimeMetadata } from "./shared/orchestration.js";
import { buildSourceDiscoveryReport, getSourceRegistry, sourceRegistryFingerprint } from "./source_registry.js";
import { isActiveNewsSource } from "./news_monitor.js";
import type { AnalyticsOverview } from "./analytics_backend.js";

const REPOSITORY_URL = "https://github.com/docxology/crescent-city-intel";
const MUNICIPAL_CODE_URL = "https://ecode360.com/CR4919";
const STATIC_DIR = join(import.meta.dir, "pages", "static");
const MAX_ITEMS = 100;
const SOURCE_HEALTH_FILES = [
  "news/source-health.json",
  "gov_meetings/source-health.json",
  "youtube/source-health.json",
  "triplicate/source-health.json",
  "alerts/source-health.json",
];

export interface PagesSnapshot {
  schemaVersion: "1.0.0";
  generatedAt: string;
  repository: string;
  commit: string | null;
  status: "ok" | "degraded" | "unavailable";
  healthSummary: SourceHealthSummary;
  sourceRegistry: SourceDefinition[];
  sourceRegistryFingerprint: string;
  sourceDiscovery: SourceDiscoveryReport | null;
  municipalCode: {
    available: boolean;
    source: string;
    manifest: Record<string, unknown> | null;
    verification: Record<string, unknown> | null;
    coverage: Record<string, unknown> | null;
    readability: Record<string, unknown> | null;
  };
  sourceHealth: SourceHealth[];
  news: Array<Record<string, unknown>>;
  meetings: Array<Record<string, unknown>>;
  youtube: Array<Record<string, unknown>>;
  triplicate: Array<Record<string, unknown>>;
  curated: Array<Record<string, unknown>>;
  alerts: {
    composite: Record<string, unknown> | null;
    current: Array<Record<string, unknown>>;
  };
  report: {
    monthly: string | null;
    metadata: Record<string, unknown> | null;
    weeklySummary: Record<string, unknown> | null;
    pipelineRun: Record<string, unknown> | null;
    curation: Record<string, unknown> | null;
  };
  /** Shared deterministic + optional LLM overview used as the public entry point. */
  analytics: AnalyticsOverview | null;
  files: {
    code: string | null;
    toc: string | null;
    manifest: string | null;
    verification: string | null;
    coverage: string | null;
    readability: string | null;
    report: string | null;
    reportMetadata: string | null;
    pipelineRun: string | null;
    curation: string | null;
    sourceHealth: string;
    sourceRegistry: string;
    sourceDiscovery: string;
    analyticsOverview: string | null;
  };
  publicationPolicy: {
    triplicate: "reference-citation-only";
    curationInputs: string[];
    excludedFromSnapshot: string[];
  };
}

export interface PagesExportResult {
  destination: string;
  generatedAt: string;
  status: PagesSnapshot["status"];
  files: string[];
  itemCounts: {
    sourceHealth: number;
    news: number;
    meetings: number;
    youtube: number;
    triplicate: number;
    curated: number;
    alerts: number;
  };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readJsonLines(path: string): Promise<JsonRecord[]> {
  try {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
    return lines.flatMap(line => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function listFiles(directory: string, predicate: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && predicate(entry.name)).map(entry => join(directory, entry.name)).sort();
  } catch {
    return [];
  }
}

function isoValue(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function itemDate(item: JsonRecord): number {
  for (const key of ["pubDate", "date", "fetchedAt", "curatedAt", "uploadDate"]) {
    const value = item[key];
    if (typeof value === "string") {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
  }
  return 0;
}

function dedupe<T extends JsonRecord>(items: T[], keys: string[]): T[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => itemDate(b) - itemDate(a))
    .filter(item => {
      const key = keys.map(name => String(item[name] ?? "")).join("|") || JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ITEMS);
}

function normalizeNews(item: JsonRecord): JsonRecord | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const link = typeof item.link === "string" ? item.link.trim() : "";
  if (!title || !/^https?:\/\//i.test(link)) return null;
  return {
    id: typeof item.id === "string" ? item.id : link,
    title,
    link,
    source: typeof item.source === "string" ? item.source : "Unknown source",
    pubDate: typeof item.pubDate === "string" ? item.pubDate : null,
    description: typeof item.description === "string" ? item.description : typeof item.content === "string" ? item.content : "",
    fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
  };
}

function normalizeMeeting(item: JsonRecord): JsonRecord | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const link = typeof item.link === "string" ? item.link.trim() : "";
  if (!title || !/^https?:\/\//i.test(link)) return null;
  return {
    id: typeof item.id === "string" ? item.id : link,
    title,
    link,
    source: typeof item.source === "string" ? item.source : "Government meeting",
    date: typeof item.date === "string" ? item.date : null,
    content: typeof item.content === "string" ? item.content : typeof item.body === "string" ? item.body : "",
    fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
  };
}

function normalizeYouTube(item: JsonRecord): JsonRecord | null {
  const videoId = typeof item.videoId === "string" ? item.videoId : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!videoId || !title) return null;
  return {
    videoId,
    title,
    channel: typeof item.channel === "string" ? item.channel : "",
    uploadDate: typeof item.uploadDate === "string" ? item.uploadDate : null,
    fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
    status: typeof item.status === "string" ? item.status : "unknown",
    link: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  };
}

function normalizeTriplicate(item: JsonRecord): JsonRecord | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const link = typeof item.link === "string" ? item.link.trim() : "";
  if (!title || !/^https?:\/\//i.test(link)) return null;
  return {
    title,
    link,
    section: typeof item.section === "string" ? item.section : "",
    fetchedAt: typeof item.fetchedAt === "string" ? item.fetchedAt : null,
    usagePolicy: "reference-citation-only; NEVER AI-training input",
  };
}

function normalizeCurated(item: JsonRecord): JsonRecord | null {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const link = typeof item.link === "string" ? item.link.trim() : "";
  if (!title || !/^https?:\/\//i.test(link)) return null;
  return {
    id: typeof item.id === "string" ? item.id : link,
    title,
    link,
    summary: typeof item.summary === "string" ? item.summary : "",
    tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === "string").slice(0, 12) : [],
    source: typeof item.source === "string" ? item.source : "unknown",
    provider: typeof item.provider === "string" ? item.provider : null,
    model: typeof item.model === "string" ? item.model : null,
    curatedAt: typeof item.curatedAt === "string" ? item.curatedAt : null,
    provenance: typeof item.provenance === "string" ? item.provenance : "source-grounded summary; follow the cited source",
  };
}

async function collectBatchItems(
  directory: string,
  prefix: string,
  normalizer: (item: JsonRecord) => JsonRecord | null,
  include: (item: JsonRecord) => boolean = () => true,
): Promise<JsonRecord[]> {
  const files = await listFiles(directory, name => name.startsWith(prefix) && name.endsWith(".json"));
  const batches: JsonRecord[] = [];
  for (const path of files) {
    const parsed = await readJson<unknown>(path);
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) continue;
    for (const item of parsed.items) {
      if (isRecord(item) && include(item)) {
        const normalized = normalizer(item);
        if (normalized) batches.push(normalized);
      }
    }
  }
  return batches;
}

async function collectYouTube(directory: string): Promise<JsonRecord[]> {
  const files = await listFiles(directory, name => name.endsWith(".json") && name !== "source-health.json");
  const items: JsonRecord[] = [];
  for (const path of files) {
    const parsed = await readJson<unknown>(path);
    if (isRecord(parsed)) {
      const normalized = normalizeYouTube(parsed);
      if (normalized) items.push(normalized);
    }
  }
  return dedupe(items, ["videoId"]);
}

async function collectTriplicate(directory: string): Promise<JsonRecord[]> {
  const files = await listFiles(directory, name => name.startsWith("triplicate-") && name.endsWith(".json"));
  const items: JsonRecord[] = [];
  for (const path of files) {
    const parsed = await readJson<unknown>(path);
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) continue;
    for (const item of parsed.items) {
      if (isRecord(item)) {
        const normalized = normalizeTriplicate(item);
        if (normalized) items.push(normalized);
      }
    }
  }
  return dedupe(items, ["link"]);
}

async function collectCurated(directory: string): Promise<JsonRecord[]> {
  const files = await listFiles(directory, name => name.endsWith(".json"));
  const items: JsonRecord[] = [];
  for (const path of files) {
    const parsed = await readJson<unknown>(path);
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (isRecord(item)) {
        const normalized = normalizeCurated(item);
        if (normalized) items.push(normalized);
      }
    }
  }
  return dedupe(items, ["id", "link"]);
}

async function collectHealth(outputDir: string, checkedAt: string): Promise<SourceHealth[]> {
  const health: SourceHealth[] = [];
  for (const relativePath of SOURCE_HEALTH_FILES) {
    const parsed = await readJson<unknown>(join(outputDir, relativePath));
    if (!isRecord(parsed) || !Array.isArray(parsed.sources)) continue;
    for (const source of parsed.sources) {
      if (!isRecord(source)) continue;
      const status = source.status;
      if (!(["ok", "empty", "unavailable", "stale"] as string[]).includes(String(status))) continue;
      health.push({
        source: typeof source.source === "string" ? source.source : "Unknown source",
        status: status as SourceHealthStatus,
        checkedAt: isoValue(source.checkedAt) ?? new Date(0).toISOString(),
        fetchedAt: isoValue(source.fetchedAt) ?? undefined,
        itemCount: typeof source.itemCount === "number" && Number.isFinite(source.itemCount) ? source.itemCount : 0,
        url: typeof source.url === "string" && /^https?:\/\//i.test(source.url) ? source.url : undefined,
        error: typeof source.error === "string" ? source.error : undefined,
        httpStatus: typeof source.httpStatus === "number" ? source.httpStatus : undefined,
        ageMs: typeof source.ageMs === "number" ? source.ageMs : undefined,
        provenance: typeof source.provenance === "string" ? source.provenance : undefined,
        freshness: ["fresh", "stale", "unknown"].includes(String(source.freshness))
          ? source.freshness as SourceHealth["freshness"]
          : undefined,
        freshnessWindowMs: typeof source.freshnessWindowMs === "number" ? source.freshnessWindowMs : undefined,
        durationMs: typeof source.durationMs === "number" ? source.durationMs : undefined,
        disabled: typeof source.disabled === "boolean" ? source.disabled : undefined,
      });
    }
  }
  return completeSourceHealth(health, checkedAt);
}

async function collectCurrentAlerts(outputDir: string): Promise<{ composite: JsonRecord | null; current: JsonRecord[] }> {
  const alertsDir = join(outputDir, "alerts");
  let directories: string[] = [];
  try {
    const entries = await readdir(alertsDir, { withFileTypes: true });
    directories = entries.filter(entry => entry.isDirectory()).map(entry => join(alertsDir, entry.name));
  } catch {
    directories = [];
  }
  const files = (await Promise.all(directories.map(directory => listFiles(directory, name => name === "current.json")))).flat();
  const current: JsonRecord[] = [];
  let composite: JsonRecord | null = null;
  for (const path of files) {
    const parsed = await readJson<unknown>(path);
    if (!isRecord(parsed)) continue;
    const monitor = relative(alertsDir, dirname(path)).split("/")[0] ?? "unknown";
    if (monitor === "composite") composite = parsed;
    else current.push({ ...parsed, monitor });
  }
  return { composite, current };
}

function snapshotStatus(codeAvailable: boolean, pipelineRun: JsonRecord | null): PagesSnapshot["status"] {
  // Missing source checks are represented in healthSummary and sourceHealth;
  // they do not invalidate an otherwise complete static snapshot.
  if (!codeAvailable) return "unavailable";
  if (pipelineRun?.status === "failed" || pipelineRun?.status === "degraded") return "degraded";
  return "ok";
}

export async function buildPagesSnapshot(
  outputDir = "output",
  generatedAt = new Date().toISOString(),
  seedDir = "pages-data",
): Promise<PagesSnapshot> {
  const resolvedOutput = resolve(outputDir);
  const resolvedSeed = resolve(seedDir);
  async function readFirstJson<T>(filename: string): Promise<T | null> {
    return await readJson<T>(join(resolvedOutput, filename)) ?? await readJson<T>(join(resolvedSeed, filename));
  }
  const manifest = await readFirstJson<JsonRecord>("manifest.json");
  const verification = await readFirstJson<JsonRecord>("verification-report.json");
  const coverage = await readFirstJson<JsonRecord>("domain-coverage.json");
  const readability = await readFirstJson<JsonRecord>("readability.json");
  const health = await collectHealth(resolvedOutput, generatedAt);
  const healthSummary = summarizeSourceHealth(health, generatedAt);
  const registryPayload = await readFirstJson<{ sources?: SourceDefinition[] }>("source-registry.json");
  const sourceRegistry = Array.isArray(registryPayload?.sources) ? registryPayload.sources : getSourceRegistry();
  const registryFingerprint = await sourceRegistryFingerprint(sourceRegistry);
  const persistedDiscovery = await readFirstJson<SourceDiscoveryReport>("source-discovery.json");
  const sourceDiscovery = persistedDiscovery?.registryFingerprint === registryFingerprint && persistedDiscovery.sourceCount === sourceRegistry.length
    ? persistedDiscovery
    : await buildSourceDiscoveryReport({ checkedAt: generatedAt, health, registry: sourceRegistry });
  const alerts = await collectCurrentAlerts(resolvedOutput);
  const reportPath = (await listFiles(join(resolvedOutput, "reports"), name => name.startsWith("monthly-") && name.endsWith(".md"))).at(-1) ?? null;
  const monthly = reportPath ? await readFile(reportPath, "utf8").catch(() => null) : null;
  const reportMetadata = reportPath
    ? await readJson<JsonRecord>(reportPath.replace(/\.md$/, ".json"))
    : null;
  const weeklySummary = await readJson<JsonRecord>(join(resolvedOutput, "weekly-check-summary.json"));
  const pipelineRun = await readJson<JsonRecord>(join(resolvedOutput, "state/latest-pipeline-run.json"));
  const curation = await readJson<JsonRecord>(join(resolvedOutput, "state/curation-report.json"));
  const analytics = await readJson<AnalyticsOverview>(join(resolvedOutput, "state/analytics-overview.json"));
  const codeAvailable = await readFirstJson<unknown>("crescent-city-code.json") !== null;

  const [news, meetings, youtube, triplicate, curated] = await Promise.all([
    collectBatchItems(join(resolvedOutput, "news"), "news-", normalizeNews, item => isActiveNewsSource(item.source)),
    collectBatchItems(join(resolvedOutput, "gov_meetings"), "gov_meetings-", normalizeMeeting),
    collectYouTube(join(resolvedOutput, "youtube")),
    collectTriplicate(join(resolvedOutput, "triplicate")),
    collectCurated(join(resolvedOutput, "curated")),
  ]);

  const commit = runtimeMetadata().commit;
  const snapshot: PagesSnapshot = {
    schemaVersion: "1.0.0",
    generatedAt,
    repository: REPOSITORY_URL,
    commit,
    status: snapshotStatus(codeAvailable, pipelineRun),
    healthSummary,
    sourceRegistry,
    sourceRegistryFingerprint: registryFingerprint,
    sourceDiscovery,
    municipalCode: {
      available: codeAvailable,
      source: MUNICIPAL_CODE_URL,
      manifest,
      verification,
      coverage,
      readability,
    },
    sourceHealth: health,
    news: dedupe(news, ["id", "link"]),
    meetings: dedupe(meetings, ["id", "link"]),
    youtube,
    triplicate,
    curated,
    alerts,
    report: { monthly, metadata: reportMetadata, weeklySummary, pipelineRun, curation },
    analytics: analytics?.schemaVersion === "1.0.0" ? analytics : null,
    files: {
      code: codeAvailable ? "data/code.json" : null,
      toc: (await readFirstJson<unknown>("toc.json")) !== null ? "data/toc.json" : null,
      manifest: manifest ? "data/manifest.json" : null,
      verification: verification ? "data/verification-report.json" : null,
      coverage: coverage ? "data/domain-coverage.json" : null,
      readability: readability ? "data/readability.json" : null,
      report: monthly ? "data/report.md" : null,
      reportMetadata: reportMetadata ? "data/report-metadata.json" : null,
      pipelineRun: pipelineRun ? "data/pipeline-run.json" : null,
      curation: curation ? "data/curation.json" : null,
      analyticsOverview: analytics?.schemaVersion === "1.0.0" ? "data/analytics-overview.json" : null,
      sourceHealth: "data/source-health.json",
      sourceRegistry: "data/source-registry.json",
      sourceDiscovery: "data/source-discovery.json",
    },
    publicationPolicy: {
      triplicate: "reference-citation-only",
      curationInputs: ["news", "gov_meetings", "youtube"],
      excludedFromSnapshot: ["chat-history", "request-log", "search-queries", "rag-queries", "chroma-data", "Triplicate article content"],
    },
  };
  return snapshot;
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  const value = await readFile(source).catch(() => null);
  if (value === null) return false;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, value);
  return true;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function exportPagesSnapshot(options: { outputDir?: string; destination?: string; generatedAt?: string; seedDir?: string } = {}): Promise<PagesExportResult> {
  const destination = resolve(options.destination ?? ".pages");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const seedDir = options.seedDir ?? "pages-data";
  const snapshot = await buildPagesSnapshot(options.outputDir ?? "output", generatedAt, seedDir);
  const temporary = await mkdtemp(join(dirname(destination), ".pages-build-"));
  const files: string[] = [];
  try {
    await copyIfPresent(join(STATIC_DIR, "index.html"), join(temporary, "index.html"));
    await copyIfPresent(join(STATIC_DIR, "404.html"), join(temporary, "404.html"));
    await writeFile(join(temporary, ".nojekyll"), "\n", "utf8");
    files.push("index.html", "404.html", ".nojekyll");

    await writeJson(join(temporary, "data/snapshot.json"), snapshot);
    await writeJson(join(temporary, "data/source-health.json"), snapshot.sourceHealth);
    await writeJson(join(temporary, "data/source-registry.json"), snapshot.sourceRegistry);
    await writeJson(join(temporary, "data/source-discovery.json"), snapshot.sourceDiscovery);
    files.push("data/snapshot.json", "data/source-health.json", "data/source-registry.json", "data/source-discovery.json");

    const sourceRoot = resolve(options.outputDir ?? "output");
    const seedRoot = resolve(seedDir);
    async function copyFirstPresent(filename: string, destinationPath: string): Promise<boolean> {
      return await copyIfPresent(join(sourceRoot, filename), destinationPath) || await copyIfPresent(join(seedRoot, filename), destinationPath);
    }
    const optionalCopies: Array<[string, string]> = [
      ["crescent-city-code.json", "data/code.json"],
      ["toc.json", "data/toc.json"],
      ["manifest.json", "data/manifest.json"],
      ["verification-report.json", "data/verification-report.json"],
      ["domain-coverage.json", "data/domain-coverage.json"],
      ["readability.json", "data/readability.json"],
    ];
    for (const [source, target] of optionalCopies) {
      if (await copyFirstPresent(source, join(temporary, target))) files.push(target);
    }
    if (snapshot.report.monthly !== null) {
      await writeFile(join(temporary, "data/report.md"), snapshot.report.monthly, "utf8");
      files.push("data/report.md");
    }
    if (snapshot.report.metadata) {
      await writeJson(join(temporary, "data/report-metadata.json"), snapshot.report.metadata);
      files.push("data/report-metadata.json");
    }
    if (snapshot.report.pipelineRun) {
      await writeJson(join(temporary, "data/pipeline-run.json"), snapshot.report.pipelineRun);
      files.push("data/pipeline-run.json");
    }
    if (snapshot.report.curation) {
      await writeJson(join(temporary, "data/curation.json"), snapshot.report.curation);
      files.push("data/curation.json");
    }
    if (snapshot.analytics) {
      await writeJson(join(temporary, "data/analytics-overview.json"), snapshot.analytics);
      files.push("data/analytics-overview.json");
    }

    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return {
      destination,
      generatedAt,
      status: snapshot.status,
      files,
      itemCounts: {
        sourceHealth: snapshot.sourceHealth.length,
        news: snapshot.news.length,
        meetings: snapshot.meetings.length,
        youtube: snapshot.youtube.length,
        triplicate: snapshot.triplicate.length,
        curated: snapshot.curated.length,
        alerts: snapshot.alerts.current.length,
      },
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Used by the release gate without writing a Pages artifact. */
export function validatePagesSource(indexHtml: string): string[] {
  const errors: string[] = [];
  if (!indexHtml.includes("data/snapshot.json")) errors.push("Pages index does not load data/snapshot.json");
  if (indexHtml.includes("__CC_API_KEY__") || indexHtml.includes("__CC_API_KEY_INJECT__")) errors.push("Pages index contains an API-key placeholder");
  if (indexHtml.includes("localhost:3000") || indexHtml.includes("localhost:8001")) errors.push("Pages index references a local-only service");
  if (!indexHtml.includes("source-health.json")) errors.push("Pages index does not expose source health");
  if (!indexHtml.includes("source-discovery.json")) errors.push("Pages index does not expose source discovery");
  if (!indexHtml.includes("sourceRegistry")) errors.push("Pages index does not render the source registry");
  if (!indexHtml.includes('id="refresh"')) errors.push("Pages index does not expose a refresh control");
  if (!indexHtml.includes("snapshot.healthSummary")) errors.push("Pages index does not render aggregate health metadata");
  if (!indexHtml.includes("snapshot.analytics")) errors.push("Pages index does not render the shared analytics overview");
  return errors;
}

export async function writePagesSnapshotManifest(path: string, result: PagesExportResult): Promise<void> {
  await writeJsonAtomic(path, result);
}

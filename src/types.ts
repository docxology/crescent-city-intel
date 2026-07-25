/** All TypeScript interfaces for the Crescent City Municipal Code project */

// ─── TOC / Scraping ──────────────────────────────────────────────

/** A node in the ecode360 table of contents tree */
export interface TocNode {
  prefix: string;
  tocName: string;
  guid: string;
  parent: string | null;
  href: string;
  title: string;
  number: string;
  indexNum: string;
  type: "code" | "division" | "chapter" | "article" | "part" | "subarticle" | "section";
  label: string;
  hideNumber: boolean;
  children: TocNode[];
}

/** Scraped content for a single article (chapter) page */
export interface ArticlePage {
  guid: string;
  url: string;
  title: string;
  number: string;
  /** Raw inner HTML of #codeContent */
  rawHtml: string;
  /** Sections extracted from the page */
  sections: SectionContent[];
  /** SHA-256 hash of rawHtml for integrity verification */
  sha256: string;
  scrapedAt: string;
}

/** A single section (e.g. § 1.04.010) extracted from an article page */
export interface SectionContent {
  guid: string;
  number: string;
  title: string;
  /** Raw inner HTML of the section content div */
  html: string;
  /** Plain text of the section */
  text: string;
  /** Legislative history line */
  history: string;
}

/** Manifest tracking all scraped content */
export interface ScrapeManifest {
  municipality: string;
  municipalityGuid: string;
  sourceUrl: string;
  version: string;
  scrapedAt: string;
  completedAt: string;
  tocNodeCount: number;
  articlePageCount: number;
  sectionCount: number;
  /** Fingerprint and provenance for the TOC that defined this run. */
  tocFingerprint?: string;
  tocFetchedAt?: string;
  tocSource?: "live" | "cached";
  lastRunAt?: string;
  /** Map of article guid → ArticlePage metadata (without rawHtml) */
  articles: Record<string, {
    guid: string;
    title: string;
    number: string;
    sectionCount: number;
    sha256: string;
    filePath: string;
    lastScrapedAt?: string;
  }>;
}

// ─── Verification ────────────────────────────────────────────────

/** Verification result for a single article */
export interface VerificationResult {
  guid: string;
  title: string;
  status: "pass" | "fail";
  checks: {
    fileExists: boolean;
    sha256Match: boolean;
    sectionCountMatch: boolean;
    expectedSections: number;
    foundSections: number;
    allSectionsPresent: boolean;
    missingSections: string[];
  };
}

/** Overall verification report */
export interface VerificationReport {
  verifiedAt: string;
  municipality: string;
  overallStatus: "pass" | "fail";
  totalArticles: number;
  passedArticles: number;
  failedArticles: number;
  totalExpectedSections: number;
  totalFoundSections: number;
  missingSections: string[];
  results: VerificationResult[];
}

// ─── Shared data ─────────────────────────────────────────────────

/** A flattened section with article metadata for search/display */
export interface FlatSection {
  guid: string;
  number: string;
  title: string;
  text: string;
  history: string;
  articleGuid: string;
  articleTitle: string;
  articleNumber: string;
}

// ─── GUI / Search ────────────────────────────────────────────────

/** Search result wrapping a FlatSection */
export interface SearchResult {
  section: FlatSection;
  snippet: string;
  matchCount: number;
}

// ─── LLM / Chat ──────────────────────────────────────────────────

/** A chat message for LLM interactions */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A source citation from RAG retrieval — either a municipal code section or a YouTube meeting transcript chunk */
export interface RagSource {
  sourceType: "municipal_code" | "youtube_transcript";
  sectionGuid: string;
  sectionNumber: string;
  sectionTitle: string;
  snippet: string;
  score: number;
  /** Present only when sourceType is "youtube_transcript" */
  videoId?: string;
  /** Present only when sourceType is "youtube_transcript" — VTT-cue timestamp "HH:MM:SS.mmm" */
  timestamp?: string;
}

/** Response from the RAG pipeline */
export interface RagResponse {
  answer: string;
  sources: RagSource[];
  model: string;
  provider: "ollama" | "openrouter";
  /** Stable identifier for correlating API responses, logs, and UI feedback. */
  queryId?: string;
  /** Generation and retrieval metadata; optional for backwards-compatible artifacts. */
  metadata?: RagMetadata;
}

/** Operational metadata attached to a RAG answer. */
export interface RagMetadata {
  generatedAt: string;
  latencyMs: number;
  retrievalCount: number;
  requestedTopK: number;
  contextFingerprint: string;
  grounded: boolean;
  embeddingProvider: "ollama";
  embeddingModel: string;
  vectorStore: "chroma";
  collection: string;
}

// ─── Analytics ───────────────────────────────────────────────────

/** Per-title aggregate statistics */
export interface TitleStats {
  title: string;
  sectionCount: number;
  wordCount: number;
  avgWordsPerSection: number;
}

/** Aggregate municipal code statistics */
export interface CodeStats {
  totalArticles: number;
  totalSections: number;
  totalWords: number;
  avgWordsPerSection: number;
  byTitle: TitleStats[];
  longestSections: Array<{ number: string; title: string; wordCount: number }>;
  shortestSections: Array<{ number: string; title: string; wordCount: number }>;
}

/** A single point in a PCA projection */
export interface EmbeddingPoint {
  x: number;
  y: number;
  cluster: number;
  label: string;
  sectionNumber: string;
}

/** Pearson correlation of a term to a principal component */
export interface WordLoading {
  word: string;
  pc1: number;
  pc2: number;
  combined: number;
}

/** Full PCA projection result */
export interface EmbeddingProjection {
  points: EmbeddingPoint[];
  wordLoadings: WordLoading[];
  explainedVariance: number[];
}

// ─── Monitoring ──────────────────────────────────────────────────

/** Municipal code change detection report */
export interface MonitorReport {
  timestamp: string;
  articlesChecked: number;
  hashMismatches: string[];
  missingSections: string[];
  newSections: string[];
  overallStatus: "clean" | "changed" | "error";
  summary: string;
}

/** A news item fetched from an RSS feed */
export interface NewsItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  source: string;
  description: string;
  fetchedAt: string;
}

/** A government meeting item scraped from a city website */
export interface MeetingItem {
  id: string;
  title: string;
  body: string;
  source: string;
  url: string;
  fetchedAt: string;
  hash: string;
}

// ─── Source health / provenance ─────────────────────────────────

/** Operational state for an external or generated data source. */
export type SourceHealthStatus = "ok" | "empty" | "unavailable" | "stale";

/** Common health envelope used by feeds, monitors, reports, and the GUI. */
export interface SourceHealth {
  source: string;
  status: SourceHealthStatus;
  checkedAt: string;
  fetchedAt?: string;
  itemCount: number;
  url?: string;
  error?: string;
  httpStatus?: number;
  ageMs?: number;
  provenance?: string;
  /** Derived freshness state, separate from operational status. */
  freshness?: "fresh" | "stale" | "unknown";
  /** Expected maximum age used when freshness was derived, in milliseconds. */
  freshnessWindowMs?: number;
  /** Duration of the source check, when measured by the monitor. */
  durationMs?: number;
  /** True when the source was intentionally disabled by configuration. */
  disabled?: boolean;
}

/** Counts used by orchestration, reports, and the interactive dashboards. */
export interface SourceHealthSummary {
  checkedAt: string;
  total: number;
  ok: number;
  empty: number;
  unavailable: number;
  stale: number;
  /** Sources reached successfully, including sources with no matching items. */
  present: number;
  /** Sources whose current state could not be established. */
  missing: number;
  /** Percentage of source checks with an established current state. */
  coveragePercent: number;
  /** Human-readable aggregate coverage state; not a pipeline failure state. */
  coverageStatus: "complete" | "partial" | "none";
  presentSources: string[];
  missingSources: string[];
  /** Backwards-compatible alias for unavailable + stale. Prefer `missing`. */
  degraded: number;
  sources: string[];
}

/** Stable classification for the source discovery registry. */
export type SourceKind =
  | "municipal_code"
  | "city_official"
  | "county_official"
  | "meeting"
  | "news"
  | "alert"
  | "video"
  | "harbor"
  | "transportation"
  | "environment"
  | "reference";

export type SourceAuthority = "official" | "public_agency" | "journalistic" | "reference";
export type SourceCollectionMode = "api" | "rss" | "atom" | "html" | "playwright" | "yt-dlp" | "manual";
export type SourceAutomation = "monitored" | "discovery-only" | "reference-only";

/** One canonical online source in the reviewed Crescent City coverage boundary. */
export interface SourceDefinition {
  id: string;
  name: string;
  kind: SourceKind;
  authority: SourceAuthority;
  region: "Crescent City" | "Del Norte County" | "North Coast" | "California" | "Federal";
  canonicalUrl: string;
  endpointUrl?: string;
  discoveredFrom: string[];
  collectionMode: SourceCollectionMode;
  automation: SourceAutomation;
  enabled: boolean;
  configuredMonitor?: string;
  referenceOnly?: boolean;
  expectedCadence?: string;
  provenance: string;
  notes?: string;
}

/** Registry entry enriched with the latest known operational state, if any. */
export interface SourceDiscoveryRecord extends SourceDefinition {
  operationalStatus: SourceHealthStatus | "not-checked";
  checkedAt?: string;
  itemCount: number;
  error?: string;
  healthSource?: string;
}

/** Durable inventory and coverage report used by the GUI, Pages, and reports. */
export interface SourceDiscoveryReport {
  schemaVersion: "1.0.0";
  generatedAt: string;
  scope: string;
  registryFingerprint: string;
  previousFingerprint: string | null;
  changed: boolean;
  sourceCount: number;
  monitoredCount: number;
  discoveryOnlyCount: number;
  referenceOnlyCount: number;
  enabledCount: number;
  countsByKind: Record<string, number>;
  countsByAuthority: Record<string, number>;
  coverageGaps: string[];
  sources: SourceDiscoveryRecord[];
}

/** One independently observable stage in a pipeline run. */
export interface PipelineStepReport {
  name: string;
  status: "ok" | "degraded" | "failed" | "skipped";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  itemCount?: number;
  outputPaths?: string[];
  error?: string;
  metadata?: Record<string, unknown>;
}

/** Durable orchestration envelope written after a weekly or scheduled run. */
export interface PipelineRunReport {
  schemaVersion: "1.0.0";
  runId: string;
  pipeline: string;
  status: "ok" | "degraded" | "failed";
  exitCode: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  steps: PipelineStepReport[];
  sourceHealth: SourceHealthSummary;
  metadata: {
    appVersion: string;
    commit: string | null;
    runtime: string;
    ci: boolean;
  };
}

/** Machine-readable report summary paired with the human-readable Markdown report. */
export interface MonthlyReportMetadata {
  schemaVersion: "1.0.0";
  reportType: "monthly-civic-health";
  period: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  status: "ok" | "degraded" | "unavailable";
  metrics: Record<string, number>;
  sourceHealth: SourceHealthSummary;
  sourceDiscovery: {
    registryFingerprint: string;
    sourceCount: number;
    monitoredCount: number;
    discoveryOnlyCount: number;
    referenceOnlyCount: number;
    coverageGaps: string[];
  };
  artifacts: { markdown: string; metadata: string };
  warnings: string[];
}

/** Citation carried by a curated brief; the brief is not evidence without it. */
export interface CurationCitation {
  url: string;
  label: string;
  source: "news" | "gov_meetings" | "youtube";
  fetchedAt: string;
}

/** Batch-level metadata for LLM curation, safe to expose as operational telemetry. */
export interface CurationRunReport {
  schemaVersion: "1.0.0";
  runId: string;
  startedAt: string;
  completedAt: string;
  provider: "ollama" | "openrouter" | "none";
  model: string;
  inputCount: number;
  attemptedCount: number;
  succeededCount: number;
  retryableCount: number;
  sourceOnlyCount: number;
  outputPath: string | null;
  /** False when the run had no work and intentionally skipped provider I/O. */
  providerChecked?: boolean;
  providerReachable: boolean;
  providerError?: string;
}

// ─── Intelligence Domains ────────────────────────────────────────

/** Cross-reference from a domain topic to a municipal code section */
export interface DomainSource {
  /** Municipal code section number, e.g. "§ 8.04.010" */
  sectionNumber: string;
  /** Brief description of relevance */
  relevance: string;
}

/** A topic within an intelligence domain */
export interface DomainTopic {
  name: string;
  description: string;
  /** Cross-references to municipal code sections */
  sources: DomainSource[];
  /** External reference URLs */
  externalRefs?: string[];
  /** Tags for search/filtering */
  tags: string[];
}

/** A top-level civic intelligence domain */
export interface IntelligenceDomain {
  id: string;
  name: string;
  description: string;
  /** Emoji icon */
  icon: string;
  topics: DomainTopic[];
  /** ISO date of last update */
  updatedAt: string;
}

/** Lightweight domain summary (no topics) for listings */
export interface DomainSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  topicCount: number;
  updatedAt: string;
}

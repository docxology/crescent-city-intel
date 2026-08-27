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
import { buildGeoIntel } from "./geo.js";
import { buildGeoIntelSurface, buildGeoViewSvg, type GeoIntelSurface, type GeoIntelView } from "./geo_view.js";
import { buildEventsArtifact, buildEventsIcs, collectEvents, type EventsArtifact } from "./events.js";

const REPOSITORY_URL = "https://github.com/docxology/crescent-city-intel";
const NEWSPAPER_NAME = "The Quadruplicate";
const CONTACT_EMAIL = "CrescentCity@tuta.com";
const TAGLINE = "Sea Something. Say Something.";
const MUNICIPAL_CODE_URL = "https://ecode360.com/CR4919";
const STATIC_DIR = join(import.meta.dir, "pages", "static");
const MAX_ITEMS = 100;
export const PAGES_GEO_INTEL_ARTIFACT = "data/geo-intel.json";
export const PAGES_EVENTS_ARTIFACT = "data/events.json";
export const PAGES_EVENTS_ICS_ARTIFACT = "data/events.ics";
const PAGES_SITE_URL = "https://quadruplicate.org";
export const PAGES_ROBOTS_TXT = "robots.txt";
export const PAGES_SITEMAP_XML = "sitemap.xml";
export const PAGES_GEO_VIEW_PLACEHOLDER = '<template data-pages-geo-view></template>';
export const PAGES_FEED_XML = "feed.xml";
export const PAGES_FEED_LINK_HTML = '<link rel="alternate" type="application/rss+xml" title="The Quadruplicate - public intelligence feed" href="https://quadruplicate.org/feed.xml">';
/** Export-time injection point for the edition date in the WebSite JSON-LD block. */
export const PAGES_DATE_PUBLISHED_PLACEHOLDER = "__PAGES_DATE_PUBLISHED__";
export const PAGES_DATE_MODIFIED_PLACEHOLDER = "__PAGES_DATE_MODIFIED__";
/** Per-page JSON-LD injection markers (WebPage / BreadcrumbList / Dataset). */
export const PAGES_JSONLD_WEBPAGE_PLACEHOLDER = "<!--PAGES_JSONLD_WEBPAGE-->";
export const PAGES_JSONLD_BREADCRUMB_PLACEHOLDER = "<!--PAGES_JSONLD_BREADCRUMB-->";
export const PAGES_JSONLD_DATASET_PLACEHOLDER = "<!--PAGES_JSONLD_DATASET-->";
export const PAGES_FEED_MAX_ITEMS = 60;

/** Export-time injection point for manifest-derived counts inside the Methods & Provenance section. */
export const PAGES_METHODS_COUNTS_PLACEHOLDER = "<!--PAGES_METHODS_COUNTS-->";
export const MAX_PAGES_GEO_INTEL_BYTES = 256 * 1024;
const MAX_PAGES_GEO_DOMAINS = 100;
const MAX_PAGES_GEO_FEATURES = 102;
const MAX_PAGES_GEO_SECTIONS = 2_000;
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
  geoIntel: PagesGeoIntelSummary;
  events: EventsArtifact;
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
    geoIntel: string;
    events: string;
  };
  publicationPolicy: {
    triplicate: "reference-citation-only";
    curationInputs: string[];
    excludedFromSnapshot: string[];
  };
}

export interface PagesGeoIntelSummary {
  available: true;
  schema: string;
  viewSchema: string;
  domainCount: number;
  hazardDomainCount: number;
  featureCount: number;
  sectionCount: number;
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
    events: number;
  };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the API-shaped, JSON-safe geo-intel artifact used by public Pages. */
export function buildPagesGeoIntel(contract: Record<string, unknown> = buildGeoIntel()): GeoIntelSurface {
  return buildGeoIntelSurface(contract);
}

/** Allow-all robots policy with an explicit sitemap pointer. */
export function buildPagesRobotsTxt(): string {
  return `User-agent: *\nAllow: /\nSitemap: ${PAGES_SITE_URL}/sitemap.xml\nFeed: ${PAGES_SITE_URL}/${PAGES_FEED_XML}\n`;
}

/**
 * Standalone static pages emitted alongside index.html. The local Bun GUI can
 * never be hosted on GitHub Pages, so gui.html is a real static read-only
 * console over the exported ./data/*.json artifacts; the other pages are
 * fully rendered views over the same snapshot data.
 */
export const PAGES_STATIC_PAGES: ReadonlyArray<{ file: string; title: string }> = [
  { file: "gui.html", title: "Civic intelligence console" },
  { file: "news.html", title: "Local news" },
  { file: "meetings.html", title: "Meetings" },
  { file: "events.html", title: "Community calendar" },
  { file: "code.html", title: "Municipal code" },
  { file: "sources.html", title: "Sources" },
];

/** Sitemap covering the canonical root plus the major anchor sections of Pages index. */
export function buildPagesSitemapXml(): string {
  const paths = ["", ...PAGES_STATIC_PAGES.map(page => page.file)];
  const today = new Date().toISOString().slice(0, 10);
  const entries = paths
    .map(path => `  <url><loc>${PAGES_SITE_URL}/${path}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function feedItemDate(item: JsonRecord): string | null {
  for (const key of ["pubDate", "date", "fetchedAt", "timestamp", "checkedAt"]) {
    const value = item[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
      return new Date(Date.parse(value)).toUTCString();
    }
  }
  return null;
}

function feedItemTitle(item: JsonRecord): string {
  for (const key of ["title", "headline", "event", "summary"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Build the public RSS 2.0 feed covering news, meetings, and current alerts.
 * Every item keeps its source link, so the syndication artifact preserves
 * provenance exactly like the published pages do. Items without a usable
 * title are dropped rather than invented.
 */
export function buildPagesFeedXml(snapshot: PagesSnapshot): string {
  const items: Array<{ title: string; link: string; description: string; date: string | null }> = [];
  for (const item of snapshot.news) {
    const title = feedItemTitle(item);
    if (!title) continue;
    items.push({
      title,
      link: typeof item.link === "string" && /^https?:\/\//i.test(item.link) ? item.link : `${PAGES_SITE_URL}/news.html`,
      description: typeof item.description === "string" ? item.description.slice(0, 500) : "",
      date: feedItemDate(item),
    });
  }
  for (const item of snapshot.meetings) {
    const title = feedItemTitle(item);
    if (!title) continue;
    items.push({
      title,
      link: typeof item.link === "string" && /^https?:\/\//i.test(item.link) ? item.link : `${PAGES_SITE_URL}/meetings.html`,
      description: typeof item.content === "string" ? item.content.slice(0, 500) : "",
      date: feedItemDate(item),
    });
  }
  for (const alert of snapshot.alerts.current) {
    const title = feedItemTitle(alert);
    if (!title) continue;
    const monitor = typeof alert.monitor === "string" ? alert.monitor : "unknown";
    items.push({
      title: `Alerts \u00b7 ${monitor}: ${title}`,
      link: `${PAGES_SITE_URL}/#alerts`,
      description: typeof alert.detail === "string" && alert.detail.trim() ? alert.detail.slice(0, 500) : `Current ${monitor} alert state`,
      date: feedItemDate(alert),
    });
  }
  items.sort((a, b) => Date.parse(b.date ?? "") - Date.parse(a.date ?? ""));
  const entries = items.slice(0, PAGES_FEED_MAX_ITEMS).map(item => {
    const dateTag = item.date ? `\n      <pubDate>${xmlEscape(item.date)}</pubDate>` : "";
    const descTag = item.description ? `\n      <description>${xmlEscape(item.description)}</description>` : "";
    return `    <item>\n      <title>${xmlEscape(item.title)}</title>\n      <link>${xmlEscape(item.link)}</link>${descTag}${dateTag}\n      <guid>${xmlEscape(item.link)}</guid>\n    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${NEWSPAPER_NAME}</title>\n    <link>${PAGES_SITE_URL}/</link>\n    <description>Local Crescent City news, government meetings, and safety alerts from the public intelligence snapshot.</description>\n    <language>en-us</language>\n    <lastBuildDate>${new Date(Date.parse(snapshot.generatedAt)).toUTCString()}</lastBuildDate>\n${entries}\n  </channel>\n</rss>\n`;
}

/** Build a per-page WebPage/CollectionPage JSON-LD block from the page manifest. */
export function buildPagesWebPageJsonLd(page: { file: string; title: string }, generatedAt: string): string {
  const block = {
    "@context": "https://schema.org",
    "@type": page.file === "events.html" ? "CollectionPage" : "WebPage",
    name: `${page.title} — ${NEWSPAPER_NAME}`,
    url: `${PAGES_SITE_URL}/${page.file}`,
    isPartOf: { "@type": "WebSite", name: NEWSPAPER_NAME, url: `${PAGES_SITE_URL}/` },
    inLanguage: "en",
    dateModified: generatedAt,
  };
  return `<script type="application/ld+json">${JSON.stringify(block)}</script>`;
}

/** Build the BreadcrumbList JSON-LD for a page (Home -> page). */
export function buildPagesBreadcrumbJsonLd(page: { file: string; title: string }): string {
  const block = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Front page", item: `${PAGES_SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: page.title, item: `${PAGES_SITE_URL}/${page.file}` },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(block)}</script>`;
}

const PAGES_DATASET_ARTIFACTS: ReadonlyArray<{ file: string; name: string; description: string }> = [
  { file: "data/snapshot.json", name: "The Quadruplicate public snapshot envelope", description: "The complete bounded public snapshot: source health, registry, news, meetings, alerts, events, and analytics overview." },
  { file: "data/source-health.json", name: "Source health records", description: "Operational state (ok/empty/unavailable/stale), check times, item counts, and provenance for every monitored public source." },
  { file: "data/source-registry.json", name: "Source registry", description: "The canonical registry of monitored, discovery-only, and reference-only public sources." },
  { file: "data/source-discovery.json", name: "Source discovery report", description: "Coverage analysis of the monitored public source registry." },
  { file: PAGES_GEO_INTEL_ARTIFACT, name: "Civic and hazard geo-intel", description: "The crescent-city-geo-intel/v1 surface covering Del Norte County hazard domains and linked code sections." },
  { file: PAGES_EVENTS_ARTIFACT, name: "Community events calendar", description: "The crescent-city-events/v1 community calendar with government meetings, community events, and closures." },
  { file: PAGES_EVENTS_ICS_ARTIFACT, name: "Community events calendar (iCalendar)", description: "The community calendar in iCalendar format for subscription in calendar applications." },
];

/** Build the Dataset JSON-LD block describing the downloadable JSON artifacts. */
export function buildPagesDatasetJsonLd(generatedAt: string): string {
  const datasets = PAGES_DATASET_ARTIFACTS.map(artifact => ({
    "@type": "Dataset",
    name: artifact.name,
    description: artifact.description,
    url: `${PAGES_SITE_URL}/${artifact.file}`,
    license: "https://opensource.org/licenses/Apache-2.0",
    creator: { "@type": "Organization", name: NEWSPAPER_NAME, url: `${PAGES_SITE_URL}/` },
    dateModified: generatedAt,
  }));
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "DataCatalog", name: `${NEWSPAPER_NAME} public data exports`, url: `${PAGES_SITE_URL}/`, dataset: datasets })}</script>`;
}

/** Replace an export-time JSON-LD marker; the marker must appear exactly once. */
export function embedPagesJsonLd(html: string, marker: string, block: string, pageLabel: string): string {
  const markerCount = html.split(marker).length - 1;
  if (markerCount !== 1) {
    throw new Error(`Pages page ${pageLabel} must contain exactly one ${marker} marker; found ${markerCount}`);
  }
  return html.replace(marker, block);
}

/** Replace the static template marker with a backend-free map from the exact view being published. */
export function embedPagesGeoView(indexHtml: string, view: GeoIntelView): string {
  const markerCount = indexHtml.split(PAGES_GEO_VIEW_PLACEHOLDER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`Pages index must contain exactly one geo-view placeholder; found ${markerCount}`);
  }
  return indexHtml.replace(PAGES_GEO_VIEW_PLACEHOLDER, buildGeoViewSvg(view));
}

/** Derive the compact geo metadata embedded in the main snapshot envelope. */
export function summarizePagesGeoIntel(value: unknown): PagesGeoIntelSummary | null {
  if (!isRecord(value) || !isRecord(value.view)) return null;
  const hazard = isRecord(value.hazard) ? value.hazard : {};
  return {
    available: true,
    schema: typeof value.schema === "string" ? value.schema : "",
    viewSchema: typeof value.view.schema === "string" ? value.view.schema : "",
    domainCount: Array.isArray(value.domains) ? value.domains.length : 0,
    hazardDomainCount: Array.isArray(hazard.relevantDomains) ? hazard.relevantDomains.length : 0,
    featureCount: Array.isArray(value.view.features) ? value.view.features.length : 0,
    sectionCount: Array.isArray(value.view.sections) ? value.view.sections.length : 0,
  };
}

/**
 * Validate the bounded, API-shaped geo-intel artifact without network or local
 * service access. The checks couple the contract and derived view so Pages
 * cannot publish a stale or structurally unrelated map surface.
 */
export function validatePagesGeoIntel(value: unknown, byteLength?: number): string[] {
  const errors: string[] = [];
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    errors.push("geo-intel artifact is not JSON-serializable");
  }
  const actualBytes = byteLength ?? new TextEncoder().encode(serialized).byteLength;
  if (actualBytes > MAX_PAGES_GEO_INTEL_BYTES) {
    errors.push(`geo-intel artifact exceeds ${MAX_PAGES_GEO_INTEL_BYTES} bytes`);
  }
  if (serialized.includes("__CC_API_KEY__") || serialized.includes("__CC_API_KEY_INJECT__") || /\"(?:api[_-]?key|authorization)\"\s*:/i.test(serialized)) {
    errors.push("geo-intel artifact contains an API-key or authorization field");
  }
  if (/localhost(?::\d+)?|127\.0\.0\.1/i.test(serialized)) {
    errors.push("geo-intel artifact references a local-only service");
  }
  if (!isRecord(value)) {
    errors.push("geo-intel artifact is not an object");
    return errors;
  }

  if (value.schema !== "crescent-city-geo-intel/v1") errors.push("geo-intel contract schema is not crescent-city-geo-intel/v1");
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) errors.push("geo-intel generatedAt is not an ISO timestamp");

  const domains = Array.isArray(value.domains) ? value.domains : [];
  if (!Array.isArray(value.domains) || domains.length === 0) errors.push("geo-intel domains are missing or empty");
  if (domains.length > MAX_PAGES_GEO_DOMAINS) errors.push(`geo-intel domains exceed ${MAX_PAGES_GEO_DOMAINS}`);
  if (value.domainCount !== domains.length) errors.push("geo-intel domainCount does not match domains");

  const anchor = isRecord(value.anchor) ? value.anchor : null;
  const bounds = anchor && isRecord(anchor.bounds) ? anchor.bounds : null;
  const latitude = anchor?.latitude;
  const longitude = anchor?.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) errors.push("geo-intel anchor latitude is invalid");
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) errors.push("geo-intel anchor longitude is invalid");
  const west = bounds?.west;
  const south = bounds?.south;
  const east = bounds?.east;
  const north = bounds?.north;
  if (
    typeof west !== "number" || typeof south !== "number" || typeof east !== "number" || typeof north !== "number" ||
    ![west, south, east, north].every(Number.isFinite) || west >= east || south >= north
  ) {
    errors.push("geo-intel anchor bounds are invalid");
  } else if (typeof latitude === "number" && typeof longitude === "number" && (longitude < west || longitude > east || latitude < south || latitude > north)) {
    errors.push("geo-intel anchor falls outside its bounds");
  }

  const hazard = isRecord(value.hazard) ? value.hazard : null;
  const relevantDomains = hazard && Array.isArray(hazard.relevantDomains) ? hazard.relevantDomains : [];
  if (!hazard || !Array.isArray(hazard.relevantDomains)) errors.push("geo-intel hazard domains are missing");
  if (hazard?.relevantDomainCount !== relevantDomains.length) errors.push("geo-intel hazard domain count is inconsistent");
  if (relevantDomains.length > domains.length) errors.push("geo-intel hazard domains exceed all domains");

  const view = isRecord(value.view) ? value.view : null;
  if (!view) {
    errors.push("geo-intel view is missing");
    return errors;
  }
  if (view.schema !== "crescent-city-geo-view/v1") errors.push("geo-intel view schema is not crescent-city-geo-view/v1");
  const crs = isRecord(view.crs) ? view.crs : null;
  const crsProperties = crs && isRecord(crs.properties) ? crs.properties : null;
  if (crsProperties?.name !== "EPSG:4326") errors.push("geo-intel view CRS is not EPSG:4326");
  if (typeof value.generatedAt === "string" && view.generatedAt !== value.generatedAt) errors.push("geo-intel view generatedAt does not match the contract");

  const viewAnchor = isRecord(view.anchor) ? view.anchor : null;
  if (!viewAnchor || viewAnchor.latitude !== latitude || viewAnchor.longitude !== longitude) errors.push("geo-intel view anchor does not match the contract");

  const features = Array.isArray(view.features) ? view.features : [];
  if (!Array.isArray(view.features)) errors.push("geo-intel view features are missing");
  if (features.length > MAX_PAGES_GEO_FEATURES) errors.push(`geo-intel view features exceed ${MAX_PAGES_GEO_FEATURES}`);
  if (features.length !== relevantDomains.length + 2) errors.push("geo-intel view feature count does not match bounds, anchor, and hazard domains");
  const featureIds = features.flatMap(feature => isRecord(feature) && typeof feature.id === "string" ? [feature.id] : []);
  if (!featureIds.includes("del-norte-bounds")) errors.push("geo-intel view is missing the Del Norte bounds feature");
  if (!featureIds.includes("city-anchor")) errors.push("geo-intel view is missing the city anchor feature");

  const viewHazard = isRecord(view.hazard) ? view.hazard : null;
  if (viewHazard?.domainCount !== relevantDomains.length) errors.push("geo-intel view hazard count does not match the contract");
  const sections = Array.isArray(view.sections) ? view.sections : [];
  if (!Array.isArray(view.sections) || sections.length === 0) errors.push("geo-intel view sections are missing or empty");
  if (sections.length > MAX_PAGES_GEO_SECTIONS) errors.push(`geo-intel view sections exceed ${MAX_PAGES_GEO_SECTIONS}`);
  return errors;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function loadPagesGeoIntel(outputDir: string, seedDir: string): Promise<GeoIntelSurface> {
  const candidates = await Promise.all([
    readJson<unknown>(join(outputDir, "geo-intel.json")),
    readJson<unknown>(join(seedDir, "geo-intel.json")),
  ]);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const surface = buildPagesGeoIntel(candidate);
    if (validatePagesGeoIntel(surface).length === 0) return surface;
  }

  // The in-repo domain surface is the final offline fallback, so Pages never
  // requires a scraper, API key, network request, or local service for geo data.
  const surface = buildPagesGeoIntel();
  const errors = validatePagesGeoIntel(surface);
  if (errors.length > 0) throw new Error(`Cannot build public geo-intel artifact: ${errors.join("; ")}`);
  return surface;
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

/**
 * Shared HTML escape helper for build-time injected markup. Escapes &, <, >,
 * ", and ' so interpolated values are safe in text and attribute contexts.
 */
export function escapePagesHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

/**
 * Render the manifest-derived counts shown in the Methods & Provenance section.
 * Counts come from the exact snapshot being exported, so the static page never
 * carries hand-authored numbers that could drift from data/snapshot.json.
 */
export function buildPagesMethodsCounts(snapshot: PagesSnapshot): string {
  const items: Array<[string, unknown]> = [
    ["Snapshot schema version", snapshot.schemaVersion],
    ["Generated", snapshot.generatedAt],
    ["Export status", snapshot.status],
    ["Source-health records", snapshot.sourceHealth.length],
    ["Discovered sources", snapshot.sourceRegistry.length],
    ["News items", snapshot.news.length],
    ["Meeting items", snapshot.meetings.length],
    ["YouTube records", snapshot.youtube.length],
    ["Curated briefs", snapshot.curated.length],
    ["Calendar events", snapshot.events.count ?? snapshot.events.events.length],
  ];
  return `<ul id="methods-counts-list">${items.map(([label, value]) => `<li><strong>${escapePagesHtml(label)}:</strong> ${escapePagesHtml(value ?? "not recorded")}</li>`).join("")}</ul>`;
}

/** Replace the export-time counts marker with manifest-derived values. */
export function embedPagesMethodsCounts(indexHtml: string, counts: string): string {
  const markerCount = indexHtml.split(PAGES_METHODS_COUNTS_PLACEHOLDER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`Pages index must contain exactly one methods-counts placeholder; found ${markerCount}`);
  }
  return indexHtml.replace(PAGES_METHODS_COUNTS_PLACEHOLDER, counts);
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
  const geoIntel = await loadPagesGeoIntel(resolvedOutput, resolvedSeed);
  const geoIntelSummary = summarizePagesGeoIntel(geoIntel);
  const persistedEvents = await readFirstJson<EventsArtifact>("events/events.json");
  const events: EventsArtifact =
    persistedEvents?.schemaVersion === "crescent-city-events/v1" && Array.isArray(persistedEvents.events)
      ? persistedEvents
      : buildEventsArtifact(generatedAt, await collectEvents(resolvedOutput));
  if (!geoIntelSummary) throw new Error("Cannot summarize public geo-intel artifact");

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
    geoIntel: geoIntelSummary,
    events,
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
      geoIntel: PAGES_GEO_INTEL_ARTIFACT,
      events: PAGES_EVENTS_ARTIFACT,
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
  const sourceRoot = resolve(options.outputDir ?? "output");
  const seedRoot = resolve(seedDir);
  const snapshot = await buildPagesSnapshot(sourceRoot, generatedAt, seedRoot);
  const geoIntel = await loadPagesGeoIntel(sourceRoot, seedRoot);
  const temporary = await mkdtemp(join(dirname(destination), ".pages-build-"));
  const files: string[] = [];
  try {
    const editionDate = generatedAt.slice(0, 10);
    const indexTemplate = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    const indexHtmlFinal = embedPagesMethodsCounts(embedPagesGeoView(indexTemplate, geoIntel.view), buildPagesMethodsCounts(snapshot))
      .replace(PAGES_DATE_PUBLISHED_PLACEHOLDER, editionDate)
      .replace(PAGES_DATE_MODIFIED_PLACEHOLDER, editionDate);
    if (indexHtmlFinal.includes(PAGES_DATE_PUBLISHED_PLACEHOLDER) || indexHtmlFinal.includes(PAGES_DATE_MODIFIED_PLACEHOLDER)) {
      throw new Error("Pages index JSON-LD date placeholders were not replaced");
    }
    await writeFile(join(temporary, "index.html"), indexHtmlFinal, "utf8");
    await copyIfPresent(join(STATIC_DIR, "404.html"), join(temporary, "404.html"));
    for (const page of PAGES_STATIC_PAGES) {
      if (!(await copyIfPresent(join(STATIC_DIR, page.file), join(temporary, page.file)))) {
        throw new Error(`Pages static page is missing from ${STATIC_DIR}: ${page.file}`);
      }
      const pagePath = join(temporary, page.file);
      const pageHtml = await readFile(pagePath, "utf8");
      // Per-page SEO: syndication link, WebPage/CollectionPage, BreadcrumbList,
      // and Dataset JSON-LD injected at export time from the page manifest.
      const hydrated = pageHtml
        .replace("</head>", `${PAGES_FEED_LINK_HTML}\n${buildPagesWebPageJsonLd(page, generatedAt)}\n${buildPagesBreadcrumbJsonLd(page)}\n${buildPagesDatasetJsonLd(generatedAt)}\n</head>`)
        .replace(PAGES_JSONLD_WEBPAGE_PLACEHOLDER, "")
        .replace(PAGES_JSONLD_BREADCRUMB_PLACEHOLDER, "")
        .replace(PAGES_JSONLD_DATASET_PLACEHOLDER, "");
      if (hydrated.includes("PAGES_JSONLD")) throw new Error(`Pages page JSON-LD markers were not replaced: ${page.file}`);
      await writeFile(pagePath, hydrated, "utf8");
      files[files.length] = page.file;
    }
    await writeFile(join(temporary, ".nojekyll"), "\n", "utf8");
    files.push("index.html", "404.html", ".nojekyll");
    await writeFile(join(temporary, PAGES_ROBOTS_TXT), buildPagesRobotsTxt(), "utf8");
    await writeFile(join(temporary, PAGES_SITEMAP_XML), buildPagesSitemapXml(), "utf8");
    await writeFile(join(temporary, PAGES_FEED_XML), buildPagesFeedXml(snapshot), "utf8");
    files[files.length] = PAGES_ROBOTS_TXT;
    files[files.length] = PAGES_SITEMAP_XML;
    files[files.length] = PAGES_FEED_XML;

    await writeJson(join(temporary, "data/snapshot.json"), snapshot);
    await writeJson(join(temporary, "data/source-health.json"), snapshot.sourceHealth);
    await writeJson(join(temporary, "data/source-registry.json"), snapshot.sourceRegistry);
    await writeJson(join(temporary, "data/source-discovery.json"), snapshot.sourceDiscovery);
    await writeJson(join(temporary, PAGES_GEO_INTEL_ARTIFACT), geoIntel);
    await writeJson(join(temporary, PAGES_EVENTS_ARTIFACT), snapshot.events);
    await writeFile(join(temporary, PAGES_EVENTS_ICS_ARTIFACT), buildEventsIcs(snapshot.events?.events ?? []), "utf8");
    files.push("data/snapshot.json", "data/source-health.json", "data/source-registry.json", "data/source-discovery.json", PAGES_GEO_INTEL_ARTIFACT, PAGES_EVENTS_ARTIFACT, PAGES_EVENTS_ICS_ARTIFACT);

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
        events: snapshot.events.count ?? snapshot.events.events.length,
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
  if (!indexHtml.includes(PAGES_GEO_INTEL_ARTIFACT)) errors.push("Pages index does not expose geo-intel data");
  if (!indexHtml.includes('id="geo"')) errors.push("Pages index does not expose the hazard geo-view section");
  if (!indexHtml.includes('id="geo-map"')) errors.push("Pages index does not expose the geo-view map container");
  if (!indexHtml.includes(PAGES_GEO_VIEW_PLACEHOLDER) && !indexHtml.includes('data-geo-view-schema="crescent-city-geo-view/v1"')) {
    errors.push("Pages index does not embed the geo-view SVG");
  }
  if (!indexHtml.includes("sourceRegistry")) errors.push("Pages index does not render the source registry");
  if (!indexHtml.includes('id="refresh"')) errors.push("Pages index does not expose a refresh control");
  if (!indexHtml.includes("snapshot.healthSummary")) errors.push("Pages index does not render aggregate health metadata");
  if (!indexHtml.includes("snapshot.analytics")) errors.push("Pages index does not render the shared analytics overview");
  // Nav links now point at the dedicated standalone pages (real URLs on
  // Pages); the anchor sections remain on the front page itself.
  if (!indexHtml.includes('<a href="events.html"')) errors.push("Pages index does not expose an Events nav link");
  if (!indexHtml.includes('id="events"')) errors.push("Pages index does not expose the events section");
  if (!indexHtml.includes('id="event-items"')) errors.push("Pages index does not expose the event items container");
  if (!indexHtml.includes('id="event-filter"')) errors.push("Pages index does not expose the event filter control");
  if (!indexHtml.includes(PAGES_EVENTS_ARTIFACT)) errors.push("Pages index does not expose the events JSON artifact");
  if (!indexHtml.includes("renderEvents")) errors.push("Pages index does not render structured events");
  if (!indexHtml.includes("CrescentCity@tuta.com")) errors.push("Pages index is missing the contact email");
  if (!indexHtml.includes("Sea Something")) errors.push("Pages index is missing the 'Sea Something. Say Something.' tagline");
  if (!indexHtml.includes('id="methods"')) errors.push("Pages index does not expose the Methods & Provenance section");
  if (!indexHtml.includes('id="faq"')) errors.push("Pages index does not expose the FAQ section");
  if (!indexHtml.includes("FAQPage")) errors.push("Pages index does not include FAQPage structured data");
  const styleMatch = indexHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (styleMatch && styleMatch[1]) {
    const styleContent = styleMatch[1];
    const brightColors = ["--red", "--blue", "--gold", "--green", "--purple"];
    const found = brightColors.filter(c => styleContent.includes(c));
    if (found.length > 0) {
      errors.push("Pages index style block contains bright color CSS variables (grayscale aesthetic required): " + found.join(", "));
    }
  }
  return errors;
}

export async function writePagesSnapshotManifest(path: string, result: PagesExportResult): Promise<void> {
  await writeJsonAtomic(path, result);
}

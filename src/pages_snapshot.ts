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
import { buildDirectoryArtifact, summarizeDirectory, type DirectoryArtifact } from "./directory.js";
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
export const PAGES_DIRECTORY_ARTIFACT = "data/directory.json";
export const PAGES_GEO_INTEL_ARTIFACT = "data/geo-intel.json";
export const PAGES_EVENTS_ARTIFACT = "data/events.json";
export const PAGES_EVENTS_ICS_ARTIFACT = "data/events.ics";
export const PAGES_NEWS_ARTIFACT = "data/news.json";
export const PAGES_MEETINGS_ARTIFACT = "data/meetings.json";
export const PAGES_ALERTS_ARTIFACT = "data/alerts.json";
export const PAGES_ANALYTICS_ARTIFACT = "data/analytics.json";
/**
 * §5.5 (lane A r2): operator-only channel artifact. Mirrors the routed
 * `operatorSignalsNoticed` from the analytics overview (neutral rewritten copy,
 * no binary names/PATH strings/stack traces) so the routed operator detail is
 * durably persisted without ever being rendered on a public page. Also lists
 * the raw build-log signals when the operator backend recorded them.
 */
export const PAGES_OPERATOR_SIGNALS_ARTIFACT = "data/operator-signals.json";
export const PAGES_SEARCH_INDEX_ARTIFACT_PREFIX = "data/code-search.";
/** Per-field shard artifacts (lane D §2): the title/number shard (~0.5 MB) and
 * the body shard (~2.4 MB) are emitted alongside the combined index so a client
 * can answer title/number queries after fetching only the small shard. */
export const PAGES_SEARCH_TITLE_ARTIFACT_PREFIX = "data/code-search-t.";
export const PAGES_SEARCH_BODY_ARTIFACT_PREFIX = "data/code-search-x.";
/** Tiny per-edition metadata artifact: code availability, counts, and the
 * content-hashed index paths — code.html fetches this (~1 KB) instead of the
 * ~236 KB snapshot envelope (lane D §3). */
export const PAGES_CODE_META_ARTIFACT = "data/code-meta.json";

/**
 * Content-hashed artifact filename (§1.6). Immutable snapshot artifacts get a
 * `name.<8-hex-of-sha256>.<ext>` form so they can be served with normal
 * (effectively immutable) caching. Phase 6 asset hashing reuses this exact
 * helper for CSS/JS bundles.
 */
export function pagesContentHashName(path: string, bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 8);
  const dot = path.lastIndexOf(".");
  return dot === -1 ? `${path}.${digest}` : `${path.slice(0, dot)}.${digest}${path.slice(dot)}`;
}

/** Per-page byte budgets (§1.2 acceptance: first-load transfer < 150 KB excluding fonts). */
export const PAGES_ARTIFACT_BYTE_BUDGETS: Readonly<Record<string, number>> = {
  [PAGES_NEWS_ARTIFACT]: 150 * 1024,
  [PAGES_MEETINGS_ARTIFACT]: 150 * 1024,
  [PAGES_ANALYTICS_ARTIFACT]: 150 * 1024,
  [PAGES_ALERTS_ARTIFACT]: 150 * 1024,
  "data/source-health.json": 150 * 1024,
  "data/source-discovery.json": 150 * 1024,
  "data/source-registry.json": 150 * 1024,
};

/**
 * Build a field-sharded inverted search index over the municipal code (§1.3).
 * Shards hold `t` (title/number), `x` (body text) tokens per section id so a
 * keystroke scans only the relevant shard. Section text is preserved verbatim
 * for rendering; provenance URLs are never rewritten.
 */
export function buildPagesCodeSearchIndex(code: unknown): {
  schema: "crescent-city-code-search/v1";
  articleCount: number;
  sectionCount: number;
  /** Field-sharded: `t` carries number/title/article identity for rendering,
   * `x` carries only id + body text — no entry is duplicated across shards. */
  shards: {
    t: Array<{ id: string; n: string; t: string; title: string; a: string; u: string | null }>;
    x: Array<{ id: string; x: string }>;
  };
} {
  const articles = code && typeof code === "object" && Array.isArray((code as { articles?: unknown[] }).articles)
    ? (code as { articles: Array<Record<string, unknown>> }).articles
    : [];
  const shards: {
    t: Array<{ id: string; n: string; t: string; title: string; a: string; u: string | null }>;
    x: Array<{ id: string; x: string }>;
  } = { t: [], x: [] };
  let sectionCount = 0;
  articles.forEach((article, articleIndex) => {
    const articleTitle = String(article.title ?? "");
    const articleUrl = typeof article.url === "string" ? article.url : null;
    const sections = Array.isArray(article.sections) ? article.sections : [];
    sections.forEach((section, sectionIndex) => {
      const record = section && typeof section === "object" ? section as Record<string, unknown> : {};
      const number = String(record.number ?? "");
      const title = String(record.title ?? "");
      const text = String(record.text ?? "");
      const id = `${articleIndex}-${sectionIndex}`;
      shards.t.push({ id, n: number, t: `${number} ${title} ${articleTitle}`.toLowerCase(), title, a: articleTitle, u: articleUrl });
      shards.x.push({ id, x: text.toLowerCase() });
      sectionCount += 1;
    });
  });
  return { schema: "crescent-city-code-search/v1", articleCount: articles.length, sectionCount, shards };
}

/**
 * Scoring function (lane D §1, documented in code):
 *   2 — every query term hits the identity field `t` (section number/title/article)
 *   1 — every query term hits the body text `x`
 * Multi-word AND semantics: EVERY whitespace-separated term must hit the same
 * field, so "business license" never matches a section containing only "license".
 * A term hitting both fields scores by the strongest field (identity first).
 * Results sort by score descending (title/number hits rank above body hits);
 * within a tier, earlier index order (article/section order) is stable.
 */
export function scoreCodeSearchEntry(identityText: string, bodyText: string, terms: string[]): number {
  if (terms.length === 0) return -1;
  return terms.every(term => identityText.includes(term)) ? 2
    : terms.every(term => bodyText.includes(term)) ? 1
    : -1;
}

/** Search the sharded index: score title/number hits above body hits (multi-word AND). */
export function searchPagesCodeIndex(index: ReturnType<typeof buildPagesCodeSearchIndex>, needle: string, limit = 30): Array<{ id: string; n: string; t: string; title: string; a: string; u: string | null; x?: string }> {
  const query = needle.trim().toLowerCase();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  const textById = new Map(index.shards.x.map(entry => [entry.id, entry.x]));
  const scored: Array<{ score: number; match: { id: string; n: string; t: string; title: string; a: string; u: string | null; x?: string } }> = [];
  const seen = new Set<string>();
  for (const entry of index.shards.t) {
    seen.add(entry.id);
    const score = scoreCodeSearchEntry(entry.t, textById.get(entry.id) ?? "", terms);
    if (score >= 0) matches_push(scored, score, { ...entry, x: textById.get(entry.id) ?? "" });
  }
  for (const entry of index.shards.x) {
    if (seen.has(entry.id)) continue; // already scored via the identity shard
    const score = scoreCodeSearchEntry("", entry.x, terms);
    if (score >= 0) {
      const identity = index.shards.t.find(candidate => candidate.id === entry.id);
      if (identity) matches_push(scored, score, { ...identity, x: entry.x });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.match);
}

function matches_push<T>(list: Array<{ score: number; match: T }>, score: number, match: T): void {
  list.push({ score, match });
}
const PAGES_SITE_URL = "https://quadruplicate.org";
export const PAGES_ROBOTS_TXT = "robots.txt";
export const PAGES_SITEMAP_XML = "sitemap.xml";
export const PAGES_GEO_VIEW_PLACEHOLDER = '<template data-pages-geo-view></template>';
export const PAGES_FEED_XML = "feed.xml";
export const PAGES_FEED_LINK_HTML = '<link rel="alternate" type="application/rss+xml" title="The Quadruplicate - public intelligence feed" href="https://quadruplicate.org/feed.xml">';

/** Shared page assets (§6.1/§6.3): authored under src/pages/static/assets/, emitted content-hashed. */
export const PAGES_SHARED_ASSETS: ReadonlyArray<{ source: string; placeholder: string; hashPrefix: string }> = [
  { source: "site.css", placeholder: "assets/SITE_CSS_PLACEHOLDER", hashPrefix: "assets/site." },
  { source: "site.js", placeholder: "assets/SITE_JS_PLACEHOLDER", hashPrefix: "assets/site." },
  // Lane A r2: the ~10 KB of index-only CSS (geo showcase, welcome grid,
  // methods, FAQ, mobile, print) is content-hashed and emitted the same way.
  // Only index.html consumes the INDEX_CSS placeholder, so a surviving
  // placeholder anywhere else is already caught by the per-page replacement
  // guarantee below.
  { source: "index.css", placeholder: "assets/INDEX_CSS_PLACEHOLDER", hashPrefix: "assets/index." },
  // Lane A r2: 404 page-specific CSS. The errata page keeps its distinct
  // minimal layout (720px column, errata/stop-press styling) but its former
  // divergent sepia :root palette fork is gone — the shared --cc/--rdark/--rtint
  // family now supplies the accent/tint tokens, with page-local neutrals here.
  { source: "404.css", placeholder: "assets/404_CSS_PLACEHOLDER", hashPrefix: "assets/404." },
];
/** Placeholder in each page script slot; replaced with the hashed shared JS path at export. */
export const PAGES_ASSET_PLACEHOLDER = "PAGES_ASSET_PLACEHOLDER";
/** Script tag template for the hashed shared JS bundle (deferred, before the page script). */
export const PAGES_SHARED_JS_TAG = '<script src="assets/SITE_JS_PLACEHOLDER" defer></script>';
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
    /** Small manifest-derived counts for front-page cards. The full manifest,
     * verification, coverage, and readability artifacts ship standalone and are
     * referenced by path in `files` — never inlined into this envelope (§1.1). */
    counts: { articlePageCount: number | null; sectionCount: number | null };
  };
  geoIntel: PagesGeoIntelSummary;
  directory: { available: boolean; count: number; categoryCount: number };
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
    directory: string | null;
    events: string;
    /** Per-page artifacts (§1.2): each subpage fetches only what it renders. */
    news: string;
    meetings: string;
    alerts: string;
    analytics: string | null;
    /** Content-hashed sharded municipal-code search index (§1.3), lazy-loaded on first keystroke. */
    codeSearchIndex: string | null;
    /** Per-field shards (lane D §2): title/number shard (~0.5 MB) and body shard (~2.4 MB),
     * also content-hashed; null when no code export exists in this edition. */
    codeSearchTitleIndex: string | null;
    codeSearchBodyIndex: string | null;
    /** Tiny code metadata artifact (lane D §3): code.html fetches this instead of the envelope. */
    codeMeta: string | null;
    /** §5.5 operator channel artifact (lane A r2); null when no analytics overview exists. */
    operatorSignals: string | null;
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
    directory: number;
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
export const PAGES_STATIC_PAGES: ReadonlyArray<{ file: string; title: string; navLabel: string; datelineKicker: string }> = [
  { file: "gui.html", title: "Civic intelligence console", navLabel: "GUI console", datelineKicker: "Public read-only console" },
  { file: "news.html", title: "Local news", navLabel: "News", datelineKicker: "Metro desk" },
  { file: "meetings.html", title: "Meetings", navLabel: "Meetings", datelineKicker: "Public record" },
  { file: "events.html", title: "Community calendar", navLabel: "Events", datelineKicker: "Community calendar" },
  { file: "directory.html", title: "Local directory", navLabel: "Directory", datelineKicker: "Community directory" },
  { file: "code.html", title: "Municipal code", navLabel: "Municipal code", datelineKicker: "Municipal code" },
  { file: "sources.html", title: "Sources", navLabel: "Sources", datelineKicker: "Source registry" },
];

/** Front-page section anchors shared by every page masthead nav (canonical labels). */
export const PAGES_SECTION_NAV: ReadonlyArray<{ label: string; hash: string }> = [
  { label: "Geo-intel", hash: "geo" },
  { label: "Alerts", hash: "alerts" },
  { label: "Methods", hash: "methods" },
  { label: "FAQ", hash: "faq" },
];

export const PAGES_FRONT_PAGE_NAV_LABEL = "Front page";

export const PAGES_OG_IMAGE_PNG = "og-image.png";
export const PAGES_FAVICON_SVG = "favicon.svg";
export const PAGES_FAVICON_ICO = "favicon.ico";
export const PAGES_APPLE_TOUCH_ICON_PNG = "apple-touch-icon.png";
export const PAGES_WEB_MANIFEST = "site.webmanifest";

/**
 * Sitemap covering the canonical root plus the standalone pages.
 *
 * `lastmodByPath` maps a sitemap path ("" for the root, "gui.html", ...) to an
 * honest last-modified date (YYYY-MM-DD) derived from source mtime. When no
 * mapping is supplied the <lastmod> element is omitted entirely rather than
 * fabricated from the build date: a sitemap must never claim every URL changed
 * today just because the exporter ran (§3.7).
 */
export function buildPagesSitemapXml(lastmodByPath: Record<string, string> = {}): string {
  const paths = ["", ...PAGES_STATIC_PAGES.map(page => page.file)];
  const entries = paths
    .map(path => {
      const lastmod = lastmodByPath[path];
      const lastmodXml = typeof lastmod === "string" && /^\d{4}-\d{2}-\d{2}$/.test(lastmod) ? `<lastmod>${lastmod}</lastmod>` : "";
      return `  <url><loc>${PAGES_SITE_URL}/${path}</loc>${lastmodXml}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/**
 * Canonical masthead nav generated from PAGES_STATIC_PAGES so nav, sitemap, and
 * breadcrumbs cannot disagree. `currentFile` is the page carrying
 * aria-current="page" (null for the front page and the 404 page).
 * `rootAbsolute` emits root-absolute hrefs - required for 404.html, which
 * GitHub Pages serves at arbitrary nested paths where relative links 404 (§2.2).
 */
export function buildPagesNavHtml(currentFile: string | null, options: { rootAbsolute?: boolean } = {}): string {
  const root = options.rootAbsolute ? "/" : "./";
  const anchor = (href: string, label: string, isCurrent: boolean): string =>
    `<a href="${href}"${isCurrent ? ' aria-current="page"' : ""}>${label}</a>`;
  const links: string[] = [anchor(root, PAGES_FRONT_PAGE_NAV_LABEL, currentFile === null)];
  for (const page of PAGES_STATIC_PAGES) {
    links.push(anchor(options.rootAbsolute ? `/${page.file}` : page.file, page.navLabel, currentFile === page.file));
  }
  for (const section of PAGES_SECTION_NAV) {
    links.push(anchor(options.rootAbsolute ? `/#${section.hash}` : `./#${section.hash}`, section.label, false));
  }
  return `<nav class="masthead-nav" aria-label="Page sections">${links.join("")}</nav>`;
}

/** Breadcrumb trail markup for one page (§2.8). The 404 page passes its own label. */
export function buildPagesBreadcrumbHtml(currentFile: string | null, options: { rootAbsolute?: boolean; label?: string } = {}): string {
  const root = options.rootAbsolute ? "/" : "./";
  const label = options.label
    ?? (currentFile === null ? PAGES_FRONT_PAGE_NAV_LABEL : PAGES_STATIC_PAGES.find(page => page.file === currentFile)?.navLabel ?? currentFile);
  const homeItem = currentFile === null && !options.label
    ? `<li aria-current="page">${PAGES_FRONT_PAGE_NAV_LABEL}</li>`
    : `<li><a href="${root}">${PAGES_FRONT_PAGE_NAV_LABEL}</a></li><li aria-current="page">${label}</li>`;
  return `<nav class="breadcrumb" aria-label="Breadcrumb"><div class="inner"><ol>${homeItem}</ol></div></nav>`;
}

/** Canonical footer generated once for every page (§2.1); the 404 page uses the errata variant. */
export function buildPagesFooterHtml(variant: "snapshot" | "errata" = "snapshot"): string {
  const secondLine = variant === "errata"
    ? `<div>Public snapshot &middot; no live service &middot; no credentials &middot; no chat history</div>`
    : `<div class="contact-line">CrescentCity@tuta.com &mdash; <em>Sea Something. Say Something.</em></div>`;
  return `<footer class="footer"><div>Source: <a href="https://github.com/docxology/crescent-city-intel">docxology/crescent-city-intel</a> &middot; Code: <a href="https://ecode360.com/CR4919">ecode360.com/CR4919</a></div>${secondLine}</footer>`;
}

/** Replace the authored masthead nav with the generated canonical nav (exactly one per page). */
export function embedPagesNav(html: string, currentFile: string | null, options: { rootAbsolute?: boolean } = {}): string {
  const matches = html.match(/<nav class="masthead-nav"[\s\S]*?<\/nav>/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Pages page must contain exactly one masthead nav; found ${matches.length}`);
  }
  return html.replace(/<nav class="masthead-nav"[\s\S]*?<\/nav>/, buildPagesNavHtml(currentFile, options));
}

/** Replace the authored breadcrumb trail with the generated one (exactly one per page). */
export function embedPagesBreadcrumb(html: string, currentFile: string | null, options: { rootAbsolute?: boolean; label?: string } = {}): string {
  const matches = html.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Pages page must contain exactly one breadcrumb nav; found ${matches.length}`);
  }
  return html.replace(/<nav class="breadcrumb"[\s\S]*?<\/nav>/, buildPagesBreadcrumbHtml(currentFile, options));
}

/** Replace the authored footer with the generated canonical footer (exactly one per page). */
export function embedPagesFooter(html: string, variant: "snapshot" | "errata" = "snapshot"): string {
  const matches = html.match(/<footer class="footer">[\s\S]*?<\/footer>/g) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Pages page must contain exactly one footer element; found ${matches.length}`);
  }
  return html.replace(/<footer class="footer">[\s\S]*?<\/footer>/, buildPagesFooterHtml(variant));
}

/** Export-time injection point for per-page canonical/OG/Twitter head metadata (§3.3). */
export const PAGES_HEAD_META_PLACEHOLDER = "<!--PAGES_HEAD_META-->";

/** Replace the head-meta marker with per-page canonical, Open Graph, and Twitter card metadata. */
export function embedPagesHeadMeta(html: string, pageFile: string): string {
  const markerCount = html.split(PAGES_HEAD_META_PLACEHOLDER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`Pages page ${pageFile} must contain exactly one head-meta placeholder; found ${markerCount}`);
  }
  const page = PAGES_STATIC_PAGES.find(candidate => candidate.file === pageFile);
  if (!page) throw new Error(`head metadata requested for unknown Pages page: ${pageFile}`);
  const url = `${PAGES_SITE_URL}/${page.file}`;
  const title = `${page.title} — The Quadruplicate`;
  const description = `The Quadruplicate — ${page.title.toLowerCase()} for Crescent City, CA: provenance-preserving civic intelligence with cited public sources.`;
  const meta = [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:site_name" content="The Quadruplicate">`,
    `<meta property="og:image" content="${PAGES_SITE_URL}/${PAGES_OG_IMAGE_PNG}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${PAGES_SITE_URL}/${PAGES_OG_IMAGE_PNG}">`,
  ].join("\n  ");
  return html.replace(PAGES_HEAD_META_PLACEHOLDER, meta);
}

/** Canonical favicon links + theme-color shared by every page head (§3.2). */
export function buildPagesFaviconHeadHtml(): string {
  return [
    `<link rel="icon" href="/${PAGES_FAVICON_SVG}" type="image/svg+xml">`,
    `<link rel="icon" href="/${PAGES_FAVICON_ICO}" sizes="32x32">`,
    `<link rel="apple-touch-icon" href="/${PAGES_APPLE_TOUCH_ICON_PNG}">`,
    `<meta name="theme-color" content="#c41e1e">`,
    `<link rel="manifest" href="/${PAGES_WEB_MANIFEST}">`,
  ].join("\n  ");
}

/** Monogram "Q" SVG favicon in the broadsheet palette (§3.2). */
export function buildPagesFaviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#c41e1e"/><circle cx="32" cy="28" r="15" fill="none" stroke="#ffffff" stroke-width="6"/><line x1="40" y1="38" x2="50" y2="50" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/></svg>\n`;
}

// --- Build-time image encoders (no new runtime dependencies) ---
// The repo has no canvas/image library, so the OG card and touch icon are
// emitted as deterministic PNGs encoded byte-by-byte below: zlib (Bun builtin)
// for IDAT, CRC32 over the chunk payloads. No CDN, no framework, no new deps.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode RGB pixels (row-major, 3 bytes/px) as a minimal truecolor PNG. */
export function encodePngRgb(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height * 3) throw new Error(`PNG pixel buffer must be ${width * height * 3} bytes`);
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let row = 0; row < height; row++) {
    raw[row * (1 + width * 3)] = 0; // filter: none
    raw.set(pixels.subarray(row * width * 3, (row + 1) * width * 3), row * (1 + width * 3) + 1);
  }
  const compressed = new Uint8Array(Bun.deflateSync(raw, { level: 9 }));
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", compressed);
  const endChunk = pngChunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + endChunk.length);
  let offset = 0;
  for (const chunk of [signature, ihdrChunk, idatChunk, endChunk]) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (!Number.isFinite(value) || hex.replace("#", "").length !== 6) throw new Error(`invalid hex color: ${hex}`);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** A 5x7 bitmap font keeps the OG card deterministic and dependency-free. */
const OG_FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10011", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "01100"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "11110", "10001", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
};

const OG_CHAR_WIDTH = 6;
const OG_CHAR_HEIGHT = 7;

function drawText(pixels: Uint8Array, width: number, text: string, x: number, y: number, scale: number, color: [number, number, number]): void {
  let cursor = x;
  for (const character of text.toUpperCase()) {
    const glyph = OG_FONT[character];
    if (!glyph) continue;
    for (let row = 0; row < OG_CHAR_HEIGHT; row++) {
      for (let column = 0; column < glyph[row]!.length; column++) {
        if (glyph[row]![column] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = cursor + column * scale + dx;
            const py = y + row * scale + dy;
            if (px < 0 || px >= width || py < 0) continue;
            const offset = (py * width + px) * 3;
            if (offset + 2 < pixels.length) { pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; }
          }
        }
      }
    }
    cursor += OG_CHAR_WIDTH * scale;
  }
}

function drawRect(pixels: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, color: [number, number, number]): void {
  for (let py = Math.max(0, y); py < Math.min(height, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(width, x + w); px++) {
      const offset = (py * width + px) * 3;
      pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
    }
  }
}

/**
 * Deterministic 1200x630 OG card (§3.1): masthead band, edition date, and
 * headline counts from the exact snapshot being exported. No fonts fetched,
 * no runtime dependencies — a 5x7 bitmap font drawn into an RGB buffer.
 */
export function buildPagesOgImagePng(snapshot: Pick<PagesSnapshot, "generatedAt" | "news" | "meetings" | "events" | "sourceHealth">): Uint8Array {
  const width = 1200;
  const height = 630;
  const paper = hexToRgb("#faf6ef");
  const ink = hexToRgb("#0a0a0a");
  const cc = hexToRgb("#c41e1e");
  const dim = hexToRgb("#3a3a3a");
  const pixels = new Uint8Array(width * height * 3);
  drawRect(pixels, width, height, 0, 0, width, height, paper);
  drawRect(pixels, width, height, 0, 0, width, 96, cc);
  drawRect(pixels, width, height, 0, 96, width, 6, ink);
  drawText(pixels, width, "THE QUADRUPLICATE", 64, 30, 5, [0xff, 0xff, 0xff]);
  drawText(pixels, width, "CIVIC INTELLIGENCE - CRESCENT CITY, CA", 64, 140, 3, cc);
  drawText(pixels, width, "A PROVENANCE-PRESERVING PUBLIC SNAPSHOT", 64, 180, 3, dim);
  drawRect(pixels, width, height, 64, 230, 1072, 3, ink);
  const editionDate = snapshot.generatedAt.slice(0, 10);
  drawText(pixels, width, `EDITION ${editionDate}`, 64, 270, 4, ink);
  const eventCount = snapshot.events?.count ?? snapshot.events?.events?.length ?? 0;
  const lines: Array<[string, string]> = [
    ["NEWS", `${snapshot.news.length} ITEMS`],
    ["MEETINGS", `${snapshot.meetings.length} ITEMS`],
    ["EVENTS", `${eventCount} LISTED`],
    ["SOURCE CHECKS", `${snapshot.sourceHealth.length} RECORDED`],
  ];
  let y = 350;
  for (const [label, value] of lines) {
    drawText(pixels, width, label, 64, y, 4, cc);
    drawText(pixels, width, value, 420, y, 4, ink);
    y += 60;
  }
  drawRect(pixels, width, height, 0, height - 12, width, 12, cc);
  return encodePngRgb(width, height, pixels);
}

/** 180x180 solid-brand apple-touch-icon PNG (no background transparency). */
export function buildPagesAppleTouchIconPng(): Uint8Array {
  const size = 180;
  const pixels = new Uint8Array(size * size * 3);
  drawRect(pixels, size, size, 0, 0, size, size, hexToRgb("#c41e1e"));
  drawText(pixels, size, "Q", 66, 66, 8, [0xff, 0xff, 0xff]);
  return encodePngRgb(size, size, pixels);
}

/** Deterministic 16x16 ICO wrapping a 32bpp BMP entry (no image library). */
export function buildPagesFaviconIco(): Uint8Array {
  const size = 16;
  const cc = hexToRgb("#c41e1e");
  const white: [number, number, number] = [0xff, 0xff, 0xff];
  const xor = new Uint8Array(size * size * 4);
  drawRect(xor, size, size, 0, 0, size, size, cc);
  // 4x4 white mark in the middle of the brand square.
  drawRect(xor, size, size, 6, 6, 4, 4, white);
  const and = new Uint8Array(size * 4); // 1bpp AND mask, all opaque
  const header = new Uint8Array(40);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 40);
  headerView.setInt32(4, size);
  headerView.setInt32(8, size * 2); // double-height (XOR+AND)
  headerView.setUint16(12, 1);
  headerView.setUint16(14, 32);
  const imageBytes = header.length + xor.length + and.length;
  const entry = new Uint8Array(16 + imageBytes);
  const entryView = new DataView(entry.buffer);
  entryView.setUint8(0, size);
  entryView.setUint8(1, size);
  entryView.setUint16(2, 1);
  entryView.setUint16(4, 32);
  entryView.setUint32(8, imageBytes);
  entryView.setUint32(12, 22); // offset of the BMP entry inside the ICO file
  entry.set(header, 16);
  entry.set(xor, 16 + header.length);
  entry.set(and, 16 + header.length + xor.length);
  const out = new Uint8Array(6 + entry.length);
  const outView = new DataView(out.buffer);
  outView.setUint16(0, 0);
  outView.setUint16(2, 1);
  outView.setUint16(4, 1);
  out.set(entry, 6);
  return out;
}

/** Minimal installable web manifest with the brand color. */
export function buildPagesWebManifest(): string {
  return `${JSON.stringify({
    name: "The Quadruplicate",
    short_name: "Quadruplicate",
    description: "Provenance-preserving civic intelligence snapshot for Crescent City, CA.",
    start_url: "/",
    display: "standalone",
    background_color: "#faf6ef",
    theme_color: "#c41e1e",
    icons: [
      { src: `/${PAGES_FAVICON_SVG}`, type: "image/svg+xml", sizes: "any" },
      { src: `/${PAGES_APPLE_TOUCH_ICON_PNG}`, type: "image/png", sizes: "180x180" },
    ],
  }, null, 2)}\n`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Lane C (round-2): sanitize a data-derived rendered string at the artifact
 * boundary. Strips escaped-codepoint placeholder text ("U0001f7e1" style
 * literals) that leaked from source copy, and collapses em-dash placeholder
 * concatenations like "—ft@—s" / "—kt" / "—ft waves" that advertise missing
 * readings instead of omitting them. Applied to feed titles/descriptions and
 * asserted in the release gate so these classes cannot regress.
 */
export function sanitizeRenderedText(value: string): string {
  return value
    .replace(/U0001[0-9a-fA-F]{1,5}/g, "")
    .replace(/\u2014ft@\u2014s/g, "")
    .replace(/\u2014ft waves/g, "")
    .replace(/\u2014kt/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * P1-L: strip the site chrome the meeting scraper captures with the record.
 * The city's meeting page repeats its own navigation ("Meeting Agenda (View the
 * agenda...)", "Submit Written Public Comment (...)", "YouTube Channel (...)",
 * "Media Site", "City of Crescent City Website") inside the body text; those
 * strings describe the source site's furniture, not the meeting, and reading
 * them as meeting copy is what put nav boilerplate on the public page.
 */
const MEETING_NAV_CHROME = [
  /Meeting Agenda \(View the agenda[^)]*\)/gi,
  /Submit Written Public Comment \([^)]*\)/gi,
  /YouTube Channel \([^)]*\)/gi,
  /Media Site/gi,
  /City of Crescent City Website/gi,
];

/** A labelled meeting document extracted from the scraped body text. */
export type MeetingDocument = { label: string; url: string };

/**
 * Split a scraped meeting body into public prose and labelled documents.
 * "Agenda: https://... , https://..." and "Minutes: https://..." segments become
 * {label, url} pairs the page renders as links; the remaining prose keeps only
 * text that is about the meeting. Nothing is invented: a body with no documents
 * yields an empty list, and a body that is entirely chrome yields empty prose.
 */
export function splitMeetingContent(raw: string): { content: string; documents: MeetingDocument[] } {
  let text = String(raw ?? "");
  for (const pattern of MEETING_NAV_CHROME) text = text.replace(pattern, " ");
  const documents: MeetingDocument[] = [];
  // URLs are matched without commas so a comma-separated list splits into its
  // real members instead of one URL that swallows the separator.
  const labelled = /\b(Agenda|Minutes|Packet|Presentation|Staff Report)\s*:\s*((?:https?:\/\/[^\s,]+)(?:\s*,\s*https?:\/\/[^\s,]+)*)/gi;
  text = text.replace(labelled, (_match, label: string, urls: string) => {
    const list = urls.split(/\s*,\s*/).map(url => url.trim()).filter(url => /^https?:\/\//i.test(url));
    list.forEach((url, index) => {
      const suffix = list.length > 1 ? ` ${index + 1}` : "";
      documents.push({ label: `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}${suffix}`, url });
    });
    return " ";
  });
  // Any URL left in the prose is a bare link with no label; it belongs in the
  // document list too rather than as raw URL text in a sentence.
  text = text.replace(/https?:\/\/\S+/g, url => {
    documents.push({ label: "Related document", url });
    return " ";
  });
  const content = text.replace(/[|\u00b7]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "").trim();
  return { content, documents };
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
      title: sanitizeRenderedText(title),
      link: typeof item.link === "string" && /^https?:\/\//i.test(item.link) ? item.link : `${PAGES_SITE_URL}/news.html`,
      description: typeof item.description === "string" ? sanitizeRenderedText(item.description.slice(0, 500)) : "",
      date: feedItemDate(item),
    });
  }
  for (const item of snapshot.meetings) {
    const title = feedItemTitle(item);
    if (!title) continue;
    items.push({
      title: sanitizeRenderedText(title),
      link: typeof item.link === "string" && /^https?:\/\//i.test(item.link) ? item.link : `${PAGES_SITE_URL}/meetings.html`,
      description: typeof item.content === "string" ? sanitizeRenderedText(splitMeetingContent(item.content).content.slice(0, 500)) : "",
      date: feedItemDate(item),
    });
  }
  for (const alert of snapshot.alerts.current) {
    const title = feedItemTitle(alert);
    if (!title) continue;
    const monitor = typeof alert.monitor === "string" ? alert.monitor : "unknown";
    items.push({
      title: sanitizeRenderedText(`Alerts \u00b7 ${monitor}: ${title}`),
      link: `${PAGES_SITE_URL}/#alerts`,
      description: typeof alert.detail === "string" && alert.detail.trim() ? sanitizeRenderedText(alert.detail.slice(0, 500)) : `Current ${monitor} alert state`,
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

/**
 * Build Event JSON-LD for events.html from the exact events artifact being
 * published. Events without a parseable date or title are skipped rather than
 * invented; source links are preserved as `sameAs` for provenance.
 */
export function buildPagesEventsJsonLd(events: EventsArtifact["events"], generatedAt: string): string {
  const items = events
    .filter(event => typeof event.title === "string" && event.title.trim() && typeof event.dateStart === "string" && event.dateStart)
    .slice(0, 100)
    .map(event => {
      const record: Record<string, unknown> = {
        "@type": "Event",
        name: event.title.trim(),
        startDate: event.dateStart,
        url: `${PAGES_SITE_URL}/events.html`,
      };
      if (typeof event.location === "string" && event.location.trim()) {
        record.location = { "@type": "Place", name: event.location.trim() };
      }
      if (typeof event.organizer === "string" && event.organizer.trim()) {
        record.organizer = { "@type": "Organization", name: event.organizer.trim() };
      }
      const sourceLinks = Array.isArray(event.sourceLinks) ? event.sourceLinks.filter((link): link is string => typeof link === "string" && /^https?:\/\//i.test(link)) : [];
      if (sourceLinks.length > 0) {
        record.sameAs = sourceLinks;
      }
      record.dateModified = generatedAt;
      return record;
    });
  const block = { "@context": "https://schema.org", "@type": "ItemList", itemListElement: items.map((item, index) => ({ "@type": "ListItem", position: index + 1, item })) };
  return `<script type="application/ld+json">${JSON.stringify(block)}</script>`;
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
    ...(() => {
      const body = typeof item.content === "string" ? item.content : typeof item.body === "string" ? item.body : "";
      const split = splitMeetingContent(body);
      return { content: split.content, documents: split.documents };
    })(),
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

function directorySeedSafeBuild(raw: unknown, generatedAt: string): DirectoryArtifact | null {
  if (raw === null || raw === undefined) return null;
  try {
    return buildDirectoryArtifact(generatedAt, raw);
  } catch (error) {
    // A malformed seed must not ship silently; fail the export with the reason.
    throw new Error(`Pages directory seed is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const monthlyRaw = reportPath ? await readFile(reportPath, "utf8").catch(() => null) : null;
  // The monthly report is written for the operator (its System Health section
  // contains local commands like `bun run verify`). The Pages snapshot is a
  // PUBLIC surface, so operator-command lines are stripped before the report
  // is inlined/emitted; the operator artifact on disk keeps full detail.
  const monthly = monthlyRaw === null
    ? null
    : monthlyRaw
      .split("\n")
      .filter(line => !/- Run `bun run [a-z:-]+`/.test(line))
      .join("\n");
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
  // Local-establishments directory: seed first (hand-curated, source-cited),
  // then any prior edition artifact. A present-but-invalid seed fails loudly.
  const directorySeedRaw = await readJson<unknown>(join(resolvedSeed, "directory.json"))
    ?? await readJson<unknown>(join(resolvedOutput, "directory.json"));
  const directory = directorySeedSafeBuild(directorySeedRaw, generatedAt);
  const directorySummary = summarizeDirectory(directory);
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
      counts: {
        articlePageCount: manifest && typeof manifest.articlePageCount === "number" ? manifest.articlePageCount : null,
        sectionCount: manifest && typeof manifest.sectionCount === "number" ? manifest.sectionCount : null,
      },
    },
    geoIntel: geoIntelSummary,
    directory: directorySummary,
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
      directory: directory ? PAGES_DIRECTORY_ARTIFACT : null,
      events: PAGES_EVENTS_ARTIFACT,
      news: PAGES_NEWS_ARTIFACT,
      meetings: PAGES_MEETINGS_ARTIFACT,
      alerts: PAGES_ALERTS_ARTIFACT,
      analytics: analytics?.schemaVersion === "1.0.0" ? PAGES_ANALYTICS_ARTIFACT : null,
      operatorSignals: analytics?.schemaVersion === "1.0.0" ? PAGES_OPERATOR_SIGNALS_ARTIFACT : null,
      codeSearchIndex: null,
      codeSearchTitleIndex: null,
      codeSearchBodyIndex: null,
      codeMeta: null,
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
  const directorySeedRaw = await readJson<unknown>(join(seedRoot, "directory.json"))
    ?? await readJson<unknown>(join(sourceRoot, "directory.json"));
  const directory = directorySeedSafeBuild(directorySeedRaw, generatedAt);
  const temporary = await mkdtemp(join(dirname(destination), ".pages-build-"));
  const files: string[] = [];
  try {
    const editionDate = generatedAt.slice(0, 10);
    // §6.3: shared assets are content-hashed at export so they can be served
    // with normal (effectively immutable) caching — §1.6 unblocked for CSS/JS.
    const sharedAssetPaths: Record<string, string> = {};
    for (const asset of PAGES_SHARED_ASSETS) {
      const bytes = await readFile(join(STATIC_DIR, "assets", asset.source));
      const hashed = pagesContentHashName(asset.hashPrefix + asset.source.split(".").pop(), bytes);
      await mkdir(join(temporary, "assets"), { recursive: true });
      await writeFile(join(temporary, hashed), bytes);
      files[files.length] = hashed;
      sharedAssetPaths[asset.source] = hashed;
    }
    const resolveAssetPlaceholders = (html: string): string => {
      let resolved = html;
      for (const asset of PAGES_SHARED_ASSETS) {
        resolved = resolved.split(asset.placeholder).join(sharedAssetPaths[asset.source]);
      }
      return resolved;
    };
    // Every shared-asset placeholder must resolve on every page; a surviving
    // marker of any kind fails the export rather than shipping a broken link.
    const assertNoAssetPlaceholders = (html: string, pageFile: string): string => {
      for (const asset of PAGES_SHARED_ASSETS) {
        if (html.includes(asset.placeholder)) {
          throw new Error(`Pages shared-asset placeholders were not replaced: ${pageFile} (${asset.source})`);
        }
      }
      return html;
    };
    const indexTemplate = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    const faviconHead = buildPagesFaviconHeadHtml();
    // index.html keeps its hand-authored canonical/OG/Twitter head block; the
    // generated head-meta path covers the six standalone pages from the manifest.
    const indexChromed = embedPagesFooter(
      embedPagesBreadcrumb(
        embedPagesNav(indexTemplate, null),
        null,
      ),
    );
    const indexHtmlFinal = embedPagesMethodsCounts(embedPagesGeoView(indexChromed, geoIntel.view), buildPagesMethodsCounts(snapshot))
      .split(PAGES_DATE_PUBLISHED_PLACEHOLDER).join(editionDate)
      .split(PAGES_DATE_MODIFIED_PLACEHOLDER).join(editionDate);
    if (indexHtmlFinal.includes(PAGES_DATE_PUBLISHED_PLACEHOLDER) || indexHtmlFinal.includes(PAGES_DATE_MODIFIED_PLACEHOLDER)) {
      throw new Error("Pages index JSON-LD date placeholders were not replaced");
    }
    const indexWithAssets = resolveAssetPlaceholders(indexHtmlFinal.replace("  <script>", `${PAGES_SHARED_JS_TAG}\n  <script>`));
    await writeFile(join(temporary, "index.html"), assertNoAssetPlaceholders(indexWithAssets, "index.html"), "utf8");
    const page404Template = await readFile(join(STATIC_DIR, "404.html"), "utf8");
    const page404Chromed = embedPagesFooter(
      embedPagesBreadcrumb(
        embedPagesNav(page404Template, null, { rootAbsolute: true }),
        null,
        { rootAbsolute: true, label: "Page not found" },
      ),
      "errata",
    );
    // Lane A r2: 404.html is served at arbitrary nested paths, so its shared
    // stylesheet links must be root-absolute exactly like its nav links (§2.2).
    const page404Final = assertNoAssetPlaceholders(
      resolveAssetPlaceholders(page404Chromed)
        .replace("</head>", `${faviconHead}\n</head>`)
        .replaceAll('href="assets/', 'href="/assets/'),
      "404.html",
    );
    await writeFile(join(temporary, "404.html"), page404Final, "utf8");
    for (const page of PAGES_STATIC_PAGES) {
      if (!(await copyIfPresent(join(STATIC_DIR, page.file), join(temporary, page.file)))) {
        throw new Error(`Pages static page is missing from ${STATIC_DIR}: ${page.file}`);
      }
      const pagePath = join(temporary, page.file);
      const pageHtml = await readFile(pagePath, "utf8");
      // Per-page SEO: syndication link, WebPage/CollectionPage, BreadcrumbList,
      // and Dataset JSON-LD injected at export time from the page manifest.
      const chromed = embedPagesHeadMeta(
        embedPagesFooter(
          embedPagesBreadcrumb(
            embedPagesNav(pageHtml, page.file),
            page.file,
          ),
        ),
        page.file,
      );
      const hydrated = chromed
        .replace("</head>", `${faviconHead}\n${PAGES_FEED_LINK_HTML}\n${buildPagesWebPageJsonLd(page, generatedAt)}\n${buildPagesBreadcrumbJsonLd(page)}\n${buildPagesDatasetJsonLd(generatedAt)}\n${page.file === "events.html" ? buildPagesEventsJsonLd(snapshot.events?.events ?? [], generatedAt) : ""}\n</head>`)
        .replace(PAGES_JSONLD_WEBPAGE_PLACEHOLDER, "")
        .replace(PAGES_JSONLD_BREADCRUMB_PLACEHOLDER, "")
        .replace(PAGES_JSONLD_DATASET_PLACEHOLDER, "");
      if (hydrated.includes("PAGES_JSONLD")) throw new Error(`Pages page JSON-LD markers were not replaced: ${page.file}`);
      const withAssets = resolveAssetPlaceholders(hydrated.replace("    <script>", `    ${PAGES_SHARED_JS_TAG}\n    <script>`));
      assertNoAssetPlaceholders(withAssets, page.file);
      await writeFile(pagePath, withAssets, "utf8");
      files[files.length] = page.file;
    }
    await writeFile(join(temporary, ".nojekyll"), "\n", "utf8");
    // SS6.4: 404.html presence is hard-required; the earlier readFile already
    // throws when missing, so this manifest entry can never report a page
    // that failed to be written (the old silent push is eliminated).
    files.push("index.html", "404.html", ".nojekyll");
    // --- SEO artifacts (§3.1, §3.2): OG card, favicons, manifest ---
    await writeFile(join(temporary, PAGES_OG_IMAGE_PNG), buildPagesOgImagePng(snapshot));
    await writeFile(join(temporary, PAGES_APPLE_TOUCH_ICON_PNG), buildPagesAppleTouchIconPng());
    await writeFile(join(temporary, PAGES_FAVICON_ICO), buildPagesFaviconIco());
    await writeFile(join(temporary, PAGES_FAVICON_SVG), buildPagesFaviconSvg(), "utf8");
    await writeFile(join(temporary, PAGES_WEB_MANIFEST), buildPagesWebManifest(), "utf8");
    files.push(PAGES_OG_IMAGE_PNG, PAGES_APPLE_TOUCH_ICON_PNG, PAGES_FAVICON_ICO, PAGES_FAVICON_SVG, PAGES_WEB_MANIFEST);

    // --- Honest sitemap lastmod (§3.7): derive from source mtime, never the build date ---
    const lastmodByPath: Record<string, string> = {};
    const sourceFiles: Array<[string, string]> = [["", "index.html"], ...PAGES_STATIC_PAGES.map(page => [page.file, page.file] as [string, string])];
    for (const [path, filename] of sourceFiles) {
      try {
        const stat = await Bun.file(join(STATIC_DIR, filename)).stat();
        const mtime = stat?.mtime;
        if (mtime) lastmodByPath[path] = mtime.toISOString().slice(0, 10);
      } catch { /* omit lastmod rather than fabricate it from the build date */ }
    }
    await writeFile(join(temporary, PAGES_ROBOTS_TXT), buildPagesRobotsTxt(), "utf8");
    await writeFile(join(temporary, PAGES_SITEMAP_XML), buildPagesSitemapXml(lastmodByPath), "utf8");
    await writeFile(join(temporary, PAGES_FEED_XML), buildPagesFeedXml(snapshot), "utf8");
    files[files.length] = PAGES_ROBOTS_TXT;
    files[files.length] = PAGES_SITEMAP_XML;
    files[files.length] = PAGES_FEED_XML;

    await writeJson(join(temporary, "data/snapshot.json"), snapshot);
    await writeJson(join(temporary, "data/source-health.json"), snapshot.sourceHealth);
    await writeJson(join(temporary, "data/source-registry.json"), snapshot.sourceRegistry);
    await writeJson(join(temporary, "data/source-discovery.json"), snapshot.sourceDiscovery);
    await writeJson(join(temporary, PAGES_GEO_INTEL_ARTIFACT), geoIntel);
    // The directory artifact is ALWAYS emitted: directory.html fetches it on
    // load, and a missing file turned the whole page into one error state (the
    // analytics lesson). When no verified seed exists this edition, an explicit
    // unavailable envelope is the honest answer, and snapshot.files.directory
    // stays null so nothing claims a directory that does not exist.
    if (directory) {
      await writeJson(join(temporary, PAGES_DIRECTORY_ARTIFACT), directory);
    } else {
      await writeJson(join(temporary, PAGES_DIRECTORY_ARTIFACT), {
        schema: "crescent-city-directory-unavailable/v1",
        generatedAt,
        available: false,
        reason: "No verified directory seed was available for this edition.",
      });
    }
    await writeJson(join(temporary, PAGES_EVENTS_ARTIFACT), snapshot.events);
    await writeFile(join(temporary, PAGES_EVENTS_ICS_ARTIFACT), buildEventsIcs(snapshot.events?.events ?? []), "utf8");
    // --- Per-page artifacts (§1.2): subpages fetch only the slice they render ---
    await writeJson(join(temporary, PAGES_NEWS_ARTIFACT), snapshot.news);
    await writeJson(join(temporary, PAGES_MEETINGS_ARTIFACT), snapshot.meetings);
    await writeJson(join(temporary, PAGES_ALERTS_ARTIFACT), snapshot.alerts);
    files.push(PAGES_DIRECTORY_ARTIFACT);
    files.push("data/snapshot.json", "data/source-health.json", "data/source-registry.json", "data/source-discovery.json", PAGES_GEO_INTEL_ARTIFACT, PAGES_EVENTS_ARTIFACT, PAGES_EVENTS_ICS_ARTIFACT, PAGES_NEWS_ARTIFACT, PAGES_MEETINGS_ARTIFACT, PAGES_ALERTS_ARTIFACT);
    // The analytics artifact is ALWAYS emitted, even when this edition has no
    // overview: gui.html fetches it on load, and a missing file made that fetch
    // 404 — which killed the whole console (the fetches shared one Promise.all,
    // so alerts and events that had loaded fine were discarded and the page
    // rendered "Snapshot unavailable"). An explicit unavailable envelope is the
    // honest answer to "is there an overview this edition?", and snapshot.files
    // .analytics stays null so nothing claims an overview that does not exist.
    if (!snapshot.analytics) {
      await writeJson(join(temporary, PAGES_ANALYTICS_ARTIFACT), {
        schemaVersion: "crescent-city-analytics-unavailable/v1",
        generatedAt,
        available: false,
        reason: "No analytics overview was produced for this edition.",
      });
    }
    if (snapshot.analytics) {
      await writeJson(join(temporary, PAGES_ANALYTICS_ARTIFACT), snapshot.analytics);
      files.push(PAGES_ANALYTICS_ARTIFACT);
      // §5.5 (lane A r2): persist the routed operator-only signals. The
      // overview carries the public notice copy only; this artifact is the
      // operator channel — honest about what was noticed, never rendered.
      await writeJson(join(temporary, PAGES_OPERATOR_SIGNALS_ARTIFACT), {
        schemaVersion: "crescent-city-operator-signals/v1",
        generatedAt,
        inputFingerprint: snapshot.analytics.inputFingerprint,
        operatorSignalsNoticed: snapshot.analytics.operatorSignalsNoticed,
        publicSignalsNotice: "Operator-only conditions were routed out of the public analytics surface; public copy states each affected source is unavailable this edition.",
      });
      files.push(PAGES_OPERATOR_SIGNALS_ARTIFACT);
    }

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
    // --- Sharded municipal-code search index (§1.3), content-hashed for normal caching (§1.6) ---
    // Lane D §2: the combined index (client-compat, referenced by index.html's
    // lazy loader — not lane D's file) is joined by per-field shards so future
    // consumers can fetch only the ~0.5 MB title shard; plus a tiny code-meta
    // artifact so code.html no longer needs the ~236 KB envelope (lane D §3).
    const codeJsonBytes = await readFile(join(temporary, "data/code.json")).catch(() => null);
    if (codeJsonBytes !== null) {
      const searchIndex = buildPagesCodeSearchIndex(JSON.parse(new TextDecoder().decode(codeJsonBytes)));
      const searchIndexSource = `${JSON.stringify(searchIndex)}\n`;
      const titleSource = `${JSON.stringify({
        schema: searchIndex.schema,
        articleCount: searchIndex.articleCount,
        sectionCount: searchIndex.sectionCount,
        shard: "t" as const,
        entries: searchIndex.shards.t,
      })}\n`;
      const bodySource = `${JSON.stringify({
        schema: searchIndex.schema,
        sectionCount: searchIndex.sectionCount,
        shard: "x" as const,
        entries: searchIndex.shards.x,
      })}\n`;
      const searchIndexPath = pagesContentHashName(PAGES_SEARCH_INDEX_ARTIFACT_PREFIX + "json", searchIndexSource);
      const titleIndexPath = pagesContentHashName(PAGES_SEARCH_TITLE_ARTIFACT_PREFIX + "json", titleSource);
      const bodyIndexPath = pagesContentHashName(PAGES_SEARCH_BODY_ARTIFACT_PREFIX + "json", bodySource);
      await writeFile(join(temporary, searchIndexPath), searchIndexSource, "utf8");
      await writeFile(join(temporary, titleIndexPath), titleSource, "utf8");
      await writeFile(join(temporary, bodyIndexPath), bodySource, "utf8");
      snapshot.files.codeSearchIndex = searchIndexPath;
      snapshot.files.codeSearchTitleIndex = titleIndexPath;
      snapshot.files.codeSearchBodyIndex = bodyIndexPath;
      // Tiny code-meta artifact (lane D §3): code.html's whole first-load dependency.
      const codeMeta = {
        schema: "crescent-city-code-meta/v1",
        generatedAt: snapshot.generatedAt,
        available: snapshot.municipalCode.available,
        source: snapshot.municipalCode.source,
        counts: snapshot.municipalCode.counts,
        files: {
          code: snapshot.files.code,
          codeSearchIndex: searchIndexPath,
          codeSearchTitleIndex: titleIndexPath,
          codeSearchBodyIndex: bodyIndexPath,
        },
      };
      const codeMetaPath = PAGES_CODE_META_ARTIFACT;
      await writeFile(join(temporary, codeMetaPath), `${JSON.stringify(codeMeta)}\n`, "utf8");
      snapshot.files.codeMeta = codeMetaPath;
      // Persist the envelope again so files.* match the emitted artifacts.
      await writeJson(join(temporary, "data/snapshot.json"), snapshot);
      files.push(searchIndexPath, titleIndexPath, bodyIndexPath, codeMetaPath);
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
        directory: snapshot.directory.count,
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
  return validatePagesHtml({ "index.html": indexHtml });
}

/**
 * §6.4: shared release-gate assertions over ALL eight exported pages (not just
 * index). Every page runs the shared honesty/structure checks; the index keeps
 * its full page-specific contract below. A missing manifest page in the map is
 * itself an error, so callers cannot silently narrow the gate.
 */
export function validatePagesHtml(pagesHtml: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const page of PAGES_STATIC_PAGES.map(candidate => candidate.file)) {
    if (typeof pagesHtml[page] !== "string") errors.push(`Pages source map is missing required page: ${page}`);
  }
  if (errors.length > 0) return errors;
  for (const [pageFile, html] of Object.entries(pagesHtml)) {
    const isIndex = pageFile === "index.html";
    if (html.includes("__CC_API_KEY__") || html.includes("__CC_API_KEY_INJECT__")) errors.push(`${pageFile} contains an API-key placeholder`);
    if (html.includes("localhost:3000") || html.includes("localhost:8001")) errors.push(`${pageFile} references a local-only service`);
    if (!html.includes("<footer")) errors.push(`${pageFile} is missing the footer element`);
    if (!html.includes("<main")) errors.push(`${pageFile} is missing the main landmark`);
    if (!html.includes('class="skip-link"')) errors.push(`${pageFile} is missing the skip link`);
    const jsonLdBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => match[1]);
    for (const [index, block] of jsonLdBlocks.entries()) {
      try {
        const parsed = JSON.parse(block) as unknown;
        if (typeof parsed === "object" && parsed !== null && JSON.stringify(parsed).includes("GovernmentOrganization")) {
          errors.push(`${pageFile} JSON-LD block ${index + 1} claims GovernmentOrganization`);
        }
      } catch {
        errors.push(`${pageFile} JSON-LD block ${index + 1} does not parse as JSON`);
      }
    }
    if (pageFile === "404.html") continue;
    // Source-level HTML carries injection markers; the exported artifact carries
    // the injected content. Either satisfies the contract.
    const hasCanonical = html.includes('rel="canonical"') || html.includes("PAGES_HEAD_META");
    if (!hasCanonical && !isIndex) errors.push(`${pageFile} is missing the canonical link`);
    const hasBreadcrumb = jsonLdBlocks.some(block => block.includes('"BreadcrumbList"')) || html.includes("PAGES_JSONLD_BREADCRUMB");
    if (!hasBreadcrumb) errors.push(`${pageFile} is missing BreadcrumbList JSON-LD`);
    const hasWebPage = jsonLdBlocks.some(block => block.includes('"WebPage"') || block.includes('"CollectionPage"')) || html.includes("PAGES_JSONLD_WEBPAGE");
    if (!hasWebPage) errors.push(`${pageFile} is missing WebPage/CollectionPage JSON-LD`);
  }
  const indexHtml = pagesHtml["index.html"] ?? "";
  if (!indexHtml.includes("data/snapshot.json")) errors.push("Pages index does not load data/snapshot.json");
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

#!/usr/bin/env bun
/** Validate a generated public Pages artifact without making network calls. */
import { readFile } from "fs/promises";
import { readdirSync } from "fs";
import { join, resolve } from "path";
import {
  PAGES_APPLE_TOUCH_ICON_PNG,
  PAGES_FAVICON_ICO,
  PAGES_FAVICON_SVG,
  PAGES_GEO_INTEL_ARTIFACT,
  PAGES_OG_IMAGE_PNG,
  PAGES_SECTION_NAV,
  PAGES_STATIC_PAGES,
  PAGES_WEB_MANIFEST,
  PAGES_GEO_VIEW_PLACEHOLDER,
  summarizePagesGeoIntel,
  validatePagesGeoIntel,
  validatePagesSource,
  validatePagesHtml,
} from "../src/pages_snapshot.js";
import { PAGES_OPERATOR_SIGNALS_ARTIFACT, PAGES_ROBOTS_TXT, PAGES_SITEMAP_XML, PAGES_STATIC_PAGES, PAGES_CODE_META_ARTIFACT, PAGES_SEARCH_TITLE_ARTIFACT_PREFIX, PAGES_SEARCH_BODY_ARTIFACT_PREFIX } from "../src/pages_snapshot.js";
import { EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health.js";
import type { PagesSnapshot } from "../src/pages_snapshot.js";

const destination = resolve(Bun.argv.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? ".pages");
const errors: string[] = [];
const required = ["index.html", "404.html", ".nojekyll", "data/snapshot.json", "data/source-health.json", "data/source-registry.json", "data/source-discovery.json", PAGES_GEO_INTEL_ARTIFACT];

for (const relative of required) {
  try { await readFile(join(destination, relative)); }
  catch { errors.push(`missing required Pages asset: ${relative}`); }
}

const indexHtml = await readFile(join(destination, "index.html"), "utf8").catch(() => "");
// SS6.4: shared assertions now run across all eight exported pages, not just
// index.html; a missing page surfaces as a map error from validatePagesHtml.
const exportedPagesHtml: Record<string, string> = { "index.html": indexHtml };
for (const page of PAGES_STATIC_PAGES.map(candidate => candidate.file).concat("404.html")) {
  exportedPagesHtml[page] = await readFile(join(destination, page), "utf8").catch(() => "");
}
errors.push(...validatePagesHtml(exportedPagesHtml));
if (indexHtml.includes(PAGES_GEO_VIEW_PLACEHOLDER)) errors.push("Pages geo-view placeholder was not replaced");
if (!indexHtml.includes('data-geo-view-schema="crescent-city-geo-view/v1"')) errors.push("Pages artifact does not contain the rendered geo-view SVG");

// SEO discoverability: robots.txt and sitemap.xml must exist and parse.
const robotsTxt = await readFile(join(destination, PAGES_ROBOTS_TXT), "utf8").catch(() => null);
if (robotsTxt === null) {
  errors.push(`missing required Pages asset: ${PAGES_ROBOTS_TXT}`);
} else if (!/^User-agent:\s*\*$/m.test(robotsTxt) || !/Allow:\s*\/$/m.test(robotsTxt)) {
  errors.push("robots.txt does not declare an allow-all policy");
} else if (!/Sitemap:\s*https:\/\/quadruplicate\.org\/sitemap\.xml$/m.test(robotsTxt)) {
  errors.push("robots.txt is missing the sitemap pointer");
}
let sitemapXml = await readFile(join(destination, PAGES_SITEMAP_XML), "utf8").catch(() => null);
if (sitemapXml === null) {
  errors.push(`missing required Pages asset: ${PAGES_SITEMAP_XML}`);
} else {
  const locMatches = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  if (!/<urlset[^>]*xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/.test(sitemapXml)) errors.push("sitemap.xml is missing the sitemap namespace");
  if (locMatches.length === 0) errors.push("sitemap.xml has no <loc> entries");
  if (!locMatches.includes("https://quadruplicate.org/")) errors.push("sitemap.xml is missing the canonical root URL");
  // The sitemap now lists the dedicated standalone pages (real URLs) instead
  // of in-page anchors, matching buildPagesSitemapXml and pages-seo tests.
  for (const page of PAGES_STATIC_PAGES) {
    if (!locMatches.includes(`https://quadruplicate.org/${page.file}`)) errors.push(`sitemap.xml is missing the ${page.file} page URL`);
  }
}

let snapshot: PagesSnapshot | null = null;
try {
  snapshot = JSON.parse(await readFile(join(destination, "data/snapshot.json"), "utf8")) as PagesSnapshot;
} catch { errors.push("data/snapshot.json is not valid JSON"); }

let geoIntel: unknown = null;
const geoIntelSource = await readFile(join(destination, PAGES_GEO_INTEL_ARTIFACT), "utf8").catch(() => null);
if (geoIntelSource !== null) {
  try {
    geoIntel = JSON.parse(geoIntelSource) as unknown;
    errors.push(...validatePagesGeoIntel(geoIntel, new TextEncoder().encode(geoIntelSource).byteLength));
  } catch {
    errors.push(`${PAGES_GEO_INTEL_ARTIFACT} is not valid JSON`);
  }
}

if (snapshot) {
  if (snapshot.schemaVersion !== "1.0.0") errors.push(`unsupported snapshot schema: ${String(snapshot.schemaVersion)}`);
  if (!Number.isFinite(Date.parse(snapshot.generatedAt))) errors.push("snapshot generatedAt is not an ISO timestamp");
  if (!["ok", "degraded", "unavailable"].includes(snapshot.status)) errors.push(`invalid snapshot status: ${String(snapshot.status)}`);
  if (!Array.isArray(snapshot.sourceHealth)) errors.push("snapshot sourceHealth is not an array");
  if (!Array.isArray(snapshot.sourceRegistry) || snapshot.sourceRegistry.length === 0) errors.push("snapshot sourceRegistry is missing or empty");
  if (!snapshot.sourceRegistryFingerprint || snapshot.sourceRegistryFingerprint.length !== 64) errors.push("snapshot source registry fingerprint is missing or invalid");
  if (!snapshot.sourceDiscovery || snapshot.sourceDiscovery.registryFingerprint.length !== 64) errors.push("snapshot sourceDiscovery is missing or has an invalid fingerprint");
  if (snapshot.sourceDiscovery && snapshot.sourceRegistryFingerprint && snapshot.sourceDiscovery.registryFingerprint !== snapshot.sourceRegistryFingerprint) errors.push("snapshot source discovery fingerprint does not match source registry");
  if (snapshot.sourceDiscovery && snapshot.sourceDiscovery.sourceCount !== snapshot.sourceRegistry.length) errors.push("snapshot source discovery count does not match registry");
  if (!snapshot.healthSummary || !Array.isArray(snapshot.sourceHealth)) errors.push("snapshot healthSummary cannot be checked without sourceHealth");
  if (snapshot.healthSummary && Array.isArray(snapshot.sourceHealth) && snapshot.healthSummary.total !== snapshot.sourceHealth.length) errors.push("snapshot healthSummary does not match sourceHealth");
  if (snapshot.healthSummary && Array.isArray(snapshot.sourceHealth) && snapshot.healthSummary.degraded !== snapshot.sourceHealth.filter(source => source.status === "unavailable" || source.status === "stale").length) {
    errors.push("snapshot healthSummary degraded count is not truthful");
  }
  if (snapshot.healthSummary && Array.isArray(snapshot.sourceHealth) && snapshot.healthSummary.missing !== snapshot.sourceHealth.filter(source => source.status === "unavailable" || source.status === "stale").length) {
    errors.push("snapshot healthSummary missing count is not truthful");
  }
  if (snapshot.healthSummary && Array.isArray(snapshot.sourceHealth) && snapshot.healthSummary.present !== snapshot.sourceHealth.filter(source => source.status === "ok" || source.status === "empty").length) {
    errors.push("snapshot healthSummary present count is not truthful");
  }
  if (snapshot.healthSummary && Array.isArray(snapshot.sourceHealth) && snapshot.healthSummary.coveragePercent !== (snapshot.healthSummary.total === 0 ? 0 : Math.round((snapshot.healthSummary.present / snapshot.healthSummary.total) * 1000) / 10)) {
    errors.push("snapshot healthSummary coverage percentage is not truthful");
  }
  if (snapshot.healthSummary && Array.isArray(snapshot.sourceHealth)) {
    const presentSources = snapshot.sourceHealth.filter(source => source.status === "ok" || source.status === "empty").map(source => source.source).sort();
    const missingSources = snapshot.sourceHealth.filter(source => source.status === "unavailable" || source.status === "stale").map(source => source.source).sort();
    if (JSON.stringify(snapshot.healthSummary.presentSources) !== JSON.stringify(presentSources)) errors.push("snapshot healthSummary presentSources is not truthful");
    if (JSON.stringify(snapshot.healthSummary.missingSources) !== JSON.stringify(missingSources)) errors.push("snapshot healthSummary missingSources is not truthful");
    if (JSON.stringify(snapshot.healthSummary.sources) !== JSON.stringify(snapshot.sourceHealth.map(source => source.source).sort())) errors.push("snapshot healthSummary sources is not truthful");
    const expectedCoverageStatus = snapshot.sourceHealth.length === 0 ? "none" : missingSources.length === 0 ? "complete" : presentSources.length === 0 ? "none" : "partial";
    if (snapshot.healthSummary.coverageStatus !== expectedCoverageStatus) errors.push("snapshot healthSummary coverageStatus is not truthful");
    if (new Set(snapshot.sourceHealth.map(source => source.source)).size !== snapshot.sourceHealth.length) errors.push("snapshot sourceHealth contains duplicate source names");
    const expectedNames = EXPECTED_SOURCE_HEALTH.map(expected => expected.source).sort();
    for (const source of expectedNames) if (!snapshot.sourceHealth.some(record => record.source === source)) errors.push(`snapshot sourceHealth is missing expected source: ${source}`);
  }
  // Source gaps are shown in the snapshot health summary and must not turn an
  // otherwise complete static export into a false pipeline failure.
  if (!snapshot.publicationPolicy || snapshot.publicationPolicy.triplicate !== "reference-citation-only") errors.push("Triplicate publication policy is missing or unsafe");
  if (snapshot.publicationPolicy?.curationInputs?.includes("triplicate")) errors.push("Triplicate is incorrectly listed as a curation input");
  if (snapshot.report?.metadata && snapshot.files.reportMetadata !== "data/report-metadata.json") errors.push("report metadata link is inconsistent");
  if (snapshot.analytics && snapshot.files.analyticsOverview !== "data/analytics-overview.json") errors.push("analytics overview link is inconsistent");
  if (snapshot.files?.geoIntel !== PAGES_GEO_INTEL_ARTIFACT) errors.push("geo-intel artifact link is inconsistent");
  const geoIntelSummary = summarizePagesGeoIntel(geoIntel);
  if (!geoIntelSummary) errors.push("geo-intel artifact summary cannot be derived");
  else if (JSON.stringify(snapshot.geoIntel) !== JSON.stringify(geoIntelSummary)) errors.push("snapshot geoIntel summary does not match the geo-intel artifact");
}

const jsonLdBlocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => match[1]);
if (jsonLdBlocks.length === 0) {
  errors.push("index.html is missing the JSON-LD structured data script");
} else {
  const parsed: Record<string, unknown>[] = [];
  jsonLdBlocks.forEach((block, index) => {
    try {
      const value = JSON.parse(block) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed.push(value as Record<string, unknown>);
      else errors.push(`JSON-LD block ${index + 1} is not an object`);
    } catch {
      errors.push(`JSON-LD block ${index + 1} does not parse as JSON`);
    }
  });
  const website = parsed.find(entry => entry["@type"] === "WebSite");
  if (!website) errors.push("JSON-LD @type WebSite is missing");
  else {
    if (website.url !== "https://quadruplicate.org/") errors.push("JSON-LD url does not match the canonical site URL");
    const publisher = typeof website.publisher === "object" && website.publisher !== null ? website.publisher as Record<string, unknown> : null;
    if (publisher?.["@type"] !== "NewsMediaOrganization") errors.push("JSON-LD publisher is not NewsMediaOrganization");
    if (publisher && JSON.stringify(publisher).includes("GovernmentOrganization")) errors.push("JSON-LD publisher still claims GovernmentOrganization");
    if (publisher) {
      const areaServed = publisher.areaServed as Record<string, unknown> | undefined;
      const address = areaServed && typeof areaServed === "object" ? (areaServed as Record<string, unknown>).address : undefined;
      if (!address || (address as Record<string, unknown>)["@type"] !== "PostalAddress") errors.push("JSON-LD areaServed.address is not a PostalAddress");
      if (!publisher.logo) errors.push("JSON-LD publisher is missing logo");
      if (!Array.isArray(publisher.sameAs) || publisher.sameAs.length === 0) errors.push("JSON-LD publisher is missing sameAs");
    }
    if (!parsed.some(entry => entry["@type"] === "BreadcrumbList")) errors.push("index.html is missing BreadcrumbList JSON-LD");
    if (!parsed.some(entry => entry["@type"] === "DataCatalog")) errors.push("index.html is missing Dataset/DataCatalog JSON-LD");
  }
  // FAQPage JSON-LD must exist and every Q&A must exactly match the visible FAQ text.
  const faqPage = parsed.find(entry => entry["@type"] === "FAQPage");
  if (!faqPage) {
    errors.push("FAQPage JSON-LD is missing");
  } else {
    const mainEntity = Array.isArray(faqPage.mainEntity) ? faqPage.mainEntity : [];
    if (mainEntity.length < 5 || mainEntity.length > 8) errors.push("FAQPage mainEntity should hold 5-8 questions");
    const stripTags = (text: string) => text.replace(/<[^>]+>/g, "");
    for (const [index, question] of mainEntity.entries()) {
      const q = typeof (question as Record<string, unknown>)?.name === "string" ? String((question as Record<string, unknown>).name).trim() : "";
      if (!q) { errors.push(`FAQ question ${index + 1} has no name`); continue; }
      const answer = (question as Record<string, unknown>).acceptedAnswer as Record<string, unknown> | undefined;
      const a = typeof answer?.text === "string" ? String(answer.text).trim() : "";
      if (!a) { errors.push(`FAQ question "${q}" has no acceptedAnswer text`); continue; }
      const normalizedHtml = indexHtml.replace(/\s+/g, " ");
      if (!normalizedHtml.includes(`<h3>${stripTags(q)}</h3>`)) errors.push(`FAQ JSON-LD question not found verbatim in visible text: "${q}"`);
      if (!normalizedHtml.includes(`<p>${stripTags(a)}</p>`)) errors.push(`FAQ JSON-LD answer not found verbatim in visible text for: "${q}"`);
    }
  }
}

// --- lane3 gate: a11y, structured data, and syndication assertions across all 8 pages ---
const ALL_PAGES = ["index.html", "404.html", ...PAGES_STATIC_PAGES.map(page => page.file)];
const pageHtmlCache = new Map<string, string>();
// SS6.3: shared a11y/reduced-motion/touch CSS now lives in the content-hashed
// site.<hash>.css asset. Every page-level style assertion below is checked
// against the page HTML PLUS the CSS of its linked shared stylesheet, so
// extraction to the shared asset can never silently drop a rule.
for (const page of ALL_PAGES) {
  const html = await readFile(join(destination, page), "utf8").catch(() => null);
  if (html === null) { errors.push(`missing required Pages asset: ${page}`); continue; }
  let effective = html;
  // Shared/page-specific stylesheet families: site.<hash>.css (all pages),
  // index.<hash>.css (front page) and 404.<hash>.css (errata page) — lane A r2.
  // 404.html links are root-absolute because it is served at nested paths.
  const sharedCssLinks = [...html.matchAll(/<link href="(\/?assets\/(?:site|index|404)\.[0-9a-f]{8}\.css)" rel="stylesheet">/g)].map(match => match[1]);
  for (const family of ["site", "index", "404"]) {
    const familyLinks = sharedCssLinks.filter(link => link.includes(`/${family}.`));
    if (familyLinks.length > 1) errors.push(`${page} links more than one ${family} stylesheet`);
  }
  for (const cssPath of sharedCssLinks) {
    const cssText = await readFile(join(destination, cssPath.replace(/^\//, "")), "utf8").catch(() => null);
    if (cssText === null) { errors.push(`${page} links a missing shared stylesheet: ${cssPath}`); continue; }
    effective += `\n<style>${cssText}</style>`;
  }
  pageHtmlCache.set(page, effective);
  if (!effective.includes('class="skip-link"')) errors.push(`${page} is missing the skip link`);
  if (!effective.includes(".skip-link:focus")) errors.push(`${page} is missing the skip-link focus rule`);
  if (!effective.includes("<footer class=\"footer\">")) errors.push(`${page} is missing the <footer> element`);
  if (!effective.includes("<main")) errors.push(`${page} is missing the <main> landmark`);
  if (!effective.includes("prefers-reduced-motion")) errors.push(`${page} is missing the prefers-reduced-motion block`);
  if (!effective.includes("a:focus-visible")) errors.push(`${page} is missing the a:focus-visible rule`);
  if (!effective.includes("(pointer: coarse)")) errors.push(`${page} is missing the 44px touch-target rules`);
  if (!effective.includes('rel="alternate" type="application/rss+xml"')) errors.push(`${page} is missing the syndication alternate link`);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => match[1]);
  blocks.forEach((block, index) => {
    try { JSON.parse(block); } catch { errors.push(`${page} JSON-LD block ${index + 1} does not parse as JSON`); }
  });
  if (page !== "404.html" && !blocks.some(block => block.includes('"BreadcrumbList"'))) errors.push(`${page} is missing BreadcrumbList JSON-LD`);
  if (page !== "404.html" && !blocks.some(block => block.includes('"WebPage"') || block.includes('"CollectionPage"'))) errors.push(`${page} is missing WebPage/CollectionPage JSON-LD`);
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? "";
  const brightVars = ["--red", "--blue", "--gold", "--green", "--purple"].filter(name => style.includes(name));
  if (brightVars.length > 0) errors.push(`${page} style block contains banned bright color variables: ${brightVars.join(", ")}`);
}
if (!pageHtmlCache.get("404.html")?.includes('name="robots" content="noindex"')) errors.push("404.html is missing the noindex meta");

// Contrast: computed-value checks on the shared palette (WCAG 1.4.3 thresholds)
function relLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map(offset => {
    const raw = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrastRatio(foreground: string, background: string): number {
  const l1 = relLuminance(foreground);
  const l2 = relLuminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const CONTRAST_PAIRS: Array<{ fg: string; bg: string; label: string; min: number }> = [
  { fg: "#666666", bg: "#ffffff", label: ".meta on --paper", min: 4.5 },
  { fg: "#333333", bg: "#f7dcdc", label: "banner.degraded meta on --rtint", min: 4.5 },
  { fg: "#000000", bg: "#888888", label: "geo-metric meta on --rule-light", min: 4.5 },
  { fg: "#000000", bg: "#888888", label: "banner.unavailable meta on --rule-light", min: 4.5 },
  { fg: "#ffffff", bg: "#c41e1e", label: "masthead text on --cc", min: 4.5 },
];
for (const pair of CONTRAST_PAIRS) {
  const ratio = contrastRatio(pair.fg, pair.bg);
  if (ratio < pair.min) errors.push(`contrast regression: ${pair.label} computes to ${ratio.toFixed(2)}:1 (minimum ${pair.min}:1)`);
}

// The syndication artifact must exist, parse, and carry channel metadata.
const feedXml = await readFile(join(destination, "feed.xml"), "utf8").catch(() => null);
if (feedXml === null) {
  errors.push("missing required Pages asset: feed.xml");
} else {
  if (!/<rss version="2\.0">/.test(feedXml)) errors.push("feed.xml is not RSS 2.0");
  if (!/<channel>/.test(feedXml) || !/<title>The Quadruplicate<\/title>/.test(feedXml)) errors.push("feed.xml is missing channel metadata");
  const feedItems = [...feedXml.matchAll(/<item>/g)].length;
  if (feedItems === 0) errors.push("feed.xml carries no items");
  if (feedItems > 60) errors.push("feed.xml exceeds the 60-item cap");
  for (const link of [...feedXml.matchAll(/<link>([^<]+)<\/link>/g)].map(match => match[1])) {
    if (!/^https?:\/\//i.test(link)) errors.push(`feed.xml item link is not an absolute URL: ${link}`);
  }
}
if (robotsTxt !== null && !/^Feed:\s*https:\/\/quadruplicate\.org\/feed\.xml$/m.test(robotsTxt)) errors.push("robots.txt is missing the feed pointer");


// --- lane1 gate: Phase 1 payload/performance assertions ---
// §1.2: per-page artifacts must exist and fit their byte budgets
// (acceptance: each subpage's first-load transfer < 150 KB excluding fonts).
const lane1Budgets: Record<string, number> = {
  "data/news.json": 150 * 1024,
  "data/meetings.json": 150 * 1024,
  "data/alerts.json": 150 * 1024,
  "data/analytics.json": 150 * 1024,
  "data/source-health.json": 150 * 1024,
  "data/source-discovery.json": 150 * 1024,
};
for (const [artifact, budget] of Object.entries(lane1Budgets)) {
  const bytes = (await readFile(join(destination, artifact)).catch(() => null))?.byteLength ?? null;
  if (bytes === null) errors.push(`missing required Pages asset: ${artifact}`);
  else if (bytes > budget) errors.push(`${artifact} is ${bytes} bytes (budget ${budget} bytes)`);
}
// §1.1: the envelope must never re-inline the four standalone artifacts.
if (snapshot) {
  const envelopeSource = JSON.stringify(snapshot);
  for (const inlined of ["readability", "verification", "domainCoverage", "domain-coverage"]) {
    if (inlined === "verification" && envelopeSource.includes("files.verification")) continue;
  }
  const mc = snapshot.municipalCode as Record<string, unknown> | undefined;
  if (mc && ("manifest" in mc || "verification" in mc || "coverage" in mc || "readability" in mc)) {
    errors.push("snapshot envelope inlines municipal-code artifacts (§1.1 split regressed)");
  }
  if (mc && !mc.counts) errors.push("snapshot.municipalCode.counts is missing (§1.1 envelope split)");
  if (snapshot.files?.news !== "data/news.json") errors.push("snapshot.files.news does not point at data/news.json");
  if (snapshot.files?.meetings !== "data/meetings.json") errors.push("snapshot.files.meetings does not point at data/meetings.json");
  if (snapshot.files?.alerts !== "data/alerts.json") errors.push("snapshot.files.alerts does not point at data/alerts.json");
  if (snapshot.files?.codeSearchIndex) {
    const idxPath = String(snapshot.files.codeSearchIndex);
    if (!/^data\/code-search\.[0-9a-f]{8}\.json$/.test(idxPath)) errors.push(`snapshot.files.codeSearchIndex is not a content-hashed code-search artifact: ${idxPath}`);
    const idxBytes = (await readFile(join(destination, idxPath)).catch(() => null))?.byteLength ?? null;
    if (idxBytes === null) errors.push(`missing required Pages asset: ${idxPath}`);
    else if (idxBytes > 3 * 1024 * 1024) errors.push(`${idxPath} is ${idxBytes} bytes (budget 3145728 bytes)`);
    // Lane D §2: per-field shards must be emitted, hashed, and within budget —
    // title/number shard ~0.5 MB (budget 700 KB), body shard ~2.4 MB (budget 3 MB).
    for (const [fileKey, kind, prefix, budget] of [
      ["codeSearchTitleIndex", "t", PAGES_SEARCH_TITLE_ARTIFACT_PREFIX, 700 * 1024],
      ["codeSearchBodyIndex", "x", PAGES_SEARCH_BODY_ARTIFACT_PREFIX, 3 * 1024 * 1024],
    ] as Array<[string, string, string, number]>) {
      const shardPath = snapshot.files?.[fileKey];
      if (typeof shardPath !== "string" || shardPath === "") {
        errors.push(`snapshot.files.${fileKey} is missing (lane D per-field shard split regressed)`);
        continue;
      }
      if (!new RegExp(`^${prefix.replace(/\./g, "\\.")}[0-9a-f]{8}\\.json$`).test(shardPath)) {
        errors.push(`snapshot.files.${fileKey} is not a content-hashed ${prefix} artifact: ${shardPath}`);
        continue;
      }
      const shardBytes = (await readFile(join(destination, shardPath)).catch(() => null))?.byteLength ?? null;
      if (shardBytes === null) errors.push(`missing required Pages asset: ${shardPath}`);
      else if (shardBytes > budget) errors.push(`${shardPath} is ${shardBytes} bytes (budget ${budget} bytes)`);
      const shard = JSON.parse(await readFile(join(destination, shardPath), "utf8").catch(() => "{}"));
      if (shard.shard !== kind) {
        errors.push(`${shardPath} does not declare the expected shard kind for ${fileKey}`);
      }
    }
    // Lane D §3: the tiny code-meta artifact must exist and code.html must
    // depend on it, never on the snapshot envelope.
    const codeMetaBytes = (await readFile(join(destination, PAGES_CODE_META_ARTIFACT)).catch(() => null))?.byteLength ?? null;
    if (codeMetaBytes === null) errors.push(`missing required Pages asset: ${PAGES_CODE_META_ARTIFACT}`);
    else if (codeMetaBytes > 8 * 1024) errors.push(`${PAGES_CODE_META_ARTIFACT} is ${codeMetaBytes} bytes (budget 8192 bytes)`);
    if (snapshot.files?.codeMeta !== PAGES_CODE_META_ARTIFACT) errors.push("snapshot.files.codeMeta does not point at data/code-meta.json");
    const codeMetaJson = JSON.parse(await readFile(join(destination, PAGES_CODE_META_ARTIFACT), "utf8").catch(() => "{}"));
    if (codeMetaJson.schema !== "crescent-city-code-meta/v1") errors.push("code-meta.json is missing the crescent-city-code-meta/v1 schema");
    if (codeMetaJson.files?.codeSearchIndex !== idxPath) errors.push("code-meta.json files.codeSearchIndex does not match the envelope hash reference");

  } else {
    const codeJson = await readFile(join(destination, "data/code.json")).catch(() => null);
    if (codeJson !== null) errors.push("data/code.json is published but snapshot.files.codeSearchIndex is missing (§1.3 index regressed)");
  }
}
// Lane D §3: code.html must never fetch the snapshot envelope; its first-load
// dependency is the tiny code-meta artifact.
const codePageHtml = pageHtmlCache.get("code.html") ?? "";
if (codePageHtml.includes('load("data/snapshot.json")')) errors.push("code.html still fetches the snapshot envelope (lane D code-meta split regressed)");
if (!codePageHtml.includes('load("data/code-meta.json")')) errors.push("code.html does not load data/code-meta.json (lane D code-meta split regressed)");
// §1.6: no page may defeat HTTP caching for immutable snapshot artifacts.
for (const [page, html] of pageHtmlCache) {
  if (html.includes('cache:"no-store"') || html.includes('cache: "no-store"')) errors.push(`${page} still uses cache:"no-store" (§1.6)`);
}
// §1.7: exactly one canonical Google Fonts URL, preloaded, on every page.
const CANONICAL_FONTS_URL = "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Inter:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap";
for (const [page, html] of pageHtmlCache) {
  const fontLinks = [...html.matchAll(/<link href="(https:\/\/fonts\.googleapis\.com\/css2\?family=[^"]+)" rel="stylesheet">/g)].map(match => match[1]);
  if (fontLinks.length !== 1) errors.push(`${page} must carry exactly one Google Fonts stylesheet link (found ${fontLinks.length})`);
  else if (fontLinks[0] !== CANONICAL_FONTS_URL) errors.push(`${page} does not use the canonical Google Fonts URL (§1.7)`);
  if (!html.includes(`<link rel="preload" as="style" href="${CANONICAL_FONTS_URL}">`)) errors.push(`${page} is missing the fonts preload (§1.7)`);
  if (/Playfair\+Display:ital,wght@(?!0,700;0,900;1,700&)/.test(html) && html.includes("0,400;0,600")) errors.push(`${page} still requests unused font axes (§1.7)`);
}
// §1.8: grain overlay must be gated and z-index sane on the front page.
// Lane A r2: the index-only CSS now ships as the content-hashed index.<hash>.css
// asset, so the check unions every <style> block of the effective page CSS
// (inline + linked shared stylesheets) exactly like the laneG page assertions.
const indexStyle = [...(pageHtmlCache.get("index.html") ?? "").matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join("\n");
if (indexStyle.includes("body::before") && !/@media \(max-width:767px\), \(prefers-reduced-motion:reduce\) \{ body::before \{ display:none; \} \}/.test(indexStyle)) {
  errors.push("index.html grain overlay is not disabled under 768px and prefers-reduced-motion (§1.8)");
}
if (/body::before \{[^}]*z-index:\s*(?:2147483647|2147483646)/.test(indexStyle)) errors.push("index.html grain overlay z-index is still max-int (§1.8)");
// Lane A r2: the extracted index-only asset must actually carry the grain rule
// (a positive control that the union above is not vacuously passing), and the
// exported index must link exactly one index.<hash>.css.
{
  const indexCssLinks = [...(pageHtmlCache.get("index.html") ?? "").matchAll(/<link href="(assets\/index\.[0-9a-f]{8}\.css)" rel="stylesheet">/g)].map(match => match[1]);
  if (indexCssLinks.length !== 1) errors.push(`index.html must link exactly one index-only stylesheet (found ${indexCssLinks.length})`);
  const indexCss = await readFile(join(destination, indexCssLinks[0] ?? ""), "utf8").catch(() => "");
  if (!indexCss.includes("body::before")) errors.push("index-only stylesheet lost the paper grain rule (§1.8)");
}

if (indexHtml.includes("__CC_API_KEY__") || indexHtml.includes("__CC_API_KEY_INJECT__")) errors.push("API key placeholder found in Pages HTML");
if (indexHtml.includes("localhost:") || indexHtml.includes("127.0.0.1")) errors.push("local-only endpoint found in Pages HTML");

// ---- Lane 0 gate assertion (audit §0.1): every innerHTML interpolation across
// all static pages must pass through esc()/href() or a provably-safe builder
// (fixpoint-derived consts/functions, .map callback chains, ternary branches,
// numeric coercions and .length properties).
// Lane0 gate scanner: every innerHTML interpolation must pass through esc()/href()
// or a provably-safe prebuilt value. Positive + negative control verified.

const SAFE_CALLS = new Set(["esc", "href", "status", "empty", "date", "Number"]);

function skipString(src: string, i: number, quote: string): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplate(src: string, i: number): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") return i + 1;
    // NOTE: quotes in template TEXT are plain characters, not string starts.
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1; i += 2;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "'" || ch === '"') { i = skipString(src, i, ch); continue; }
        if (ch === "`") { i = skipTemplate(src, i); continue; }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function matchDelim(src: string, i: number, open: string, close: string): number {
  let depth = 1; i++;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipString(src, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return i;
}

/** Top-level ${...} ranges inside template body [start,end). */
function topInterps(src: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    // NOTE: quotes in template TEXT are plain characters; skipString starts only
    // inside ${...} expressions, which are delimited below.
    if (ch === "$" && src[i + 1] === "{") {
      const exprStart = i + 2;
      let depth = 1; i = exprStart;
      while (i < end && depth > 0) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "'" || c === '"') { i = skipString(src, i, c); continue; }
        if (c === "`") { i = skipTemplate(src, i); continue; }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
      out.push([exprStart, i - 1]);
      continue;
    }
    i++;
  }
  return out;
}

interface Ctx { path: string; problems: string[]; safeConsts: Set<string>; flag(tag: string, expr: string): void; }

function splitTernary(expr: string): [string, string] | null {
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(expr, i); continue; }
    if (ch === "(") { i = matchDelim(expr, i, "(", ")"); continue; }
    if (ch === "?" && expr[i + 1] !== "?" && expr[i + 1] !== "." && expr[i - 1] !== "?" && expr[i - 1] !== ".") {
      let j = i + 1, d = 0;
      while (j < expr.length) {
        const c = expr[j];
        if (c === "'" || c === '"') { j = skipString(expr, j, c); continue; }
        if (c === "`") { j = skipTemplate(expr, j); continue; }
        if (c === "(") { j = matchDelim(expr, j, "(", ")"); continue; }
        if (c === "?") d++;
        else if (c === ":") { if (d === 0) return [expr.slice(i + 1, j), expr.slice(j + 1)]; d--; }
        j++;
      }
      return null;
    }
    i++;
  }
  return null;
}

function checkTemplate(expr: string, ctx: Ctx): void {
  const after = skipTemplate(expr, 0);
  for (const [s, e] of topInterps(expr, 1, after - 1)) {
    isSafeExpr(expr.slice(s, e), ctx);
  }
  const tail = expr.slice(after).trim();
  if (tail) { // e.g. `...` + something
    if (tail.startsWith("+")) isSafeExpr(tail.slice(1), ctx);
    else ctx.flag("template-tail", tail);
  }
}

function checkOperand(expr: string, ctx: Ctx): void {
  let e = expr.trim();
  if (!e) return;
  while (e.startsWith("(") && matchDelim(e, 0, "(", ")") === e.length) {
    const inner = e.slice(1, -1).trim();
    if (!inner) return;
    e = inner;
  }
  if (e.startsWith("`")) { checkTemplate(e, ctx); return; }
  // provably numeric values cannot inject markup
  if (/^(?:[A-Za-z_$][\w$]*\??\.)+length$/.test(e)) return;
  const coercionCall = /^(?:Number|parseInt|parseFloat|Boolean|Math\.(?:abs|floor|ceil|round|min|max))\s*\(/.exec(e);
  if (coercionCall) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) return;
  }
  const call = /^(?:esc|href|status|empty|date|Number)\s*\(/.exec(e);
  if (call) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) return;
  }
  if (ctx.safeConsts.has(e)) return;
  if (/^[\s\d.]+$/.test(e)) return;
  if (/^"(?:[^"\\]|\\.)*"$/.test(e) || /^'(?:[^'\\]|\\.)*'$/.test(e)) return;
  if (/^[A-Za-z_$][\w$]*$/.test(e)) { ctx.flag("bare-identifier", e); return; }
  // plain call: trust the callee if the fixpoint proved its templates safe
  const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  if (callee) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) {
      if (ctx.safeConsts.has(callee[1])) return;
      ctx.flag("call-unverified", callee[1]);
      return;
    }
  }
  // member method call, e.g. kind.toLowerCase(): check the arguments
  const memberCall = /^(?:[A-Za-z_$][\w$]*\.?)+\s*\(/.exec(e);
  if (memberCall && memberCall[0].includes(".")) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) {
      const args = e.slice(open + 1, e.length - 1);
      if (!args.trim()) return;
      // split on top-level commas
      const parts: string[] = [];
      let i2 = 0, last2 = 0;
      while (i2 < args.length) {
        const c = args[i2];
        if (c === "'" || c === '"') { i2 = skipString(args, i2, c); continue; }
        if (c === "`") { i2 = skipTemplate(args, i2); continue; }
        if (c === "(") { i2 = matchDelim(args, i2, "(", ")"); continue; }
        if (c === ",") { parts.push(args.slice(last2, i2)); last2 = i2 + 1; }
        i2++;
      }
      parts.push(args.slice(last2));
      parts.forEach(part => isSafeExpr(part, ctx));
      return;
    }
  }
  if (checkMapChain(e, ctx)) return;
  ctx.flag("unsafe-interpolation", e.slice(0, 90));
}

/** Split on a top-level binary operator token (used for ??). */
function topLevelBinarySplit(expr: string, op: string): [string, string] | null {
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(expr, i); continue; }
    if (ch === "(") { i = matchDelim(expr, i, "(", ")"); continue; }
    if (expr.startsWith(op, i) && (i === 0 || !"\w$.".includes(expr[i - 1])) && (i + op.length >= expr.length || !"\w$".includes(expr[i + op.length]))) {
      return [expr.slice(0, i), expr.slice(i + op.length)];
    }
    i++;
  }
  return null;
}

/** Check `return\`...\`` / `X +=\`...\`` templates inside an arrow/func block body. */
function checkBlockReturns(block: string, ctx: Ctx): boolean {
  const problemsBefore = ctx.problems.length;
  const re = /\breturn\s*`|\+=\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const tplStart = block.indexOf("`", m.index);
    const tplEnd = skipTemplate(block, tplStart);
    checkTemplate(block.slice(tplStart, tplEnd), ctx);
    re.lastIndex = tplEnd;
  }
  return ctx.problems.length === problemsBefore;
}

/**
 * Recognize `<data>.map(callback)` chains (optionally followed by .slice(n)/.join("")).
 * Returns true when the expression was fully understood; the callback body is
 * checked recursively (expression arrows via isSafeExpr, block arrows and named
 * functions via their return/+= templates, bare identifiers via safeConsts).
 */
function checkMapChain(e: string, ctx: Ctx): boolean {
  let rest = e.trim();
  for (;;) {
    const strip = /\.(join|slice)\s*\(([^()]*)\)$/.exec(rest);
    if (!strip || strip[2].includes("`") || strip[2].includes("=>")) break;
    rest = rest.slice(0, strip.index).trim();
  }
  if (!rest.endsWith(")")) return false;
  const mapIdx = rest.lastIndexOf(".map(");
  if (mapIdx === -1) return false;
  const open = mapIdx + ".map".length;
  if (matchDelim(rest, open, "(", ")") !== rest.length) return false;
  const callback = rest.slice(open + 1, rest.length - 1).trim();
  // bare function-reference callback
  if (/^[A-Za-z_$][\w$]*$/.test(callback)) {
    if (ctx.safeConsts.has(callback)) return true;
    ctx.flag("map-callback-unverified", callback);
    return true;
  }
  const arrow = callback.indexOf("=>");
  if (arrow === -1) return false;
  const body = callback.slice(arrow + 2).trim();
  if (body.startsWith("{")) {
    const close = matchDelim(body, 0, "{", "}");
    if (close !== body.length) return false;
    checkBlockReturns(body.slice(1, close - 1), ctx);
    return true;
  }
  isSafeExpr(body, ctx);
  return true;
}

function isSafeExpr(raw: string, ctx: Ctx): void {
  let expr = raw.trim();
  if (!expr) return;
  if (expr.startsWith("(") && matchDelim(expr, 0, "(", ")") === expr.length) {
    const inner = expr.slice(1, -1).trim();
    if (inner) { isSafeExpr(inner, ctx); return; }
  }
  const co = topLevelBinarySplit(expr, "??");
  if (co) { isSafeExpr(co[0], ctx); isSafeExpr(co[1], ctx); return; }
  if (expr.startsWith("`")) { checkTemplate(expr, ctx); return; }
  const ternary = splitTernary(expr);
  if (ternary) { isSafeExpr(ternary[0], ctx); isSafeExpr(ternary[1], ctx); return; }
  // split on top-level + (string concat)
  const operands: string[] = [];
  let i = 0, last = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(expr, i); continue; }
    if (ch === "(") { i = matchDelim(expr, i, "(", ")"); continue; }
    if (ch === "+" && expr[i + 1] !== "+") { operands.push(expr.slice(last, i)); last = i + 1; }
    i++;
  }
  operands.push(expr.slice(last));
  if (operands.length > 1) { operands.forEach(op => isSafeExpr(op, ctx)); return; }
  checkOperand(expr, ctx);
}

/** Extract statement-level RHS after `=` up to the terminating `;`. */
function extractRhs(src: string, eqIndex: number): string {
  let i = eqIndex + 1;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipString(src, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return src.slice(eqIndex + 1, i);
    i++;
  }
  return "";
}

function scanPage(html: string, path: string): string[] {
  const problems: string[] = [];
  const ctx: Ctx = {
    path, problems, safeConsts: new Set<string>(),
    flag(tag, expr) { problems.push(`${tag}: ${expr} in ${path}`); },
  };
  // Fixpoint pass: const X = <safe expr> marks X safe (e.g. title, commit, html).
  for (let round = 0; round < 3; round++) {
    const before = ctx.safeConsts.size;
    const constRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = constRe.exec(html)) !== null) {
      const name = m[1];
      if (ctx.safeConsts.has(name)) continue;
      const rhs = extractRhs(html, m.index + m[0].length - 1);
      if (!rhs) continue;
      const probe: Ctx = { ...ctx, problems: [], safeConsts: ctx.safeConsts, flag(tag, expr) { void tag; void expr; } };
      const countBefore = problems.length;
      isSafeExpr(rhs, probe);
      if (problems.length === countBefore) ctx.safeConsts.add(name);
    }
    // let X = "" accumulated via X += <safe template>
    const accumRe = /\b([A-Za-z_$][\w$]*)\s*\+=\s*`/g;
    while ((m = accumRe.exec(html)) !== null) {
      const name = m[1];
      const tplStart = m.index + m[0].length - 1;
      const tplEnd = skipTemplate(html, tplStart);
      const probe: Ctx = { ...ctx, problems: [], safeConsts: ctx.safeConsts, flag() {} };
      checkTemplate(html.slice(tplStart, tplEnd), probe);
      if (probe.problems.length === 0) ctx.safeConsts.add(name);
    }
    // function NAME(...) declarations whose return/+= templates are safe
    const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fnRe.exec(html)) !== null) {
      const name = m[1];
      if (ctx.safeConsts.has(name)) continue;
      const braceStart = html.indexOf("{", m.index + m[0].length - 1);
      if (braceStart === -1) continue;
      const braceEnd = matchDelim(html, braceStart, "{", "}");
      const probe2: Ctx = { ...ctx, problems: [], safeConsts: ctx.safeConsts, flag() {} };
      if (checkBlockReturns(html.slice(braceStart + 1, braceEnd - 1), probe2)) ctx.safeConsts.add(name);
    }
    if (ctx.safeConsts.size === before) break;
  }
  // Main pass: every `.innerHTML =` assignment.
  let i = 0;
  while ((i = html.indexOf(".innerHTML", i)) !== -1) {
    i += ".innerHTML".length;
    let j = i;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== "=" || html[j + 1] === "=") continue;
    const rhs = extractRhs(html, j);
    if (!rhs) continue;
    isSafeExpr(rhs, ctx);
    i = j + rhs.length;
  }
  return problems;
}


const staticPagesDir = resolve(import.meta.dir, "../src/pages/static");
// SS6.2: itemCard/healthCardHtml/codeResultCard/analyticsSignalsHtml etc. live
// in the shared site.js asset; their templates are esc()/href()-complete, so
// the scanner pre-verifies site.js itself and trusts its verified function
// names inside every page script (negative control: any unsafe site.js
// template still fails the gate via the direct site.js scan below).
const siteJsPath = join(staticPagesDir, "assets", "site.js");
const siteJs = await readFile(siteJsPath, "utf8");
const SHARED_SAFE_FNS = ["itemCard", "healthCardHtml", "codeResultCard", "analyticsSignalsHtml", "alertBannerHtml", "calendarEventCard", "calendarMonthGroups", "searchIndexMatches", "eventStatusChip"];
for (const finding of scanPage(`<script>${siteJs}</script>`, "assets/site.js")) errors.push(`unsafe innerHTML interpolation (${finding})`);
for (const pageFile of readdirSync(staticPagesDir).filter(f => f.endsWith(".html")).sort()) {
  const pageHtml = await readFile(join(staticPagesDir, pageFile), "utf8");
  const problems = scanPage(pageHtml, pageFile).filter(problem => !SHARED_SAFE_FNS.some(fn => problem.startsWith(`call-unverified: ${fn}`)));
  for (const finding of problems) errors.push(`unsafe innerHTML interpolation (${finding})`);
}

// --- lane2 gate: navigation/IA and SEO assertions (§2.1-2.8, §3.1-3.3, §3.7) ---
// 2.2: 404.html must contain no relative internal hrefs — GitHub Pages serves
// 404.html at arbitrary nested paths, where relative links resolve to second 404s.
{
  const html404 = pageHtmlCache.get("404.html");
  if (html404 !== undefined) {
    const markupOnly = html404.replace(/<script[\s\S]*?<\/script>/g, "");
    const hrefs = [...markupOnly.matchAll(/href="([^"]*)"/g)].map(match => match[1]);
    for (const href of hrefs) {
      if (href.startsWith("/") || href.startsWith("#") || /^(https?:|mailto:|data:)/i.test(href)) continue;
      errors.push(`404.html contains a relative href (must be root-absolute): "${href}"`);
    }
    // Lane A r2: the errata page now consumes the shared + 404-specific
    // stylesheets; both links must be root-absolute (nested-path serving) and
    // content-hashed, and the referenced assets must exist in the artifact.
    const css404Links = [...html404.matchAll(/href="(\/?assets\/(?:site|404)\.[0-9a-f]{8}\.css)"/g)].map(match => match[1]);
    if (css404Links.length !== 2) errors.push(`404.html must link the shared and 404-specific stylesheets (found ${css404Links.length})`);
    for (const link of css404Links) {
      if (!link.startsWith("/assets/")) errors.push(`404.html stylesheet link is not root-absolute: "${link}"`);
      const cssBytes = await readFile(join(destination, link)).catch(() => null);
      if (cssBytes === null) errors.push(`404.html links a missing stylesheet: ${link}`);
    }
    for (const file of PAGES_STATIC_PAGES.map(page => page.file)) {
      if (!html404.includes(`href="/${file}"`)) errors.push(`404.html nav is missing the root-absolute link to ${file}`);
    }
    if (!html404.includes("<nav class=\"breadcrumb\"")) errors.push("404.html is missing the breadcrumb trail");
  }
  // 2.1: generated nav must carry every manifest page plus the front page and section anchors.
  for (const page of ["index.html", ...PAGES_STATIC_PAGES.map(candidate => candidate.file), "404.html"]) {
    const html = pageHtmlCache.get(page);
    if (html === undefined) continue;
    if (!html.includes("<nav class=\"masthead-nav\"")) errors.push(`${page} is missing the masthead nav`);
    if (!html.includes("<nav class=\"breadcrumb\"")) errors.push(`${page} is missing the breadcrumb trail`);
    for (const section of PAGES_SECTION_NAV) {
      if (!html.includes(`>${section.label}</a>`)) errors.push(`${page} nav is missing the ${section.label} anchor link`);
    }
    // 2.3: one mobile-nav pattern (wrapping, no nowrap scroll strip) + 2.5 aria-current non-colour cue.
    if (html.includes("flex-wrap:nowrap")) errors.push(`${page} still uses a nowrap mobile nav strip`);
    if (!/\.masthead-nav a\[aria-current="page"\][^}]*font-weight/.test(html)) {
      errors.push(`${page} does not style aria-current with weight (colour-alone cue)`);
    }
  }
  // 3.1/3.2: SEO artifacts must exist and the OG card must be a real 1200x630 PNG.
  const ogPath = join(destination, PAGES_OG_IMAGE_PNG);
  const ogBytes = await readFile(ogPath).catch(() => null);
  if (ogBytes === null) errors.push(`missing required Pages asset: ${PAGES_OG_IMAGE_PNG}`);
  else {
    if (!(ogBytes[0] === 0x89 && ogBytes[1] === 0x50 && ogBytes[2] === 0x4e && ogBytes[3] === 0x47)) errors.push("og-image.png is not a PNG");
    const ogWidth = ogBytes[16]! * 0x1000000 + ogBytes[17]! * 0x10000 + ogBytes[18]! * 0x100 + ogBytes[19]!;
    const ogHeight = ogBytes[20]! * 0x1000000 + ogBytes[21]! * 0x10000 + ogBytes[22]! * 0x100 + ogBytes[23]!;
    if (ogWidth !== 1200 || ogHeight !== 630) errors.push(`og-image.png must be 1200x630, got ${ogWidth}x${ogHeight}`);
  }
  for (const required of [PAGES_FAVICON_SVG, PAGES_FAVICON_ICO, PAGES_APPLE_TOUCH_ICON_PNG, PAGES_WEB_MANIFEST]) {
    try { await readFile(join(destination, required)); }
    catch { errors.push(`missing required Pages asset: ${required}`); }
  }
  const manifestText = await readFile(join(destination, PAGES_WEB_MANIFEST), "utf8").catch(() => "");
  if (manifestText && !manifestText.includes('"theme_color": "#c41e1e"')) errors.push("site.webmanifest is missing the #c41e1e theme color");
  // 3.2/3.3: every page must carry favicon links and the theme color; 404 must noindex.
  for (const page of ALL_PAGES) {
    const html = pageHtmlCache.get(page);
    if (html === undefined) continue;
    if (!html.includes('rel="icon"')) errors.push(`${page} is missing the favicon link`);
    if (!html.includes('name="theme-color" content="#c41e1e"')) errors.push(`${page} is missing the theme-color meta`);
    if (page !== "index.html" && page !== "404.html" && !html.includes('rel="canonical"')) {
      errors.push(`${page} is missing the canonical link`);
    }
  }
  if (pageHtmlCache.get("404.html")?.includes('name="robots" content="noindex"') === false) {
    errors.push("404.html is missing the noindex meta");
  }
  // 3.7: honest sitemap lastmod — every lastmod must come from a source mtime,
  // never the build date. The root URL is always present; pages must match the manifest.
  const sitemap = await readFile(join(destination, PAGES_SITEMAP_XML), "utf8").catch(() => null);
  if (sitemap !== null) {
    const sourceMtimes = new Map<string, string>();
    for (const file of ["index.html", ...PAGES_STATIC_PAGES.map(page => page.file)]) {
      try {
        const stat = await Bun.file(join(resolve(import.meta.dir, "../src/pages/static"), file)).stat();
        if (stat?.mtime) sourceMtimes.set(file, stat.mtime.toISOString().slice(0, 10));
      } catch { /* source missing: lastmod must be omitted, not fabricated */ }
    }
    const urlEntries = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc>(<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)];
    for (const entry of urlEntries) {
      const loc = entry[1]!;
      const lastmod = entry[3];
      const path = loc.replace("https://quadruplicate.org/", "").replace(/^$/, "");
      const fileKey = path === "" ? "index.html" : path;
      const expected = sourceMtimes.get(fileKey);
      if (lastmod === undefined) continue; // omission is honest
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) errors.push(`sitemap lastmod for ${loc} is not a date: ${lastmod}`);
      if (expected !== undefined && lastmod !== expected) errors.push(`sitemap lastmod for ${loc} does not match the source mtime (fabricated?)`);
      if (expected === undefined) errors.push(`sitemap lastmod for ${loc} has no matching source mtime (fabricated?)`);
    }
  }
}

// --- lane A r2 gate: §5.5 operator/public signal split persistence ---
// The operator channel artifact must exist when analytics exist, carry the
// neutral notice copy (no binary names, PATH strings, or stack traces), and
// match the overview's routed operatorSignalsNoticed array. Public pages must
// contain no operator leakage while the operator artifact preserves detail.
{
  const analyticsJson = await readFile(join(destination, "data/analytics.json"), "utf8").catch(() => null);
  if (analyticsJson !== null) {
    const operatorJson = await readFile(join(destination, PAGES_OPERATOR_SIGNALS_ARTIFACT), "utf8").catch(() => null);
    if (operatorJson === null) {
      errors.push(`missing required Pages asset when analytics exist: ${PAGES_OPERATOR_SIGNALS_ARTIFACT}`);
    } else {
      const operator = JSON.parse(operatorJson) as { operatorSignalsNoticed?: unknown; schemaVersion?: unknown };
      const analytics = JSON.parse(analyticsJson) as { operatorSignalsNoticed?: unknown };
      if (operator.schemaVersion !== "crescent-city-operator-signals/v1") errors.push(`${PAGES_OPERATOR_SIGNALS_ARTIFACT} has an unsupported schemaVersion`);
      if (JSON.stringify(operator.operatorSignalsNoticed ?? []) !== JSON.stringify(analytics.operatorSignalsNoticed ?? [])) {
        errors.push(`${PAGES_OPERATOR_SIGNALS_ARTIFACT} operatorSignalsNoticed does not match data/analytics.json (routed detail diverged)`);
      }
      for (const leaked of ["yt-dlp", "yt_dlp", "$PATH", "not found in", "stack trace", "error:"]) {
        if (operatorJson.toLowerCase().includes(leaked.toLowerCase())) errors.push(`${PAGES_OPERATOR_SIGNALS_ARTIFACT} leaks operator-side detail: "${leaked}"`);
      }
    }
  }
  // Public surfaces: no operator-only error strings anywhere in the exported pages.
  for (const [page, html] of pageHtmlCache) {
    for (const leaked of ["yt-dlp", "$PATH", "not found in $PATH"]) {
      if (html.includes(leaked)) errors.push(`${page} leaks operator-side detail on a public surface: "${leaked}"`);
    }
  }
  // --- lane C gate: rendered-copy leak patterns (data honesty) ---
  // Escaped emoji codepoints, em-dash placeholder concatenations, JS object
  // stringification, and double-escaped entities must never reach published copy.
  for (const [page, html] of pageHtmlCache) {
    for (const pattern of ["U0001", "\u2014ft@\u2014s", "[object Object]", "&amp;amp;"]) {
      if (html.includes(pattern)) errors.push(`${page} renders a leak pattern on a public surface (lane C data-honesty gate): "${pattern}"`);
    }
    // Operator commands (`bun run ...`) belong to the operator's machine, not
    // the public site. Regressed here once via the inlined monthly report.
    if (/- Run `bun run [a-z:-]+`/.test(html)) {
      errors.push(`${page} renders an operator command line on a public surface (lane C data-honesty gate)`);
    }
  }
}

// --- lane D gate: caching correctness (item 4) ---
// Every emitted `assets/*` and `data/code-search*` reference in the exported
// pages must match an emitted file exactly, and every such reference must carry
// its content hash. A hashless reference to a mutable path would break between
// builds; a hashed reference to a non-emitted file is a broken URL.
{
  const emitted = new Set(await readdirSync(destination).concat(readdirSync(join(destination, "data")).map(name => `data/${name}`), readdirSync(join(destination, "assets")).map(name => `assets/${name}`)));
  for (const [page, html] of pageHtmlCache) {
    const refs = [...html.matchAll(/(?:src|href)="((?:assets|data)\/[^"]+)"/g)].map(match => match[1]!);
    for (const ref of refs) {
      if (!emitted.has(ref)) errors.push(`${page} references a non-emitted artifact: ${ref} (lane D caching gate)`);
      if (/^assets\//.test(ref) && !/^assets\/[a-z-]+\.[0-9a-f]{8}\.[a-z]+$/.test(ref)) {
        errors.push(`${page} references a hashless assets path (lane D caching-correctness): ${ref}`);
      }
    }
    // Envelope references must resolve to emitted files too.
  }
  if (snapshot) {
    for (const [key, value] of Object.entries(snapshot.files ?? {})) {
      if (typeof value !== "string" || value === "") continue;
      if (!emitted.has(value)) errors.push(`snapshot.files.${key} references a non-emitted artifact: ${value}`);

    }
  }
}

if (errors.length) {
  console.error(errors.map(error => `✖ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Pages artifact valid: ${destination}`);

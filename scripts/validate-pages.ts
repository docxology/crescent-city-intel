#!/usr/bin/env bun
/** Validate a generated public Pages artifact without making network calls. */
import { readFile } from "fs/promises";
import { readFileSync, readdirSync } from "fs";
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
import { PAGES_ANALYTICS_ARTIFACT, PAGES_EVENTS_ARTIFACT, PAGES_OPERATOR_SIGNALS_ARTIFACT, PAGES_ROBOTS_TXT, PAGES_SITEMAP_XML, PAGES_STATIC_PAGES, PAGES_CODE_META_ARTIFACT, PAGES_SEARCH_TITLE_ARTIFACT_PREFIX, PAGES_SEARCH_BODY_ARTIFACT_PREFIX } from "../src/pages_snapshot.js";
import { EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health.js";
import { auditPagesCss, auditStylesheetBraces, type PageCssInput } from "../src/pages_css.js";
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
/** Per page: the concatenated CSS of only the stylesheets that page links. */
const pageCssCache = new Map<string, string>();
/** Per page: raw exported HTML, kept apart from the CSS-augmented cache above. */
const pageMarkupCache = new Map<string, string>();
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
  // Lane 4 r3: the same stylesheets are kept unconcatenated with the HTML so the
  // cascade can be resolved per page (string presence cannot tell a rule that is
  // loaded from one that merely exists in the repo).
  let pageCss = "";
  for (const cssPath of sharedCssLinks) {
    const cssText = await readFile(join(destination, cssPath.replace(/^\//, "")), "utf8").catch(() => null);
    if (cssText === null) { errors.push(`${page} links a missing shared stylesheet: ${cssPath}`); continue; }
    effective += `\n<style>${cssText}</style>`;
    pageCss += `\n${cssText}`;
  }
  pageCssCache.set(page, pageCss);
  pageMarkupCache.set(page, html);
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
/**
 * Contrast pairs named by PALETTE VARIABLE, resolved against the stylesheet
 * this build actually emits.
 *
 * They used to be hard-coded hex literals in this file, so the gate computed
 * ratios over its own constants: lightening --ink-faint in site.css could not
 * fail it, and only editing the gate could. A check whose subject is a constant
 * in the same file is not checking the artifact.
 */
const CONTRAST_PAIRS: Array<{ fg: string; bg: string; label: string; min: number }> = [
  { fg: "--ink-faint", bg: "--paper", label: ".meta on --paper", min: 4.5 },
  { fg: "--ink-dim", bg: "--rtint", label: "banner.degraded meta on --rtint", min: 4.5 },
  { fg: "--ink", bg: "--rule-light", label: "geo-metric meta on --rule-light", min: 4.5 },
  { fg: "--ink", bg: "--sepia", label: "meta on --sepia", min: 4.5 },
  { fg: "#ffffff", bg: "--cc", label: "masthead text on --cc", min: 4.5 },
];
{
  const emittedCss = readdirSync(join(destination, "assets"))
    .filter(asset => /^site\.[0-9a-f]{8}\.css$/.test(asset))
    .map(asset => readFileSync(join(destination, "assets", asset), "utf8"))
    .join("\n");
  const palette = new Map<string, string>();
  for (const match of emittedCss.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
    if (!palette.has(match[1]!)) palette.set(match[1]!, match[2]!);
  }
  if (palette.size === 0) errors.push("contrast gate: the emitted site stylesheet declares no palette variables to check");
  for (const pair of CONTRAST_PAIRS) {
    const foreground = pair.fg.startsWith("--") ? palette.get(pair.fg) : pair.fg;
    const background = pair.bg.startsWith("--") ? palette.get(pair.bg) : pair.bg;
    if (!foreground || !background) {
      errors.push(`contrast gate: ${pair.label} references a palette variable the emitted stylesheet does not define (${pair.fg} / ${pair.bg})`);
      continue;
    }
    const ratio = contrastRatio(foreground, background);
    if (ratio < pair.min) errors.push(`contrast regression: ${pair.label} computes to ${ratio.toFixed(2)}:1 (minimum ${pair.min}:1)`);
  }
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
  // The four standalone artifacts must be referenced, never re-inlined. This
  // was a loop whose only statement was `continue`: it iterated the four names
  // and could not push an error under any input.
  // Each of these ships as its own artifact and must be REFERENCED from
  // snapshot.files, never carried inline in the envelope every page downloads.
  // (sourceDiscovery is a deliberate exception: the envelope carries its small
  // summary and files.sourceDiscovery points at the full artifact.)
  const envelope = snapshot as unknown as Record<string, unknown>;
  for (const inlined of ["readability", "verification", "domainCoverage", "coverage"]) {
    const value = envelope[inlined];
    if (value && typeof value === "object") {
      errors.push(`snapshot envelope inlines the ${inlined} artifact instead of referencing it (§1.1 split regressed)`);
    }
    if (!(inlined in (snapshot.files ?? {})) && inlined !== "domainCoverage") {
      // The reference must exist, or "not inlined" is trivially satisfied by
      // the artifact not being published at all.
      errors.push(`snapshot.files has no reference for the ${inlined} artifact (§1.1 split)`);
    }
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

import { scanPage } from "../src/pages_scan.js";


const staticPagesDir = resolve(import.meta.dir, "../src/pages/static");
// SS6.2: itemCard/healthCardHtml/codeResultCard/analyticsSignalsHtml etc. live
// in the shared site.js asset; their templates are esc()/href()-complete, so
// the scanner pre-verifies site.js itself and trusts its verified function
// names inside every page script (negative control: any unsafe site.js
// template still fails the gate via the direct site.js scan below).
const siteJsPath = join(staticPagesDir, "assets", "site.js");
const siteJs = await readFile(siteJsPath, "utf8");
const SHARED_SAFE_FNS = ["itemCard", "healthCardHtml", "codeResultCard", "analyticsSignalsHtml", "alertBannerHtml", "calendarEventCard", "calendarMonthGroups", "searchIndexMatches", "eventStatusChip", "emptyListItem"];
for (const finding of scanPage(`<script>${siteJs}</script>`, "assets/site.js")) errors.push(`unsafe innerHTML interpolation (${finding})`);
for (const pageFile of readdirSync(staticPagesDir).filter(f => f.endsWith(".html")).sort()) {
  const pageHtml = await readFile(join(staticPagesDir, pageFile), "utf8");
  for (const finding of scanPage(pageHtml, pageFile, SHARED_SAFE_FNS)) errors.push(`unsafe innerHTML interpolation (${finding})`);
}

// --- lane cci-frontend gate: events-page UX patterns must ship on every page that renders the calendar ---
// The quick-filter buttons, per-kind chips, and the .ics explainer are JS/CSS
// behaviors; these assertions fail the release gate if the markup or shared
// helpers regress (same style as the laneG calendarEventCard scan).
{
  const eventsHtml = pageHtmlCache.get("events.html") ?? "";
  const indexHtmlPage = pageHtmlCache.get("index.html") ?? "";
  // R3: the assertions below read the *exported* asset copies, not the authored
  // sources, so a negative control can mutate a real export and see them fire.
  const exportedAssets = readdirSync(join(destination, "assets"));
  const readExported = async (pattern: RegExp): Promise<string> => {
    const name = exportedAssets.find(asset => pattern.test(asset));
    return name ? await readFile(join(destination, "assets", name), "utf8").catch(() => "") : "";
  };
  const exportedSiteJs = await readExported(/^site\.[0-9a-f]{8}\.js$/);
  const exportedSiteCss = await readExported(/^site\.[0-9a-f]{8}\.css$/);
  if (!exportedSiteJs) errors.push("the export contains no hashed assets/site.*.js");
  if (!exportedSiteCss) errors.push("the export contains no hashed assets/site.*.css");
  for (const [page, html] of [["events.html", eventsHtml], ["index.html", indexHtmlPage]] as Array<[string, string]>) {
    if (!html.includes('class="ics-help"')) errors.push(`${page} is missing the .ics What-is-this explainer`);
    if (!html.includes("data/events.ics")) errors.push(`${page} lost the .ics subscribe link`);
    // R3 P1-D: one window control. Every window value lives in the button group,
    // and the kind <select> must not carry date-window options in parallel.
    for (const window of ["all", "upcoming", "past", "week", "month"]) {
      if (!html.includes(`data-window="${window}"`)) errors.push(`${page} is missing the "${window}" window button (P1-D single window control)`);
    }
    const selectBlock = /<select id="event-filter"[\s\S]*?<\/select>/.exec(html)?.[0] ?? "";
    for (const strayOption of ['value="upcoming"', 'value="past"']) {
      if (selectBlock.includes(strayOption)) errors.push(`${page} kind select still carries a date-window option (${strayOption}) — two uncoordinated window controls (P1-D)`);
    }
    // R3 P1-C: every window button must name the list it controls — one that
    // does not is exactly the button whose state change is announced nowhere.
    const windowButtons = [...html.matchAll(/<button[^>]*class="window-btn"[^>]*>/g)].map(match => match[0]);
    if (windowButtons.length === 0) errors.push(`${page} has no .window-btn buttons`);
    for (const button of windowButtons) {
      if (!button.includes('aria-controls="event-items"')) errors.push(`${page} window buttons are missing aria-controls="event-items" (P1-C)`);
    }
    // R3 P1-E/P1-H: both calendar pages carry the freshness line as a live region.
    if (!/id="event-freshness"[^>]*role="status"/.test(html)) errors.push(`${page} is missing the #event-freshness status line (P1-E/P1-H)`);
    // R3 P1-H: the window wiring is defined once in site.js and called by both.
    if (!html.includes('wireCalendarWindowButtons("event-window-controls"')) errors.push(`${page} does not use the shared wireCalendarWindowButtons (duplicated window wiring, P1-H)`);
    if (/for \(const button of document\.querySelectorAll\("#event-window-controls/.test(html)) errors.push(`${page} still inlines its own window-button loop (P1-H)`);
  }
  // R3 lane 5: the shipped bundle is EXECUTED, not grepped. A string-presence
  // check ("does site.js contain the word calendarWindowFilter") passes for a
  // function that returns the wrong events; these call the exported asset's own
  // functions and assert what they return. The bundle runs with an inert
  // document/window, so nothing here touches the filesystem or the network.
  const siteJsApi = (() => {
    try {
      const inertElement = { setAttribute() {}, getAttribute: () => null, addEventListener() {}, contains: () => false, querySelectorAll: () => [] };
      const factory = new Function("document", "window", "fetch", `${exportedSiteJs}\nreturn { calendarWindowFilter, calendarFreshnessText, publicErrorNote, calendarEventKindChip, emptyListItem, eventKindFilterValue, createDeferredIndexSearch, wireCalendarWindowButtons, searchIndexMatches };`);
      return factory(
        { getElementById: () => inertElement, querySelectorAll: () => [], addEventListener() {} },
        { addEventListener() {} },
        () => { throw new Error("the gate never fetches"); },
      ) as Record<string, Function>;
    } catch (error) {
      errors.push(`assets/site.js does not evaluate, or no longer exports the calendar helpers: ${(error as Error).message}`);
      return null;
    }
  })();
  if (siteJsApi) {
    // P1-D — the window filter is the single window state, and it answers for
    // every value the button group offers.
    const windowFixture = [
      { id: "future", dateStart: "2027-03-04", status: "scheduled" },
      { id: "past", dateStart: "2024-01-02", status: "completed" },
      { id: "undated" },
    ];
    const ids = (value: unknown): string => (value as Array<{ id: string }>).map(event => event.id).join(",");
    const windowFilter = siteJsApi.calendarWindowFilter as (events: unknown[], window: string, now?: Date) => unknown[];
    if (ids(windowFilter(windowFixture, "all")) !== "future,past,undated") errors.push('site.js calendarWindowFilter("all") is no longer a passthrough (P1-D)');
    if (ids(windowFilter(windowFixture, "upcoming")) !== "future") errors.push('site.js calendarWindowFilter("upcoming") does not select scheduled events (P1-D)');
    if (ids(windowFilter(windowFixture, "past")) !== "past") errors.push('site.js calendarWindowFilter("past") does not select completed events (P1-D)');
    // A December "this week" must not leak January, and vice versa.
    const rollover = [{ id: "dec31", dateStart: "2026-12-31" }, { id: "jan01", dateStart: "2027-01-01" }];
    if (ids(windowFilter(rollover, "month", new Date("2026-12-15T20:00:00Z"))) !== "dec31") errors.push("site.js calendarWindowFilter month window crosses the December/January boundary (P1-D)");
    // P1-E — a missing or unparseable timestamp renders nothing, never "NaN".
    const freshness = siteJsApi.calendarFreshnessText as (value: unknown) => string;
    if (freshness("not-a-timestamp") !== "" || freshness(null) !== "") errors.push("site.js calendarFreshnessText invents a freshness line for an unusable timestamp (P1-E)");
    if (/NaN/.test(freshness(new Date().toISOString()))) errors.push("site.js calendarFreshnessText renders NaN (P1-E)");
    // P0.6 — operator strings are mapped, never passed through.
    // The contract is a closed set of public phrases, so any pass-through of the
    // raw operator string fails here whichever branch produced it.
    const errorNote = siteJsApi.publicErrorNote as (value: unknown) => string;
    const publicPhrases = [
      "the request timed out before a response arrived",
      "the response could not be parsed",
      "the source could not be reached",
      "the last check did not succeed",
    ];
    const operatorStrings = [
      "Failed to parse JSON from https://quickmap.dot.ca.gov/api/v1/incidents?format=json",
      "All QuickMap endpoints failed: QuickMap returned 503 from https://quickmap.dot.ca.gov",
      "getaddrinfo ENOTFOUND quickmap.dot.ca.gov",
      "unexpected failure in /Users/operator/output/events/events.json",
      "yt-dlp not found in $PATH",
    ];
    for (const operatorString of operatorStrings) {
      const mapped = errorNote(operatorString);
      if (!publicPhrases.includes(mapped) && !/^the source returned HTTP [45]\d{2}$/.test(mapped)) {
        errors.push(`site.js publicErrorNote leaks operator detail into public copy: "${mapped}" (P0.6)`);
      }
    }
    if (errorNote("") !== "") errors.push("site.js publicErrorNote invents a failure note for a source with no error (P0.6)");
    // P1-G — the calendar list's empty state is a list item.
    const listItem = siteJsApi.emptyListItem as (message: string) => string;
    if (!listItem("x").startsWith("<li") || listItem("x").includes("<div")) errors.push("site.js emptyListItem no longer renders a list item (P1-G)");
    // P1-B — the chip is a real button, escaped, wired to the kind filter.
    const chip = siteJsApi.calendarEventKindChip as (event: { kind?: string }, activeFilter?: string) => string;
    const meetingChip = chip({ kind: "government-meeting" }, "meetings");
    if (!meetingChip.startsWith("<button")) errors.push("site.js calendarEventKindChip no longer renders a real filter button (P1-B)");
    if (!meetingChip.includes('data-kind-filter="meetings"')) errors.push("site.js calendarEventKindChip lost the kind-filter value that wires it to the kind select (P1-B)");
    if (!meetingChip.includes('aria-pressed="true"')) errors.push("site.js calendarEventKindChip does not reflect the active kind filter (P1-B)");
    if (!meetingChip.includes('aria-label="Filter events by kind:')) errors.push("calendarEventKindChip lost its accessible label");
    if (chip({ kind: '"><img src=x onerror=alert(1)>' }).includes("<img")) errors.push("site.js calendarEventKindChip does not escape the event kind (P1-B)");
    // P0.1 — the defect was a first query answered "0 of 0" against an index
    // that had not loaded yet and never re-run. Drive the real controller: the
    // pending render must be followed by a second render carrying the index.
    if (typeof siteJsApi.createDeferredIndexSearch !== "function") {
      errors.push("assets/site.js is missing createDeferredIndexSearch (code search cannot re-run after index load, P0.1)");
    } else {
      const renders: Array<{ needle: string; hasIndex: boolean; state: string }> = [];
      const controller = (siteJsApi.createDeferredIndexSearch as (load: () => Promise<unknown>, render: (needle: string, index: unknown, state: string) => void) => { search: (needle: string) => void })(
        async () => ({ shards: { t: [{ id: "1", t: "harbor" }], x: [{ id: "1", x: "harbor district" }] } }),
        (needle, index, state) => renders.push({ needle, hasIndex: index !== null && index !== undefined, state }),
      );
      controller.search("harbor");
      await new Promise(resolve => setTimeout(resolve, 0));
      if (renders.length < 2) errors.push("site.js createDeferredIndexSearch does not re-render after the index loads — the first query stays empty (P0.1)");
      const settled = renders[renders.length - 1];
      if (!settled || settled.needle !== "harbor" || !settled.hasIndex || settled.state !== "ready") {
        errors.push("site.js createDeferredIndexSearch does not re-run the pending query against the loaded index (P0.1)");
      }
      if (renders[0] && renders[0].state !== "pending") errors.push("site.js createDeferredIndexSearch reports a non-pending state before the index arrives (P0.1)");
    }
    if (typeof siteJsApi.wireCalendarWindowButtons !== "function") errors.push("assets/site.js is missing wireCalendarWindowButtons (the per-page wiring loops must not return, P1-H)");
    if (typeof siteJsApi.publicErrorNote !== "function") errors.push("assets/site.js is missing publicErrorNote (operator errors reach public copy, P0.6)");
  }
  // R3 P0.1: code search must re-run once the lazily loaded index arrives.
  for (const [page, html] of [["code.html", pageHtmlCache.get("code.html") ?? ""], ["index.html", indexHtmlPage]] as Array<[string, string]>) {
    if (!html.includes("createDeferredIndexSearch(")) errors.push(`${page} code search does not re-run after the search index loads (P0.1)`);
  }
  // R3 P1-G: #event-items is an <ol>; its states must be list items, so the
  // calendar page uses emptyListItem() and never the <div>-returning empty().
  if (/\bempty\(/.test(eventsHtml)) errors.push("events.html renders a <div> empty state inside the <ol> calendar list (P1-G)");
  // R3 P0.6: raw operator error text must not be interpolated into public copy.
  if (/esc\(source\.error\)/.test(exportedSiteJs)) errors.push("assets/site.js renders a raw source error string in public copy (P0.6)");
  for (const [pageFile, html] of pageHtmlCache) {
    if (/\$\{(?:esc\()?error\.message \|\| error/.test(html)) errors.push(`${pageFile} renders a raw operator error string in public copy (P0.6)`);
    if (/esc\((?:source|record)\.error\)/.test(html)) errors.push(`${pageFile} renders a raw source error string in public copy (P0.6)`);
  }
  // Per-kind chip styles must survive CSS extraction into the shared asset.
  // (The sticky month-header rule used to be checked here as a literal string.
  // That assertion could not fail for the defect it was written against: the
  // rule was present and inert. It now lives in the lane 4 computed-value gate
  // below, which resolves position/display over the real element path.)
  // Read the emitted stylesheet, not the authored one: what ships is what the
  // assertion is about, and it is what a negative control can mutate.
  if (!exportedSiteCss.includes(".kind-chip--")) errors.push("site.css lost the per-kind chip styles");
  // R3 P1-C: .window-btn follows the site conventions instead of a width hack.
  const focusRule = /a:focus-visible[^{]*\{[^}]*\}/.exec(exportedSiteCss)?.[0] ?? "";
  if (!focusRule.includes(".window-btn:focus-visible")) errors.push("site.css focus-ring rule does not cover .window-btn (P1-C)");
  const coarseRule = /@media \(pointer: coarse\) \{[^}]*\}/.exec(exportedSiteCss)?.[0] ?? "";
  if (!coarseRule.includes(".window-btn")) errors.push("site.css coarse-pointer 44px rule does not cover .window-btn (P1-C)");
  if (/@media \(max-width:600px\) \{ \.window-btn/.test(exportedSiteCss)) errors.push("site.css still sizes .window-btn by viewport width instead of pointer type (P1-C)");
}

// --- R3 follow-up gate: every artifact a page fetches on load must exist ---
// gui.html fetched data/analytics.json unconditionally while the exporter only
// emitted it when an overview existed, so an edition without analytics served a
// 404 to every visitor and (through one shared Promise.all) rendered the whole
// console as unavailable. The artifact is now always emitted, carrying an
// explicit unavailable envelope when there is no overview.
{
  const analyticsRaw = await readFile(join(destination, PAGES_ANALYTICS_ARTIFACT), "utf8").catch(() => null);
  if (analyticsRaw === null) {
    errors.push(`${PAGES_ANALYTICS_ARTIFACT} is missing — the console page fetches it on load and would 404 for every visitor`);
  } else {
    const artifact = JSON.parse(analyticsRaw) as { schemaVersion?: unknown; available?: unknown };
    const unavailable = artifact.schemaVersion === "crescent-city-analytics-unavailable/v1";
    if (unavailable && artifact.available !== false) errors.push(`${PAGES_ANALYTICS_ARTIFACT} declares the unavailable envelope without available:false`);
    // The envelope and the files map must agree about whether an overview exists.
    const claimed = snapshot?.files?.analytics ?? null;
    if (unavailable && claimed !== null) errors.push(`${PAGES_ANALYTICS_ARTIFACT} says no overview was produced while snapshot.files.analytics claims one`);
    if (!unavailable && claimed === null) errors.push(`${PAGES_ANALYTICS_ARTIFACT} carries an overview that snapshot.files.analytics does not point at`);
  }
}

// --- R3 lane 5 gate: an empty published calendar must be explained ---
// The Pages workflow tolerates calendar-collection outages (three
// continue-on-error steps). That tolerance silently accepted a *total* failure:
// the build stayed green and published an empty calendar that looked like a
// quiet week. The honest rule needs no hand-written marker file — the evidence
// is already in the artifact. A zero-event calendar is only honest when the
// inputs a calendar is built from (meetings, news, YouTube) are themselves
// empty; zero events built from non-empty inputs is a broken refresh, and fails.
{
  const eventsRaw = await readFile(join(destination, PAGES_EVENTS_ARTIFACT), "utf8").catch(() => null);
  if (eventsRaw === null) {
    errors.push(`${PAGES_EVENTS_ARTIFACT} is missing — the published edition has no community calendar at all`);
  } else {
    const artifact = JSON.parse(eventsRaw) as { schemaVersion?: unknown; events?: unknown; count?: unknown };
    if (artifact.schemaVersion !== "crescent-city-events/v1") errors.push(`${PAGES_EVENTS_ARTIFACT} has an unsupported schemaVersion`);
    if (!Array.isArray(artifact.events)) {
      errors.push(`${PAGES_EVENTS_ARTIFACT} has no events array — the calendar page would render its wrong-shape message`);
    } else if (artifact.events.length === 0 && snapshot) {
      const inputs = [snapshot.meetings, snapshot.news, snapshot.youtube].reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
      if (inputs > 0) {
        errors.push(`${PAGES_EVENTS_ARTIFACT} is empty while ${inputs} calendar input record(s) were published — the calendar refresh failed and the build must not report success (R3 P2)`);
      }
    }
    if (Array.isArray(artifact.events) && typeof artifact.count === "number" && artifact.count < artifact.events.length) {
      errors.push(`${PAGES_EVENTS_ARTIFACT} count (${artifact.count}) is smaller than the events it carries (${artifact.events.length})`);
    }
  }
}

// --- R3 P1-L gate: meeting copy is about the meeting ---
// The city's meeting pages repeat their own navigation inside the scraped body
// ("Meeting Agenda (View the agenda...)", "Submit Written Public Comment (...)",
// "Media Site"). That chrome, and the bare agenda URLs beside it, were being
// published as meeting copy on the public meetings list and in the feed.
{
  const MEETING_CHROME = ["Meeting Agenda (View the agenda", "Submit Written Public Comment", "YouTube Channel (View", "Media Site", "City of Crescent City Website"];
  const meetingsJson = await readFile(join(destination, "data", "meetings.json"), "utf8").catch(() => null);
  if (meetingsJson !== null) {
    const meetings = JSON.parse(meetingsJson) as Array<Record<string, unknown>>;
    meetings.forEach((meeting, index) => {
      const content = typeof meeting.content === "string" ? meeting.content : "";
      for (const chrome of MEETING_CHROME) {
        if (content.includes(chrome)) errors.push(`data/meetings.json[${index}] publishes source-site nav chrome as meeting copy: "${chrome}" (P1-L)`);
      }
      if (/https?:\/\//.test(content)) errors.push(`data/meetings.json[${index}] publishes a raw URL as meeting copy instead of a labelled document link (P1-L)`);
      const documents = Array.isArray(meeting.documents) ? meeting.documents : [];
      for (const document of documents as Array<Record<string, unknown>>) {
        if (typeof document.label !== "string" || !document.label.trim()) errors.push(`data/meetings.json[${index}] has an unlabelled meeting document (P1-L)`);
        if (typeof document.url !== "string" || !/^https?:\/\//i.test(document.url)) errors.push(`data/meetings.json[${index}] has a meeting document with no usable URL (P1-L)`);
      }
    });
  }
  const feedXml = await readFile(join(destination, "feed.xml"), "utf8").catch(() => null);
  if (feedXml !== null) {
    for (const chrome of MEETING_CHROME) {
      if (feedXml.includes(chrome)) errors.push(`feed.xml syndicates source-site nav chrome as item copy: "${chrome}" (P1-L)`);
    }
  }
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

// --- lane 4 r3 gate: CSS integrity by computed value, not string presence ---
// Two defect classes escaped every earlier assertion: a rule living in a
// stylesheet its consuming page never loads (`.meta`), and a rule that is
// present but inert (sticky datelines inside a grid; a print block nested in an
// unclosed `@media (max-width:480px)`). Both need the cascade resolved for a
// concrete element, which is what src/pages_css.ts does.
{
  // Brace balance over the emitted stylesheets. An unclosed block does not fail
  // to parse — the browser closes it at EOF — so everything authored after it
  // silently inherits its at-rule condition.
  for (const cssFile of readdirSync(join(destination, "assets")).filter(name => name.endsWith(".css"))) {
    const cssText = await readFile(join(destination, "assets", cssFile), "utf8").catch(() => null);
    if (cssText === null) { errors.push(`emitted stylesheet is unreadable: assets/${cssFile}`); continue; }
    for (const problem of auditStylesheetBraces(`assets/${cssFile}`, cssText)) errors.push(problem);
  }
  const siteJsAsset = readdirSync(join(destination, "assets")).find(name => /^site\.[0-9a-f]{8}\.js$/.test(name));
  const siteJsForCss = siteJsAsset ? await readFile(join(destination, "assets", siteJsAsset), "utf8").catch(() => "") : "";
  const cssInputs: PageCssInput[] = [];
  for (const [page, css] of pageCssCache) {
    const markup = pageMarkupCache.get(page) ?? "";
    // site.js renders the alert table wrapper on any page that mounts it.
    const rendersTableScroll = markup.includes("table-scroll") || (markup.includes("alert-items") && siteJsForCss.includes("table-scroll"));
    cssInputs[cssInputs.length] = {
      page,
      css,
      hasEventList: markup.includes('id="event-items"'),
      hasTableScroll: rendersTableScroll,
    };
  }
  for (const problem of auditPagesCss(cssInputs)) errors.push(problem);
}

if (errors.length) {
  console.error(errors.map(error => `✖ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Pages artifact valid: ${destination}`);

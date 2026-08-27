#!/usr/bin/env bun
/** Validate a generated public Pages artifact without making network calls. */
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import {
  PAGES_GEO_INTEL_ARTIFACT,
  PAGES_GEO_VIEW_PLACEHOLDER,
  summarizePagesGeoIntel,
  validatePagesGeoIntel,
  validatePagesSource,
} from "../src/pages_snapshot.js";
import { PAGES_ROBOTS_TXT, PAGES_SITEMAP_XML } from "../src/pages_snapshot.js";
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
errors.push(...validatePagesSource(indexHtml));
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

const jsonLdMatch = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (!jsonLdMatch) {
  errors.push("index.html is missing the JSON-LD structured data script");
} else {
  try {
    const structuredData = JSON.parse(jsonLdMatch[1]) as Record<string, unknown>;
    if (structuredData["@type"] !== "WebSite") errors.push("JSON-LD @type is not WebSite");
    if (structuredData.url !== "https://quadruplicate.org/") errors.push("JSON-LD url does not match the canonical site URL");
    const publisher = typeof structuredData.publisher === "object" && structuredData.publisher !== null ? structuredData.publisher as Record<string, unknown> : null;
    if (publisher?.["@type"] !== "GovernmentOrganization") errors.push("JSON-LD publisher is not GovernmentOrganization");
  } catch {
    errors.push("JSON-LD structured data does not parse as JSON");
  }
}

if (indexHtml.includes("__CC_API_KEY__") || indexHtml.includes("__CC_API_KEY_INJECT__")) errors.push("API key placeholder found in Pages HTML");
if (indexHtml.includes("localhost:") || indexHtml.includes("127.0.0.1")) errors.push("local-only endpoint found in Pages HTML");

if (errors.length) {
  console.error(errors.map(error => `✖ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Pages artifact valid: ${destination}`);

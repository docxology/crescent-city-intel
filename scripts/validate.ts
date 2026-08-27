#!/usr/bin/env bun
/** Authoritative deterministic release gate for the repository. */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { EXPECTED_SOURCE_HEALTH, isIsoTimestamp } from "../src/shared/source_health.ts";
import { PAGES_STATIC_PAGES, validatePagesHtml } from "../src/pages_snapshot.ts";
import { getSourceRegistry, sourceRegistryFingerprint, validateSourceRegistry } from "../src/source_registry.ts";
import { paths } from "../src/shared/paths.ts";

type Check = { name: string; args: string[] };

function run(check: Check): void {
  console.log(`\n== ${check.name} ==`);
  const result = Bun.spawnSync(check.args, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${check.name} failed with exit code ${result.exitCode}`);
  }
}

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string };
const openapi = readFileSync(join(root, "openapi.yaml"), "utf-8");
const readme = readFileSync(join(root, "README.md"), "utf-8");
const configuration = readFileSync(join(root, "docs", "configuration.md"), "utf-8");
const llmDocs = readFileSync(join(root, "docs", "modules", "llm.md"), "utf-8");
const routeSource = readFileSync(join(root, "src", "gui", "routes.ts"), "utf-8");
const pagesStaticDir = join(root, "src", "pages", "static");
const pagesSourceHtml: Record<string, string> = { "index.html": readFileSync(join(pagesStaticDir, "index.html"), "utf-8") };
for (const page of PAGES_STATIC_PAGES.map(candidate => candidate.file).concat("404.html")) {
  pagesSourceHtml[page] = existsSync(join(pagesStaticDir, page)) ? readFileSync(join(pagesStaticDir, page), "utf-8") : "";
}
const pagesWorkflow = readFileSync(join(root, ".github", "workflows", "pages.yml"), "utf-8");

const registryErrors = validateSourceRegistry();
if (registryErrors.length > 0) throw new Error(`Source registry contract failed: ${registryErrors.join("; ")}`);

const pagesSourceErrors = validatePagesHtml(pagesSourceHtml);
if (pagesSourceErrors.length > 0) throw new Error(`Pages source contract failed: ${pagesSourceErrors.join("; ")}`);
for (const requiredWorkflowText of ["actions/upload-pages-artifact", "actions/deploy-pages", "bun run pages:validate", "pages: write", "id-token: write"]) {
  if (!pagesWorkflow.includes(requiredWorkflowText)) throw new Error(`Pages workflow is missing ${requiredWorkflowText}`);
}
for (const requiredGuiText of ['id="chat-cancel"', "/api/metadata", "AbortController"]) {
  const gui = readFileSync(join(root, "src", "gui", "static", "index.html"), "utf-8");
  if (!gui.includes(requiredGuiText)) throw new Error(`GUI is missing interactivity contract: ${requiredGuiText}`);
}

if (!openapi.includes(`  version: ${packageJson.version}`)) {
  throw new Error(`openapi.yaml version does not match package.json (${packageJson.version})`);
}
if ((openapi.match(/^components:$/gm) ?? []).length !== 1) {
  throw new Error("openapi.yaml must contain exactly one top-level components block");
}
for (const healthField of ["providerHealth:", "embeddingProvider:", "vectorStore:"]) {
  if (!openapi.includes(healthField)) throw new Error(`openapi.yaml health schema is missing ${healthField}`);
}
if (readme.includes("crescent-city-intel-intel-intel.git")) {
  throw new Error("README contains the invalid clone URL");
}
if (readme.includes("httpbin.org")) {
  throw new Error("Repository documentation must not depend on httpbin.org");
}
for (const [document, requiredText] of [
  [configuration, "SOURCE_FRESHNESS_WINDOW_MS"],
  [llmDocs, "NoRetrievedContextError"],
  [readme, "bun run source-discovery"],
] as const) {
  if (!document.includes(requiredText)) throw new Error(`Documentation is missing required operational contract: ${requiredText}`);
}

// Keep the published contract from silently drifting away from the route table.
// Literal routes are extracted from the implementation; parameterized routes are
// listed with their stable public shape and checked against the corresponding
// matcher. Trailing-slash aliases are one logical route.
const normalizeRoute = (route: string): string => route.replace(/\/$/, "") || "/";
const implementedRoutes = new Set(
  [...routeSource.matchAll(/path === "(\/api\/[^"?]+)"/g)].map(match => normalizeRoute(match[1])),
);
const parameterizedRoutes: Array<[string, string]> = [
  ["/api/article/{guid}", "path.match(/^\\/api\\/article\\/"],
  ["/api/section/{guid}", "path.match(/^\\/api\\/section\\/"],
  ["/api/domain/{id}", "path.match(/^\\/api\\/domain\\/"],
  ["/api/domain/{id}/search", "path.match(/^\\/api\\/domain\\/"],
  ["/api/domain/{id}/sections", "path.match(/^\\/api\\/domain\\/"],
  ["/api/domains/{id}/coverage", "path.match(/^\\/api\\/domains\\/"],
  ["/api/history/{guid}", "path.match(/^\\/api\\/history\\/"],
  ["/api/similar/{guid}", "path.match(/^\\/api\\/similar\\/"],
  ["/api/citations/{guid}", "path.match(/^\\/api\\/citations\\/"],
  ["/api/alerts/{type}/history", "path.match(/^\\/api\\/alerts\\/"],
];
for (const [route, matcher] of parameterizedRoutes) {
  if (!routeSource.includes(matcher)) throw new Error(`OpenAPI route matcher missing in implementation: ${route}`);
  implementedRoutes.add(route);
}
const specRoutes = [...openapi.matchAll(/^  (\/api\/[^:]+):$/gm)].map(match => normalizeRoute(match[1]));
const specRouteSet = new Set(specRoutes);
for (const route of specRouteSet) {
  if (!implementedRoutes.has(route)) throw new Error(`OpenAPI route has no implementation: ${route}`);
}
for (const route of implementedRoutes) {
  if (!specRouteSet.has(route)) throw new Error(`Implemented route is missing from OpenAPI: ${route}`);
}

function parseJsonIfPresent(relativePath: string): unknown | undefined {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) return undefined;
  try {
    return JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch (error) {
    throw new Error(`Invalid generated JSON at ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const path of [
  "output/manifest.json",
  "output/toc.json",
  "output/state/index-manifest.json",
  "output/news/source-health.json",
  "output/gov_meetings/source-health.json",
  "output/youtube/source-health.json",
  "output/triplicate/source-health.json",
  "output/alerts/source-health.json",
  "output/weekly-check-summary.json",
  "output/state/latest-pipeline-run.json",
  "output/state/curation-report.json",
  "output/state/analytics-overview.json",
  "output/source-registry.json",
  "output/source-discovery.json",
]) parseJsonIfPresent(path);

const registryArtifact = parseJsonIfPresent("output/source-registry.json") as { fingerprint?: string; sources?: unknown[] } | undefined;
const discoveryArtifact = parseJsonIfPresent("output/source-discovery.json") as { registryFingerprint?: string; sourceCount?: number; sources?: unknown[] } | undefined;
if (!registryArtifact || !Array.isArray(registryArtifact.sources)) throw new Error("output/source-registry.json is required and must contain sources");
if (registryArtifact.sources.length !== getSourceRegistry().length) throw new Error("output/source-registry.json is out of sync with the source registry");
const expectedRegistryFingerprint = await sourceRegistryFingerprint();
if (registryArtifact.fingerprint !== expectedRegistryFingerprint) throw new Error("output/source-registry.json fingerprint is stale");
if (!discoveryArtifact || discoveryArtifact.registryFingerprint !== expectedRegistryFingerprint || discoveryArtifact.sourceCount !== registryArtifact.sources.length) {
  throw new Error("output/source-discovery.json is out of sync with the source registry");
}

for (const relativePath of [
  "output/news/source-health.json",
  "output/gov_meetings/source-health.json",
  "output/youtube/source-health.json",
  "output/triplicate/source-health.json",
  "output/alerts/source-health.json",
]) {
  const report = parseJsonIfPresent(relativePath) as { sources?: Array<{ status?: string; checkedAt?: string; itemCount?: number }> } | undefined;
  if (!report) continue;
  if (!Array.isArray(report.sources)) throw new Error(`${relativePath} must contain a sources array`);
  for (const source of report.sources) {
    if (!source || !["ok", "empty", "unavailable", "stale"].includes(source.status ?? "")) {
      throw new Error(`${relativePath} contains an invalid source health status`);
    }
    if (!isIsoTimestamp(source.checkedAt ?? "") || !Number.isInteger(source.itemCount) || (source.itemCount ?? -1) < 0) {
      throw new Error(`${relativePath} contains an invalid source health record`);
    }
  }
}

for (const relativePath of ["output/weekly-check-summary.json", "output/state/latest-pipeline-run.json"]) {
  const report = parseJsonIfPresent(relativePath) as { schemaVersion?: string; runId?: string; status?: string; steps?: unknown[]; sourceHealth?: { total?: number; present?: number; missing?: number; coveragePercent?: number; coverageStatus?: string; presentSources?: string[]; missingSources?: string[]; sources?: string[]; degraded?: number } } | undefined;
  if (!report) continue;
  if (report.schemaVersion !== "1.0.0" || !report.runId || !["ok", "degraded", "failed"].includes(report.status ?? "") || !Array.isArray(report.steps)) {
    throw new Error(`${relativePath} is not a valid pipeline-run envelope`);
  }
 if (report.sourceHealth && (!Number.isInteger(report.sourceHealth.degraded) || (report.sourceHealth.degraded ?? -1) < 0)) {
   throw new Error(`${relativePath} contains an invalid source-health summary`);
 }
  if (report.sourceHealth && (
    !Number.isInteger(report.sourceHealth.total) ||
    !Number.isInteger(report.sourceHealth.present) ||
    !Number.isInteger(report.sourceHealth.missing) ||
    (report.sourceHealth.total ?? -1) !== (report.sourceHealth.present ?? -2) + (report.sourceHealth.missing ?? -3) ||
    !Number.isFinite(report.sourceHealth.coveragePercent) ||
    (report.sourceHealth.coveragePercent ?? -1) < 0 ||
    (report.sourceHealth.coveragePercent ?? 101) > 100
  )) {
    throw new Error(`${relativePath} contains an invalid present/missing source-coverage summary`);
  }
  if (report.sourceHealth) {
    const coverage = report.sourceHealth;
    const presentSources = Array.isArray(coverage.presentSources) ? [...coverage.presentSources].sort() : [];
    const missingSources = Array.isArray(coverage.missingSources) ? [...coverage.missingSources].sort() : [];
    const allSources = Array.isArray(coverage.sources) ? [...coverage.sources].sort() : [];
    if (!Array.isArray(coverage.presentSources) || !Array.isArray(coverage.missingSources) || !Array.isArray(coverage.sources)) {
      throw new Error(`${relativePath} is missing named source coverage lists`);
    }
    if (JSON.stringify(allSources) !== JSON.stringify([...presentSources, ...missingSources].sort())) {
      throw new Error(`${relativePath} source coverage lists do not partition the source set`);
    }
    if (coverage.total !== allSources.length || coverage.present !== presentSources.length || coverage.missing !== missingSources.length) {
      throw new Error(`${relativePath} named source coverage lists do not match their counts`);
    }
    const expectedNames = EXPECTED_SOURCE_HEALTH.map(expected => expected.source);
    if (expectedNames.some(name => !allSources.includes(name))) throw new Error(`${relativePath} is missing an expected source-health contract record`);
    const expectedCoverageStatus = coverage.total === 0 ? "none" : coverage.missing === 0 ? "complete" : coverage.present === 0 ? "none" : "partial";
    if (coverage.coverageStatus !== expectedCoverageStatus) throw new Error(`${relativePath} has an invalid coverageStatus`);
  }
}

for (const reportPath of ["output/state/curation-report.json", "output/reports/latest-metadata.json"]) {
  const report = parseJsonIfPresent(reportPath) as Record<string, unknown> | undefined;
  if (!report) continue;
  if (report.schemaVersion !== "1.0.0") throw new Error(`${reportPath} has an unsupported schema version`);
}

const analyticsOverview = parseJsonIfPresent("output/state/analytics-overview.json") as {
  schemaVersion?: string;
  generatedAt?: string;
  inputFingerprint?: string;
  status?: string;
  summary?: string;
  metrics?: Record<string, unknown>;
  signals?: unknown[];
  llm?: { status?: string; provider?: string; model?: string; promptVersion?: string; inputFingerprint?: string };
} | undefined;
if (analyticsOverview) {
  if (analyticsOverview.schemaVersion !== "1.0.0" || !isIsoTimestamp(analyticsOverview.generatedAt ?? "") || !/^[a-f0-9]{64}$/.test(analyticsOverview.inputFingerprint ?? "")) {
    throw new Error("output/state/analytics-overview.json has an invalid envelope");
  }
  if (!["ok", "degraded", "unavailable"].includes(analyticsOverview.status ?? "") || !analyticsOverview.summary || !analyticsOverview.metrics || !Array.isArray(analyticsOverview.signals)) {
    throw new Error("output/state/analytics-overview.json has an invalid status, summary, metrics, or signals field");
  }
  if (!analyticsOverview.llm || !["ok", "unavailable", "not-requested"].includes(analyticsOverview.llm.status ?? "") || !analyticsOverview.llm.provider || !analyticsOverview.llm.model || analyticsOverview.llm.promptVersion !== "2026-07-24-analytics-overview-v1" || analyticsOverview.llm.inputFingerprint !== analyticsOverview.inputFingerprint) {
    throw new Error("output/state/analytics-overview.json has invalid LLM provenance");
  }
}

run({ name: "TypeScript strict check", args: ["bunx", "tsc", "--noEmit"] });
run({ name: "Manuscript source contract", args: ["bun", "run", "manuscript:check"] });
if (existsSync(paths.analyticsOverview)) {
  run({ name: "Manuscript evidence hydration", args: ["bun", "run", "manuscript:hydrate"] });
  run({ name: "Hydrated manuscript contract", args: ["bun", "run", "scripts/validate-manuscript.ts", "--hydrated"] });
}
// The suite deliberately exercises the real local corpus and service
// degradation paths. A 30-second per-test bound keeps transient CPU/IO
// contention from turning a correct test into a false timeout while still
// catching genuine hangs.
run({ name: "Deterministic test suite", args: ["bun", "test", "tests/", "--timeout", "30000"] });
run({ name: "Git whitespace check", args: ["git", "diff", "--check"] });

if (existsSync(join(root, ".pages"))) {
  run({ name: "Generated Pages artifact check", args: ["bun", "run", "pages:validate", "--", ".pages"] });
}

const marineHistory = join(root, "output", "alerts", "marine", "history.jsonl");
if (existsSync(marineHistory)) {
  for (const line of readFileSync(marineHistory, "utf-8").split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line) as { timestamp?: string };
    const year = Number(record.timestamp?.slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error(`Malformed marine history timestamp: ${record.timestamp ?? "missing"}`);
    }
  }
}

console.log("\nValidation passed: strict types, deterministic tests, whitespace, contract version, and generated-history sanity.");

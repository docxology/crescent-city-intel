#!/usr/bin/env bun
/** Authoritative deterministic release gate for the repository. */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isIsoTimestamp } from "../src/shared/source_health.ts";
import { validatePagesSource } from "../src/pages_snapshot.ts";

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
const routeSource = readFileSync(join(root, "src", "gui", "routes.ts"), "utf-8");
const pagesIndex = readFileSync(join(root, "src", "pages", "static", "index.html"), "utf-8");
const pagesWorkflow = readFileSync(join(root, ".github", "workflows", "pages.yml"), "utf-8");

const pagesSourceErrors = validatePagesSource(pagesIndex);
if (pagesSourceErrors.length > 0) throw new Error(`Pages source contract failed: ${pagesSourceErrors.join("; ")}`);
for (const requiredWorkflowText of ["actions/upload-pages-artifact", "actions/deploy-pages", "bun run pages:validate", "pages: write", "id-token: write"]) {
  if (!pagesWorkflow.includes(requiredWorkflowText)) throw new Error(`Pages workflow is missing ${requiredWorkflowText}`);
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
]) parseJsonIfPresent(path);

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

run({ name: "TypeScript strict check", args: ["bunx", "tsc", "--noEmit"] });
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

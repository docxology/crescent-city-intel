import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { EXPECTED_SOURCE_HEALTH, isIsoTimestamp } from "./shared/source_health.js";
import { PAGES_STATIC_PAGES, validatePagesHtml } from "./pages_snapshot.js";
import { getSourceRegistry, sourceRegistryFingerprint, validateSourceRegistry } from "./source_registry.js";
import { paths } from "./shared/paths.js";
import { parseCoverageSummary, runFencedCommand } from "./release_checks.js";

/**
 * Deterministic release gate — every contract check the repository enforces
 * before an edition may ship: source registry, pages source, docs/workflow
 * contracts, OpenAPI route table, generated-artifact envelopes, strict
 * TypeScript, the deterministic suite under the output-corpus fence, the
 * coverage floor, and generated-history sanity. Invoked by the thin
 * orchestrator scripts/validate.ts; throws on the first failed check.
 */
export async function runReleaseGate(options: { only?: "contracts" | "all" } = {}): Promise<void> {
  type Check = { name: string; args: string[] };

  function run(check: Check): void {
    console.log(`\n== ${check.name} ==`);
    const result = Bun.spawnSync(check.args, { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
      throw new Error(`${check.name} failed with exit code ${result.exitCode}`);
    }
  }

  /**
   * `contracts` stops after the offline contract checks: the ones that cannot be
   * satisfied or unsatisfied by whether `output/` happens to be populated.
   *
   * This exists for the pull-request CI job, which needs the route table, $ref
   * resolution, source-health roster and alert-type enum checked on every change
   * — but must not spend three minutes on the suite and the coverage floor that
   * the publish job re-runs against a real corpus. It is a MODE OF THIS GATE,
   * not a second implementation: a check added here is picked up by both, which
   * is the point. Anything that would be skipped by `--only=contracts` is named
   * at the end so nobody mistakes it for a full pass.
   */
  const contractsOnly = options.only === "contracts";
  const SKIPPED_BY_CONTRACTS_MODE = [
    "Deterministic test suite + coverage floor",
    "output-corpus fence",
    "generated Pages artifact check",
  ];

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
  // v2.7.0 GUI layout: index.html is a shell and the interactivity code lives
  // in src/gui/static/assets/modules/*.js. The contract strings may sit in
  // either the shell or any module, so check the union of the shell plus every
  // module file — the GUI must still carry cancellable chat and metadata
  // diagnostics wherever those strings now live.
  const guiStaticDir = join(root, "src", "gui", "static");
  const guiModuleDir = join(guiStaticDir, "assets", "modules");
  const guiFiles = [join(guiStaticDir, "index.html")].concat(
    existsSync(guiModuleDir)
      ? readdirSync(guiModuleDir).filter((file) => file.endsWith(".js")).sort().map((file) => join(guiModuleDir, file))
      : [],
  );
  const guiText = guiFiles.map((file) => readFileSync(file, "utf-8")).join("\n");
  for (const requiredGuiText of ['id="chat-cancel"', "/api/metadata", "AbortController"]) {
    if (!guiText.includes(requiredGuiText)) throw new Error(`GUI is missing interactivity contract: ${requiredGuiText}`);
  }
  const spec = Bun.YAML.parse(openapi) as { info: { version: unknown }; paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, Record<string, any>> } };
  if (spec.info?.version !== packageJson.version) {
    throw new Error(`openapi.yaml version does not match package.json (${packageJson.version})`);
  }
  if (!spec.components || typeof spec.components !== "object" || !spec.components.schemas) throw new Error("openapi.yaml must declare component schemas");
  const resolveRef = (ref: string): unknown => {
    if (!ref.startsWith("#/")) throw new Error(`Unsupported external OpenAPI reference: ${ref}`);
    return ref.slice(2).split("/").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, spec);
  };
  const checkRefs = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(checkRefs); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string" && resolveRef(object.$ref) === undefined) throw new Error(`openapi.yaml $ref does not resolve: ${object.$ref}`);
    Object.values(object).forEach(checkRefs);
  };
  checkRefs(spec);
  const { ALERT_TYPES } = await import("./alert_analytics.js");
  const alertEnum = (spec.paths["/api/alerts/{type}/history"]?.get as any)?.parameters?.map((parameter: any) => parameter.$ref ? resolveRef(parameter.$ref) : parameter).find((parameter: any) => parameter.name === "type")?.schema?.enum ?? Object.values(spec.components.schemas).find((schema: any) => Array.isArray(schema.enum) && schema.enum[0] === "tsunami")?.enum;
  if (JSON.stringify(alertEnum) !== JSON.stringify([...ALERT_TYPES])) throw new Error("openapi.yaml AlertType enum does not match ALERT_TYPES");
  const health = ((spec.paths["/api/health"]?.get as any)?.responses?.["200"]?.content?.["application/json"]?.schema?.properties);
  for (const field of ["providerHealth", "embeddingProvider", "vectorStore"]) if (!health?.[field]) throw new Error(`OpenAPI health schema is missing ${field}`);
  if (!spec.paths["/api/chat"]?.post) throw new Error("OpenAPI must declare POST /api/chat");
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
  const specRoutes = Object.keys(spec.paths).map(normalizeRoute);
  const specRouteSet = new Set(specRoutes);
  for (const route of specRouteSet) {
    if (!implementedRoutes.has(route)) throw new Error(`OpenAPI route has no implementation: ${route}`);
  }
  for (const route of implementedRoutes) {
    if (!specRouteSet.has(route)) throw new Error(`Implemented route is missing from OpenAPI: ${route}`);
  }

  function parseJsonIfPresent(relativePath: string): unknown | undefined {
    const absolutePath = relativePath.startsWith("output/") ? resolve(root, paths.output, relativePath.slice(7)) : join(root, relativePath);
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
  const expectedRegistryFingerprint = await sourceRegistryFingerprint();
  if (registryArtifact) {
    if (!Array.isArray(registryArtifact.sources) || registryArtifact.sources.length !== getSourceRegistry().length) throw new Error("source-registry.json is out of sync with the source registry");
    if (registryArtifact.fingerprint !== expectedRegistryFingerprint) throw new Error("source-registry.json fingerprint is stale");
  }
  if (discoveryArtifact && (discoveryArtifact.registryFingerprint !== expectedRegistryFingerprint || discoveryArtifact.sourceCount !== getSourceRegistry().length)) throw new Error("source-discovery.json is out of sync with the source registry");
  if (!registryArtifact && !discoveryArtifact) console.log("Generated registry artifacts absent: canonical source contracts checked; no generated discovery evidence claimed.");

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
  run({ name: "Strict test TypeScript", args: ["bunx", "tsc", "--project", "tsconfig.tests.json", "--noEmit"] });
  run({ name: "Manuscript source contract", args: ["bun", "run", "manuscript:check"] });
  if (!contractsOnly && existsSync(paths.analyticsOverview)) {
    run({ name: "Manuscript evidence hydration", args: ["bun", "run", "manuscript:hydrate"] });
    run({ name: "Hydrated manuscript contract", args: ["bun", "run", "scripts/validate-manuscript.ts", "--hydrated"] });
  }
  run({ name: "Geo contract sync", args: ["bun", "run", "geo:sync-check"] });
  // The suite deliberately exercises the real local corpus and service
  // degradation paths. A 30-second per-test bound keeps transient CPU/IO
  // contention from turning a correct test into a false timeout while still
  // catching genuine hangs.
  if (contractsOnly) {
    console.log("\nContract-only mode: stopping before the suite, which the publish job runs against a real corpus.");
    for (const skipped of SKIPPED_BY_CONTRACTS_MODE) console.log(`  skipped: ${skipped}`);
    console.log("Contract checks passed (this is NOT a full release-gate pass).");
    return;
  }

  // TWO suite runs, and the duplication is load-bearing. Do not "fix" it.
  //
  // It is tempting to run the suite once with `--coverage` and derive both the
  // test result and the coverage table from that one output, halving the gate's
  // wall time. Measured: that makes the gate FAIL. Coverage instrumentation
  // compounds across a whole run rather than per file — a single file is fine
  // under `--coverage` (tests/bounded-jsonl.test.ts: 102ms plain, 61ms covered),
  // but with all 139 files instrumented at once the I/O-bound and
  // analytics-heavy tests blow through the per-test timeouts, which were tuned
  // against the uninstrumented run:
  //
  //   tests/bounded-jsonl.test.ts      102ms  ->  155,885ms
  //   tests/analytics-backend.test.ts  (54s)   ->  300,001ms (hard timeout)
  //
  // Six tests failed, every one a timeout, none real. The alternative — raising
  // the per-test timeouts to accommodate instrumentation — would make the two
  // runs' timings mean different things and would mask genuine hangs. So the
  // plain run decides pass/fail, the covered run supplies the floor, and the
  // cost is paid knowingly.
  console.log("\n== Deterministic test suite ==");
  await runFencedCommand({ args: ["bun", "test", "tests/", "--timeout", "30000"], cwd: root, outputRoot: paths.output });
  console.log("\n== Actual line coverage ==");
  const covOutput = await runFencedCommand({
    args: ["bun", "test", "tests/", "--coverage", "--timeout", "30000"],
    cwd: root, outputRoot: paths.output, capture: true,
  });
  const coverage = parseCoverageSummary(covOutput);
  const floor = 60;
  if (coverage.lines < floor) throw new Error(`Coverage floor: actual line coverage ${coverage.lines}% is below ${floor}%`);
  console.log(`Coverage floor: lines ${coverage.lines}% >= ${floor}%; functions ${coverage.functions ?? "not measured"}%; branches ${coverage.branches ?? "not measured"}`);
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
}

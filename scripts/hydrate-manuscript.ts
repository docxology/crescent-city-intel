#!/usr/bin/env bun
/** Resolve source-controlled manuscript tokens from analytics-overview.json. */
import { existsSync } from "fs";
import { mkdir, readdir, readFile, unlink, writeFile, copyFile } from "fs/promises";
import { join } from "path";
import { ANALYTICS_OVERVIEW_SCHEMA, type AnalyticsOverview } from "../src/analytics_backend.js";
import { MANUSCRIPT_VARIABLE_NAMES, valuesFromOverview } from "../src/manuscript_variables.js";
import { paths } from "../src/shared/paths.js";
import { writeJsonAtomic, writeTextAtomic } from "../src/shared/source_health.js";

const root = process.cwd();
const sourceDir = join(root, "manuscript");
const allowDraft = Bun.argv.includes("--allow-draft");

async function readOverview(): Promise<AnalyticsOverview> {
  try {
    const overview = JSON.parse(await readFile(paths.analyticsOverview, "utf8")) as AnalyticsOverview;
    if (overview.schemaVersion !== ANALYTICS_OVERVIEW_SCHEMA || !/^[a-f0-9]{64}$/.test(overview.inputFingerprint)) {
      throw new Error("analytics overview has an invalid schema or input fingerprint");
    }
    return overview;
  } catch (error) {
    if (!allowDraft) {
      throw new Error(`Cannot hydrate manuscript without ${paths.analyticsOverview}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      schemaVersion: ANALYTICS_OVERVIEW_SCHEMA,
      generatedAt: "not-generated",
      inputFingerprint: "0".repeat(64),
      status: "unavailable",
      headline: "Draft manuscript without a generated snapshot",
      summary: "No analytics snapshot has been generated.",
      entryPoint: { title: "Draft", startHere: "Generate analytics before publication.", readOrder: [], interpretation: "Draft only." },
      metrics: {
        code: { articles: 0, sections: 0, words: 0, avgWordsPerSection: 0 },
        sources: { checkedAt: "not-generated", total: 0, ok: 0, empty: 0, unavailable: 0, stale: 0, present: 0, missing: 0, coveragePercent: 0, coverageStatus: "none", presentSources: [], missingSources: [], degraded: 0, sources: [], registryCount: 0, monitoredCount: 0, discoveryOnlyCount: 0, referenceOnlyCount: 0 },
        content: { news: 0, meetings: 0, youtube: 0, curated: 0, searchQueries: 0 },
        alerts: { totalEvents: 0, mostActiveType: null, mostRecent: null },
      },
      code: { totalArticles: 0, totalSections: 0, totalWords: 0, avgWordsPerSection: 0, minSectionWords: 0, maxSectionWords: 0, titleBreakdown: {} },
      sources: { degraded: [], coverageGaps: [], registryFingerprint: "" },
      alerts: { level: "UNKNOWN", reason: "No snapshot generated.", assessedAt: null, analytics: { totalEvents: 0, mostActiveType: null, mostRecentAlert: null, typeStats: {} } },
      content: { recent: [], curated: [] },
      pipeline: { status: null, runId: null, completedAt: null, curationProvider: null, curationModel: null, reportPeriod: null },
      signals: [],
      llm: { status: "not-requested", provider: "not-configured", model: "not-configured", promptVersion: "draft", inputFingerprint: "0".repeat(64), summarizedAt: null },
    } as AnalyticsOverview;
  }
}

function substitute(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (whole, name: string) => {
    if (!MANUSCRIPT_VARIABLE_NAMES.has(name)) throw new Error(`Unknown manuscript variable ${whole}`);
    return variables[name] ?? whole;
  });
}

async function clearGeneratedOutput(): Promise<void> {
  await mkdir(paths.manuscriptOutput, { recursive: true });
  for (const file of await readdir(paths.manuscriptOutput)) {
    if (file.endsWith(".md") || file.endsWith(".bib") || file === "config.yaml" || file === "preamble.md") {
      await unlink(join(paths.manuscriptOutput, file));
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(sourceDir)) throw new Error(`Missing manuscript source directory: ${sourceDir}`);
  const overview = await readOverview();
  const variables = valuesFromOverview(overview);
  await clearGeneratedOutput();

  const sourceFiles = (await readdir(sourceDir)).filter(file => file.endsWith(".md") && !["AGENTS.md", "README.md", "SYNTAX.md"].includes(file)).sort();
  for (const file of sourceFiles) {
    const source = await readFile(join(sourceDir, file), "utf8");
    await writeTextAtomic(join(paths.manuscriptOutput, file), substitute(source, variables));
  }
  for (const file of ["config.yaml", "preamble.md", "references.bib"]) {
    const source = join(sourceDir, file);
    if (existsSync(source)) await copyFile(source, join(paths.manuscriptOutput, file));
  }
  await writeJsonAtomic(paths.manuscriptVariables, { schemaVersion: "1.0.0", generatedAt: overview.generatedAt, inputFingerprint: overview.inputFingerprint, variables });
  console.log(`Hydrated ${sourceFiles.length} manuscript files from ${overview.inputFingerprint}`);
}

await main();

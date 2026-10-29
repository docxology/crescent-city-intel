/**
 * Tests for monitor.ts
 *
 * Real isolated empty and reviewed-seed corpora. Redirecting only reportPath
 * does not isolate the producer's identity, lease, diff and snapshot writes.
 */
import { describe, expect, test } from "bun:test";
import { checkHashes, checkSectionCoverage, runMonitor } from "../src/monitor";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { withOutputRoot, paths } from "../src/shared/paths.ts";
import { writeSeedCorpus } from "./helpers/output-root.ts";
import type { ArticlePage, ScrapeManifest, TocNode } from "../src/types.ts";

async function withMonitorRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cci-monitor-"));
  try { await withOutputRoot(root, () => body(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("runMonitor", () => {
  test("returns an explicit error for an isolated absent corpus", () => withMonitorRoot(async root => {
    const report = await runMonitor({ outputDir: root });
    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("overallStatus");
    expect(report).toHaveProperty("articlesChecked");
    expect(report).toHaveProperty("hashMismatches");
    expect(report).toHaveProperty("missingSections");
    expect(report).toHaveProperty("newSections");
    expect(report).toHaveProperty("summary");
    expect(report.overallStatus).toBe("error");
    expect(report.articlesChecked).toBe(0);
    expect(typeof report.articlesChecked).toBe("number");
    expect(Array.isArray(report.hashMismatches)).toBe(true);
    expect(Array.isArray(report.missingSections)).toBe(true);
    expect(Array.isArray(report.newSections)).toBe(true);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }));

  test("an intact corpus is clean and corrupt bytes cannot replace its accepted report", () => withMonitorRoot(async root => {
    await writeSeedCorpus(root, { articleCount: 1 });
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as ScrapeManifest;
    const guid = Object.keys(manifest.articles)[0]!;
    const article = JSON.parse(await readFile(paths.article(guid), "utf8")) as ArticlePage;
    const toc = JSON.parse(await readFile(paths.toc, "utf8")) as TocNode;
    const selected = new Set(article.sections.map(section => section.guid));
    const prune = (node: TocNode): TocNode => ({ ...node, children: node.children.map(prune).filter(child => child.children.length > 0 || child.type === "section" && selected.has(child.guid)) });
    await writeFile(paths.toc, JSON.stringify(prune(toc)));
    expect(await checkHashes()).toEqual({ checked: 1, mismatches: [] });
    expect(await checkSectionCoverage()).toEqual({ missing: [], extra: [] });
    expect((await runMonitor({ outputDir: root })).overallStatus).toBe("clean");
    const baseline = await readFile(paths.manifest, "utf8");
    const acceptedReport = await readFile(paths.monitorReport, "utf8");
    await writeFile(paths.article(guid), JSON.stringify({ ...article, rawHtml: `${article.rawHtml}\nchanged fixture bytes` }));
    const changed = await checkHashes();
    expect(changed.mismatches).toHaveLength(1);
    expect(changed.mismatches[0]).toContain("hash mismatch vs manifest baseline");
    await expect(runMonitor({ outputDir: root })).rejects.toThrow("corpus is incomplete");
    expect(await readFile(paths.manifest, "utf8")).toBe(baseline);
    expect(await readFile(paths.monitorReport, "utf8")).toBe(acceptedReport);
  }));
});

describe("checkHashes", () => {
  test("rejects an absent manifest explicitly", () => withMonitorRoot(async () => {
    await expect(checkHashes()).rejects.toThrow("Failed to load manifest");
  }));
});

describe("checkSectionCoverage", () => {
  test("rejects an absent TOC explicitly", () => withMonitorRoot(async () => {
    await expect(checkSectionCoverage()).rejects.toThrow("Failed to load TOC");
  }));
});

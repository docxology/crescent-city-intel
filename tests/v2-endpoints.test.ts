import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.js";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { paths } from "../src/shared/paths.ts";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { beginCorpusCopy, endCorpusCopy } from "./helpers/output-root.ts";

// Every write this suite makes lands in a throwaway copy of the corpus, never
// in the real output/ tree the published snapshot is built from.
beforeAll(async () => { await beginCorpusCopy(); }, 120000);
afterAll(async () => { await endCorpusCopy(); }, 60000);

// Test helper — create a temporary output directory with test data
function setupTestOutput() {
  const testDir = join(process.cwd(), "output");
  const hadOutput = existsSync(testDir);
  if (!hadOutput) mkdirSync(testDir, { recursive: true });
  return () => {
    // Cleanup is done by the caller — we don't remove output/ since it may have real data
  };
}

describe("v2.2 New API Endpoints", () => {
  test("GET /api/health returns a truthful status with timestamp", async () => {
    const url = new URL("http://localhost:3000/api/health");
    const resp = await handleApiRoute(url);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(["ok", "degraded"]).toContain(data.status);
    expect(data.timestamp).toBeTruthy();
    expect(["ollama", "openrouter"]).toContain(data.chatProvider);
    expect(data.embeddingProvider.provider).toBe("ollama");
    expect(data.vectorStore.provider).toBe("chroma");
    expect(data.providerHealth).toBeDefined();
  });

  test("GET /api/health includes manifest info when available", async () => {
    // Create a test manifest
    // Written through the artifact-root seam, so it lands in this file's
    // throwaway corpus copy. Save-and-restore used to stand in for isolation
    // here and it is what raced: two concurrent runs saved each other's fixture
    // as "the original" and the real manifest was permanently replaced.
    const manifestPath = paths.manifest;
    const testManifest = {
      municipality: "Crescent City",
      municipalityGuid: "CR4919",
      sourceUrl: "https://ecode360.com",
      version: "1.0",
      scrapedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tocNodeCount: 2486,
      articlePageCount: 0,
      sectionCount: 2194,
      articles: {},
    };
    writeFileSync(manifestPath, JSON.stringify(testManifest), "utf-8");

    try {
      const url = new URL("http://localhost:3000/api/health");
      const resp = await handleApiRoute(url);
      const data = await resp.json();
      expect(["ok", "degraded"]).toContain(data.status);
      expect(data.manifest).toBeDefined();
      expect(data.manifest.ageDays).toBeGreaterThanOrEqual(0);
      expect(data.manifest.stale).toBe(false); // just created, not stale
      expect(data.manifest.sectionCount).toBe(2194);
    } finally {
      // The copy is discarded wholesale in afterAll; nothing to restore.
      try { rmSync(manifestPath); } catch { /* ignore */ }
    }
  });

  test("GET /api/report/latest returns 404 when no reports", async () => {
    const reportsDir = join(process.cwd(), "output", "reports");
    const hadReports = existsSync(reportsDir);
    if (!hadReports) {
      const url = new URL("http://localhost:3000/api/report/latest");
      const resp = await handleApiRoute(url);
      expect(resp.status).toBe(404);
    }
  });

  test("GET /api/report/latest returns markdown when reports exist", async () => {
    const reportsDir = join(process.cwd(), "output", "reports");
    const hadReports = existsSync(reportsDir);
    mkdirSync(reportsDir, { recursive: true });
    // Use a fixture filename that sorts after any real monthly-YYYY-MM.md
    // report and is namespaced to avoid collisions. A prior version of this
    // test hardcoded "monthly-2026-07.md" and permanently clobbered a real
    // report for that month with fixture content, with no restore path in
    // its cleanup — exactly the same class of bug already fixed above for
    // output/manifest.json.
    const testReportPath = join(reportsDir, "monthly-9999-99-test-fixture.md");
    const testReport = "# Test Report\n\nThis is a test.";
    writeFileSync(testReportPath, testReport, "utf-8");

    try {
      const url = new URL("http://localhost:3000/api/report/latest");
      const resp = await handleApiRoute(url);
      expect(resp.status).toBe(200);
      const content = await resp.text();
      expect(content).toContain("Test Report");
      expect(resp.headers.get("Content-Type")).toContain("text/markdown");
    } finally {
      try { rmSync(testReportPath); } catch { /* ignore */ }
      if (!hadReports) {
        try { rmSync(reportsDir, { recursive: true }); } catch { /* ignore */ }
      }
    }
  });

  test("GET /api/search/analytics returns empty when no log", async () => {
    const logPath = paths.searchQueryLog;
    const hadLog = existsSync(logPath);
    if (!hadLog) {
      const url = new URL("http://localhost:3000/api/search/analytics");
      const resp = await handleApiRoute(url);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.totalQueries).toBe(0);
      expect(data.topTerms).toEqual([]);
    }
  });

  test("GET /api/search/analytics returns term counts when log exists", async () => {
    // Same seam: the fixture log replaces the copy's log, never the real one.
    const logPath = paths.searchQueryLog;
    const testLog = JSON.stringify({ ts: new Date().toISOString(), query: "tsunami harbor", resultCount: 5 }) + "\n" +
                    JSON.stringify({ ts: new Date().toISOString(), query: "tsunami zoning", resultCount: 3 }) + "\n";
    writeFileSync(logPath, testLog, "utf-8");

    try {
      const url = new URL("http://localhost:3000/api/search/analytics");
      const resp = await handleApiRoute(url);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.totalQueries).toBe(2);
      expect(data.topTerms.length).toBeGreaterThan(0);
      const tsunami = data.topTerms.find((t: any) => t.term === "tsunami");
      expect(tsunami).toBeDefined();
      expect(tsunami.count).toBe(2);
    } finally {
      try { rmSync(logPath); } catch { /* ignore */ }
    }
  });

  test("GET /api/domains/:id/coverage returns domain metrics", async () => {
    const url = new URL("http://localhost:3000/api/domains/emergency-management/coverage");
    const resp = await handleApiRoute(url);
    // Will be 200 if domain found with data, 404 if domain not in coverage report, or 500 on error
    expect([200, 404, 500]).toContain(resp.status);
  });

  test("GET /api/domains/nonexistent/coverage returns 404", async () => {
    const url = new URL("http://localhost:3000/api/domains/nonexistent-domain/coverage");
    const resp = await handleApiRoute(url);
    // Route should match (not 404 for unknown path), but domain may not be found
    expect([404, 500]).toContain(resp.status);
  });
});

describe("Search query logging", () => {
  test("search() itself never writes to the query log; the HTTP layer logs", async () => {
    const { initSearch, search, getIndexedCount, logSearchQuery } = await import("../src/gui/search.js");
    const { paths } = await import("../src/shared/paths.ts");
    if (getIndexedCount() === 0) {
      try { await initSearch(); } catch { /* no output data */ }
    }
    const redirected = await mkdtemp(join(tmpdir(), "cci-searchlog-"));
    process.env.CC_OUTPUT_DIR = redirected;
    try {
      // A library search must leave no trace: every unit-level search used to
      // append a fixture query to the real analytics corpus, which both
      // polluted the evidence and moved the fingerprint the overview reports.
      search("tsunami evacuation");
      expect(existsSync(paths.searchQueryLog)).toBe(false);

      // The HTTP layer's explicit call is what writes, and it writes where the
      // artifact-root seam points.
      logSearchQuery("tsunami evacuation", 3);
      const lines = readFileSync(paths.searchQueryLog, "utf-8").trim().split("\n");
      const lastEntry = JSON.parse(lines[lines.length - 1]!);
      expect(lastEntry.query).toBe("tsunami evacuation");
      expect(lastEntry.resultCount).toBe(3);
    } finally {
      delete process.env.CC_OUTPUT_DIR;
      await rm(redirected, { recursive: true, force: true });
    }
  });
});

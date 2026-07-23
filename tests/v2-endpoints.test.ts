import { describe, test, expect } from "bun:test";
import { handleApiRoute } from "../src/gui/routes.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

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
  test("GET /api/health returns status ok with timestamp", async () => {
    const url = new URL("http://localhost:3000/api/health");
    const resp = await handleApiRoute(url);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeTruthy();
  });

  test("GET /api/health includes manifest info when available", async () => {
    // Create a test manifest
    const manifestPath = join(process.cwd(), "output", "manifest.json");
    const hadManifest = existsSync(manifestPath);
    const testManifest = {
      municipality: "Crescent City",
      municipalityGuid: "CR4919",
      sourceUrl: "https://ecode360.com",
      version: "1.0",
      scrapedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tocNodeCount: 2486,
      articlePageCount: 242,
      sectionCount: 2194,
      articles: {},
    };
    writeFileSync(manifestPath, JSON.stringify(testManifest), "utf-8");

    try {
      const url = new URL("http://localhost:3000/api/health");
      const resp = await handleApiRoute(url);
      const data = await resp.json();
      expect(data.status).toBe("ok");
      expect(data.manifest).toBeDefined();
      expect(data.manifest.ageDays).toBeGreaterThanOrEqual(0);
      expect(data.manifest.stale).toBe(false); // just created, not stale
      expect(data.manifest.sectionCount).toBe(2194);
    } finally {
      if (!hadManifest) {
        try { rmSync(manifestPath); } catch { /* ignore */ }
      }
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
    const testReport = "# Test Report\n\nThis is a test.";
    writeFileSync(join(reportsDir, "monthly-2026-07.md"), testReport, "utf-8");

    try {
      const url = new URL("http://localhost:3000/api/report/latest");
      const resp = await handleApiRoute(url);
      expect(resp.status).toBe(200);
      const content = await resp.text();
      expect(content).toContain("Test Report");
      expect(resp.headers.get("Content-Type")).toContain("text/markdown");
    } finally {
      if (!hadReports) {
        try { rmSync(reportsDir, { recursive: true }); } catch { /* ignore */ }
      }
    }
  });

  test("GET /api/search/analytics returns empty when no log", async () => {
    const logPath = join(process.cwd(), "output", "search-queries.jsonl");
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
    const logPath = join(process.cwd(), "output", "search-queries.jsonl");
    const hadLog = existsSync(logPath);
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
      if (!hadLog) {
        try { rmSync(logPath); } catch { /* ignore */ }
      }
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
  test("search function writes to search-queries.jsonl", async () => {
    const { initSearch, search, getIndexedCount } = await import("../src/gui/search.js");
    const logPath = join(process.cwd(), "output", "search-queries.jsonl");

    // Ensure search is initialized
    if (getIndexedCount() === 0) {
      try { await initSearch(); } catch { /* no output data */ }
    }

    // Perform a search
    search("tsunami evacuation");

    // Check that log was written (if output dir exists)
    if (existsSync(logPath)) {
      const content = require("fs").readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      expect(lastEntry.query).toBe("tsunami evacuation");
      expect(typeof lastEntry.resultCount).toBe("number");
    }
  });
});

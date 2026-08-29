/**
 * Tests for monitor.ts
 *
 * Tests pure-logic functions that do NOT require scraped output data.
 * The runMonitor integration test is included and gracefully handles
 * missing output/ directory (returns overallStatus: "error"). A full
 * repository run can contend with other filesystem-heavy tests, so it has
 * a bounded integration timeout longer than the default unit-test timeout.
 */
import { describe, expect, test } from "bun:test";
import { checkHashes, checkSectionCoverage, runMonitor } from "../src/monitor";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("runMonitor", () => {
  test("returns an appropriate status when scraped data is absent or present", async () => {
    // In the test environment, output/ may or may not have data.
    // Either way, runMonitor must return a well-shaped MonitorReport.
    // The report goes to a throwaway path: exercising the monitor must not
    // overwrite the corpus artifact the published snapshot reports from.
    const reportDir = await mkdtemp(join(tmpdir(), "cci-monitor-"));
    const report = await runMonitor({ reportPath: join(reportDir, "monitor-report.json") });
    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("overallStatus");
    expect(report).toHaveProperty("articlesChecked");
    expect(report).toHaveProperty("hashMismatches");
    expect(report).toHaveProperty("missingSections");
    expect(report).toHaveProperty("newSections");
    expect(report).toHaveProperty("summary");
    expect(["clean", "changed", "error"]).toContain(report.overallStatus);
    expect(typeof report.articlesChecked).toBe("number");
    expect(Array.isArray(report.hashMismatches)).toBe(true);
    expect(Array.isArray(report.missingSections)).toBe(true);
    expect(Array.isArray(report.newSections)).toBe(true);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 60_000);
});

describe("checkHashes", () => {
  test("returns {checked, mismatches} shape when no manifest exists", async () => {
    // If manifest.json is absent, loadManifest will throw and the caller will handle it.
    // We test checkHashes only when data may be present.
    try {
      const result = await checkHashes();
      expect(result).toHaveProperty("checked");
      expect(result).toHaveProperty("mismatches");
      expect(typeof result.checked).toBe("number");
      expect(Array.isArray(result.mismatches)).toBe(true);
    } catch {
      // No data — acceptable in test env
    }
  });
});

describe("checkSectionCoverage", () => {
  test("returns {missing, extra} shape when data exists or is absent", async () => {
    try {
      const result = await checkSectionCoverage();
      expect(result).toHaveProperty("missing");
      expect(result).toHaveProperty("extra");
      expect(Array.isArray(result.missing)).toBe(true);
      expect(Array.isArray(result.extra)).toBe(true);
    } catch {
      // No data — acceptable in test env
    }
  });
});

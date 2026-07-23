import { describe, test, expect } from "bun:test";
import {
  buildAlertAnalytics,
  getRecentAlerts,
} from "../src/alert_analytics.js";

describe("alert_analytics", () => {
  test("buildAlertAnalytics returns a report with expected shape", () => {
    const report = buildAlertAnalytics();
    expect(report).toHaveProperty("generatedAt");
    expect(report).toHaveProperty("timeline");
    expect(report).toHaveProperty("typeStats");
    expect(report).toHaveProperty("totalEvents");
    expect(report).toHaveProperty("mostRecentAlert");
    expect(report).toHaveProperty("mostActiveType");
    expect(Array.isArray(report.timeline)).toBe(true);
    expect(Array.isArray(report.typeStats)).toBe(true);
    expect(typeof report.totalEvents).toBe("number");
  });

  test("typeStats covers all 8 alert types", () => {
    const report = buildAlertAnalytics();
    const types = report.typeStats.map(s => s.type);
    expect(types).toContain("tsunami");
    expect(types).toContain("earthquake");
    expect(types).toContain("weather");
    expect(types).toContain("tides");
    expect(types).toContain("fishing");
    expect(types).toContain("airquality");
    expect(types).toContain("wildfire");
    expect(types).toContain("marine");
  });

  test("each typeStat has required fields", () => {
    const report = buildAlertAnalytics();
    for (const stat of report.typeStats) {
      expect(stat).toHaveProperty("type");
      expect(stat).toHaveProperty("totalEvents");
      expect(stat).toHaveProperty("firstEvent");
      expect(stat).toHaveProperty("lastEvent");
      expect(stat).toHaveProperty("severityCounts");
      expect(stat).toHaveProperty("avgPerDay");
    }
  });

  test("getRecentAlerts returns array with default limit", () => {
    const recent = getRecentAlerts();
    expect(Array.isArray(recent)).toBe(true);
    expect(recent.length).toBeLessThanOrEqual(20);
  });

  test("getRecentAlerts respects custom limit", () => {
    const recent = getRecentAlerts(5);
    expect(recent.length).toBeLessThanOrEqual(5);
  });

  test("timeline entries have required fields when present", () => {
    const report = buildAlertAnalytics();
    for (const entry of report.timeline.slice(0, 5)) {
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("type");
      expect(entry).toHaveProperty("severity");
      expect(entry).toHaveProperty("description");
    }
  });

  test("generatedAt is a valid ISO timestamp", () => {
    const report = buildAlertAnalytics();
    expect(() => new Date(report.generatedAt).toISOString()).not.toThrow();
  });

  test("totalEvents matches sum of typeStat counts", () => {
    const report = buildAlertAnalytics();
    const sum = report.typeStats.reduce((a, s) => a + s.totalEvents, 0);
    expect(report.totalEvents).toBe(sum);
  });
});

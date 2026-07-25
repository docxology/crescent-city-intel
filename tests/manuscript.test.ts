import { describe, expect, test } from "bun:test";
import type { AnalyticsOverview } from "../src/analytics_backend.ts";
import { MANUSCRIPT_VARIABLE_NAMES, valuesFromOverview } from "../src/manuscript_variables.ts";

function fixture(): AnalyticsOverview {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-24T21:47:24.750Z",
    inputFingerprint: "a".repeat(64),
    status: "degraded",
    headline: "WARNING",
    summary: "summary",
    entryPoint: { title: "start", startHere: "start", readOrder: [], interpretation: "bounded" },
    metrics: {
      code: { articles: 245, sections: 2194, words: 359990, avgWordsPerSection: 164 },
      sources: { checkedAt: "2026-07-24T21:47:24.750Z", total: 18, ok: 8, empty: 5, unavailable: 5, stale: 0, present: 13, missing: 5, coveragePercent: 72.2, coverageStatus: "partial", presentSources: [], missingSources: [], degraded: 5, sources: [], registryCount: 33, monitoredCount: 16, discoveryOnlyCount: 15, referenceOnlyCount: 2 },
      content: { news: 10, meetings: 2, youtube: 1, curated: 0, searchQueries: 0 },
      alerts: { totalEvents: 25, mostActiveType: "marine", mostRecent: "tide" },
    },
    code: {} as AnalyticsOverview["code"],
    sources: { degraded: [], coverageGaps: [], registryFingerprint: "b".repeat(64) },
    alerts: { level: "WARNING", reason: "Tides: high tide", assessedAt: null, analytics: {} as AnalyticsOverview["alerts"]["analytics"] },
    content: { recent: [], curated: [] },
    pipeline: { status: "degraded", runId: null, completedAt: null, curationProvider: null, curationModel: null, reportPeriod: null },
    signals: [],
    llm: { status: "ok", provider: "openrouter", model: "model", promptVersion: "prompt", inputFingerprint: "a".repeat(64), summarizedAt: "2026-07-24T21:47:24.750Z" },
  };
}

describe("manuscript evidence adapter", () => {
  test("derives every publication value from the overview without an extra source of truth", () => {
    const values = valuesFromOverview(fixture());
    expect(values.SNAPSHOT_DATE).toBe("2026-07-24T21:47:24.750Z");
    expect(values.CODE_SECTIONS).toBe("2,194");
    expect(values.SOURCE_UNAVAILABLE).toBe("5");
    expect(values.ALERT_LEVEL).toBe("WARNING");
    expect(values.ANALYTICS_FINGERPRINT).toBe("a".repeat(64));
    expect(Object.keys(values).sort()).toEqual([...MANUSCRIPT_VARIABLE_NAMES].sort());
  });
});

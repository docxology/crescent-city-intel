import { describe, expect, test } from "bun:test";
import { buildAnalyticsOverview } from "../src/analytics_backend.ts";
import { kmeans, powerIteration } from "../src/gui/analytics.ts";

describe("cross-surface analytics backend", () => {
  test("builds a stable, evidence-fingerprinted overview", async () => {
    const first = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
    const second = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
    const later = await buildAnalyticsOverview({ generatedAt: "2026-07-25T00:00:00.000Z" });

    expect(first.schemaVersion).toBe("1.0.0");
    expect(first.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(later.inputFingerprint).toBe(first.inputFingerprint);
    expect(first.metrics.sources.registryCount).toBeGreaterThan(0);
    expect(Array.isArray(first.signals)).toBe(true);
    expect(first.llm.status).toBe("not-requested");
  }, 120000);

  test("handles a partially indexed embedding set without undefined clusters", () => {
    const result = kmeans([[1, 2]], 6);
    expect(result.centroids).toHaveLength(1);
    expect(result.assignments).toEqual([0]);

    const projection = powerIteration([new Float64Array([0, 0])], 2, null);
    expect(projection.eigenvalue).toBe(0);
    expect([...projection.vector]).toHaveLength(2);
  });
});

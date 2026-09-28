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

  test("the input fingerprint follows the query evidence, and only the evidence", async () => {
    // The fingerprint's whole job is to say whether two overviews were computed
    // from the same evidence. It was flaky for a different reason (a test suite
    // appending to the live query log while it ran), and the fix for that must
    // not become "stop hashing the log": an overview built from different query
    // evidence is a different overview and has to say so.
    const { withCorpusCopy } = await import("./helpers/output-root.ts");
    const { writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");

    const fingerprints = await withCorpusCopy(async root => {
      const log = join(root, "search-queries.jsonl");
      await mkdir(root, { recursive: true });
      await writeFile(log, `${JSON.stringify({ ts: "2026-01-01T00:00:00Z", query: "harbor", resultCount: 2 })}\n`);
      const first = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
      const repeat = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
      await writeFile(log, `${JSON.stringify({ ts: "2026-01-01T00:00:00Z", query: "zoning", resultCount: 5 })}\n`);
      const changed = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
      return { first: first.inputFingerprint, repeat: repeat.inputFingerprint, changed: changed.inputFingerprint };
    });

    expect(fingerprints.repeat).toBe(fingerprints.first);
    expect(fingerprints.changed).not.toBe(fingerprints.first);
    // Cost note, measured 2026-09-28: this test builds THREE full analytics
    // overviews over the real corpus (~65s each, ~196s total) because the
    // property under test needs two identical builds and one differing one.
    // The 300s ceiling it used to carry left almost no headroom — under full-
    // suite parallelism this test hit exactly 300,001ms and failed, while
    // passing in isolation. That is a pre-existing fragility, not a regression,
    // and the honest fix is to make the overview cheaper over a small fixture
    // corpus rather than to keep raising the number; until then the margin
    // below is what stands between a loaded machine and a red build.
  }, 480000);

  test("handles a partially indexed embedding set without undefined clusters", () => {
    const result = kmeans([[1, 2]], 6);
    expect(result.centroids).toHaveLength(1);
    expect(result.assignments).toEqual([0]);

    const projection = powerIteration([new Float64Array([0, 0])], 2, null);
    expect(projection.eigenvalue).toBe(0);
    expect([...projection.vector]).toHaveLength(2);
  });
});

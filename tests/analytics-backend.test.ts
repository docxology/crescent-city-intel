import { describe, expect, test } from "bun:test";
import { buildAnalyticsOverview } from "../src/analytics_backend.ts";
import { kmeans, powerIteration } from "../src/gui/analytics.ts";

/**
 * Article count for the overview fixtures.
 *
 * `getCodeStats` reads every article through `loadAllArticles()`, and over the
 * real 2,206-section corpus each overview build cost ~65s. These tests assert
 * FINGERPRINT stability and signal shape — neither depends on the corpus size —
 * so a small fixture produces the same contract in a fraction of the time.
 * 6 articles is the smallest count that still yields a multi-title code-stat
 * shape, which is what the `metrics.code` assertions below read.
 */
const FIXTURE_ARTICLES = 6;

describe("cross-surface analytics backend", () => {
  test("builds a stable, evidence-fingerprinted overview", async () => {
    const { withMinimalCorpus } = await import("./helpers/output-root.ts");
    await withMinimalCorpus(FIXTURE_ARTICLES, async () => {
      const first = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
      const second = await buildAnalyticsOverview({ generatedAt: "2026-07-24T00:00:00.000Z" });
      const later = await buildAnalyticsOverview({ generatedAt: "2026-07-25T00:00:00.000Z" });

      expect(first.schemaVersion).toBe("1.0.0");
      expect(first.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
      // A repeated build over identical evidence is the same overview, and a
      // different `generatedAt` alone must NOT change the fingerprint — it is
      // the *evidence* the fingerprint covers, not the clock.
      expect(second.inputFingerprint).toBe(first.inputFingerprint);
      expect(later.inputFingerprint).toBe(first.inputFingerprint);
      expect(first.metrics.sources.registryCount).toBeGreaterThan(0);
      expect(Array.isArray(first.signals)).toBe(true);
      expect(first.llm.status).toBe("not-requested");
    });
  }, 120000);

  test("the input fingerprint follows the query evidence, and only the evidence", async () => {
    // The fingerprint's whole job is to say whether two overviews were computed
    // from the same evidence. It was flaky for a different reason (a test suite
    // appending to the live query log while it ran), and the fix for that must
    // not become "stop hashing the log": an overview built from different query
    // evidence is a different overview and has to say so.
    const { withMinimalCorpus } = await import("./helpers/output-root.ts");
    const { writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");

    const fingerprints = await withMinimalCorpus(FIXTURE_ARTICLES, async root => {
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
  }, 300000);

  test("handles a partially indexed embedding set without undefined clusters", () => {
    const result = kmeans([[1, 2]], 6);
    expect(result.centroids).toHaveLength(1);
    expect(result.assignments).toEqual([0]);

    const projection = powerIteration([new Float64Array([0, 0])], 2, null);
    expect(projection.eigenvalue).toBe(0);
    expect([...projection.vector]).toHaveLength(2);
  });
});

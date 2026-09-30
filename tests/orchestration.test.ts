import { describe, expect, test } from "bun:test";
import {
  buildPipelineRun,
  createRunId,
  executePipelineStep,
} from "../src/shared/orchestration.ts";
import { completeSourceHealth, EXPECTED_SOURCE_HEALTH, sourceHealth, summarizeSourceHealth } from "../src/shared/source_health.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitWithSignal } from "../src/shared/transport.ts";

describe("orchestration and metadata contracts", () => {
  test("a durable running receipt precedes work and a parent deadline signals cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cci-stage-receipt-")); const receiptPath = join(root, "stage.json"); let cancelled = false;
    try {
      const pending = executePipelineStep("bounded-stage", async signal => { signal.addEventListener("abort", () => { cancelled = true; }, { once: true }); expect(JSON.parse(await readFile(receiptPath, "utf8")).status).toBe("running"); await waitWithSignal(10_000, signal); return "late"; }, { timeoutMs: 40, receiptPath });
      const result = await pending; expect(result.report.status).toBe("failed"); expect(result.value).toBeUndefined(); expect(cancelled).toBe(true);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")); expect(receipt.status).toBe("failed"); expect(receipt.startedAt).toBe(result.report.startedAt); expect(receipt.durationMs).toBeLessThan(500);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("source health derives freshness without changing operational status", () => {
    const checkedAt = "2026-07-24T12:00:00.000Z";
    const fetchedAt = "2026-07-24T11:59:30.000Z";
    const health = sourceHealth("Fixture", "ok", checkedAt, {
      fetchedAt,
      itemCount: 2,
      freshnessWindowMs: 60_000,
    });
    expect(health.status).toBe("ok");
    expect(health.freshness).toBe("fresh");
    expect(health.freshnessWindowMs).toBe(60_000);
  });

  test("summary distinguishes present coverage from missing sources", () => {
    const sources = [
      sourceHealth("Healthy", "ok", new Date().toISOString(), { itemCount: 1 }),
      sourceHealth("Empty", "empty", new Date().toISOString()),
      sourceHealth("Down", "unavailable", new Date().toISOString(), { error: "fixture" }),
      sourceHealth("Old", "stale", new Date().toISOString(), { error: "fixture" }),
    ];
    const summary = summarizeSourceHealth(sources, "2026-07-24T12:00:00.000Z");
    expect(summary).toMatchObject({ total: 4, ok: 1, empty: 1, unavailable: 1, stale: 1, present: 2, missing: 2, coveragePercent: 50, coverageStatus: "partial", degraded: 2 });
    expect(summary.presentSources).toEqual(["Empty", "Healthy"]);
    expect(summary.missingSources).toEqual(["Down", "Old"]);
    expect(summary.sources).toEqual(["Down", "Empty", "Healthy", "Old"]);
  });

  test("completion names absent monitor records without changing empty semantics", () => {
    const checkedAt = "2026-07-24T12:00:00.000Z";
    const completed = completeSourceHealth([
      sourceHealth("NOAA Tsunami", "empty", checkedAt),
    ], checkedAt);
    expect(completed).toHaveLength(EXPECTED_SOURCE_HEALTH.length);
    expect(completed.find(source => source.source === "NOAA Tsunami")?.status).toBe("empty");
    const missing = completed.find(source => source.source === "Lost Coast Outpost");
    expect(missing?.status).toBe("unavailable");
    expect(missing?.error).toContain("No news source-health record");
  });

  test("pipeline step preserves duration and retryable failure evidence", async () => {
    const success = await executePipelineStep("fixture-success", async () => [1, 2, 3], {
      itemCount: value => value.length,
      outputPaths: ["output/fixture.json"],
    });
    expect(success.report.status).toBe("ok");
    expect(success.report.itemCount).toBe(3);
    expect(success.report.durationMs).toBeGreaterThanOrEqual(0);

    const failure = await executePipelineStep("fixture-failure", async () => {
      throw new Error("retry me");
    });
    expect(failure.value).toBeUndefined();
    expect(failure.report.status).toBe("failed");
    expect(failure.report.error).toBe("retry me");
  });

  test("run envelope remains operational when a source is unavailable", () => {
    const startedAt = "2026-07-24T12:00:00.000Z";
    const report = buildPipelineRun(
      "fixture",
      createRunId("fixture", startedAt),
      startedAt,
      [{
        name: "fixture",
        status: "ok",
        startedAt,
        completedAt: "2026-07-24T12:00:01.000Z",
        durationMs: 1000,
      }],
      [sourceHealth("Down", "unavailable", startedAt, { error: "offline" })],
      0,
      "2026-07-24T12:00:01.000Z",
    );
    expect(report.schemaVersion).toBe("1.0.0");
    expect(report.status).toBe("ok");
    expect(report.sourceHealth.degraded).toBe(1);
    expect(report.sourceHealth.present).toBe(0);
    expect(report.sourceHealth.missing).toBe(1);
    expect(report.metadata.runtime).toContain("bun/");
  });
});

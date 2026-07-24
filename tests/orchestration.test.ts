import { describe, expect, test } from "bun:test";
import {
  buildPipelineRun,
  createRunId,
  executePipelineStep,
} from "../src/shared/orchestration.ts";
import { sourceHealth, summarizeSourceHealth } from "../src/shared/source_health.ts";

describe("orchestration and metadata contracts", () => {
  test("source health derives freshness without changing operational status", () => {
    const checkedAt = "2026-07-24T12:00:00.000Z";
    const fetchedAt = new Date().toISOString();
    const health = sourceHealth("Fixture", "ok", checkedAt, {
      fetchedAt,
      itemCount: 2,
      freshnessWindowMs: 60_000,
    });
    expect(health.status).toBe("ok");
    expect(health.freshness).toBe("fresh");
    expect(health.freshnessWindowMs).toBe(60_000);
  });

  test("summary counts unavailable and stale sources as degraded", () => {
    const sources = [
      sourceHealth("Healthy", "ok", new Date().toISOString(), { itemCount: 1 }),
      sourceHealth("Empty", "empty", new Date().toISOString()),
      sourceHealth("Down", "unavailable", new Date().toISOString(), { error: "fixture" }),
      sourceHealth("Old", "stale", new Date().toISOString(), { error: "fixture" }),
    ];
    const summary = summarizeSourceHealth(sources, "2026-07-24T12:00:00.000Z");
    expect(summary).toMatchObject({ total: 4, ok: 1, empty: 1, unavailable: 1, stale: 1, degraded: 2 });
    expect(summary.sources).toEqual(["Down", "Empty", "Healthy", "Old"]);
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

  test("run envelope is degraded when source health is unavailable", () => {
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
    expect(report.status).toBe("degraded");
    expect(report.sourceHealth.degraded).toBe(1);
    expect(report.metadata.runtime).toContain("bun/");
  });
});

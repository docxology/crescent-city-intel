import { describe, test, expect } from "bun:test";
import {
  detectCloudflareStall,
  withRetry,
  isMaintenanceMode,
  formatProgressBar,
  ScrapeMetricsCollector,
} from "../src/scraper_utils.js";

describe("detectCloudflareStall", () => {
  test("returns true when elapsed time exceeds maxWait", () => {
    const past = Date.now() - 15_000;
    expect(detectCloudflareStall(past, 10_000)).toBe(true);
  });

  test("returns false when elapsed time is under maxWait", () => {
    const recent = Date.now() - 5_000;
    expect(detectCloudflareStall(recent, 10_000)).toBe(false);
  });

  test("returns false for just-started timer", () => {
    expect(detectCloudflareStall(Date.now(), 10_000)).toBe(false);
  });
});

describe("withRetry", () => {
  test("succeeds on first try", async () => {
    let calls = 0;
    const { result, retried, attempts } = await withRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(retried).toBe(false);
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const { result, retried, attempts } = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    }, 3, 10); // 10ms base delay for fast tests
    expect(result).toBe("ok");
    expect(retried).toBe(true);
    expect(attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test("throws after max retries", async () => {
    let calls = 0;
    try {
      await withRetry(async () => {
        calls++;
        throw new Error("always fail");
      }, 2, 10);
      expect(false).toBe(true); // should not reach
    } catch (err: any) {
      expect(err.message).toBe("always fail");
      expect(calls).toBe(3); // initial + 2 retries
    }
  });
});

describe("isMaintenanceMode", () => {
  test("detects 503", () => {
    expect(isMaintenanceMode(503, "https://example.com", "https://example.com")).toBe(true);
  });

  test("detects redirect to different URL", () => {
    expect(isMaintenanceMode(302, "https://example.com", "https://other.com")).toBe(true);
  });

  test("returns false for 200", () => {
    expect(isMaintenanceMode(200, "https://example.com", "https://example.com")).toBe(false);
  });

  test("returns false for 404", () => {
    expect(isMaintenanceMode(404, "https://example.com", "https://example.com")).toBe(false);
  });

  test("returns false for redirect to same URL", () => {
    expect(isMaintenanceMode(301, "https://example.com", "https://example.com")).toBe(false);
  });
});

describe("formatProgressBar", () => {
  test("renders 0%", () => {
    const bar = formatProgressBar(0, 100);
    expect(bar).toContain("0%");
    expect(bar).toContain("(0/100)");
    expect(bar).toContain("░");
  });

  test("renders 50%", () => {
    const bar = formatProgressBar(50, 100);
    expect(bar).toContain("50%");
    expect(bar).toContain("█");
  });

  test("renders 100%", () => {
    const bar = formatProgressBar(100, 100);
    expect(bar).toContain("100%");
  });

  test("handles zero total", () => {
    const bar = formatProgressBar(0, 0);
    expect(bar).toContain("0%");
  });
});

describe("ScrapeMetricsCollector", () => {
  test("records and retrieves metrics", () => {
    const collector = new ScrapeMetricsCollector();
    collector.record({ guid: "g1", title: "Test 1", durationMs: 500, sectionCount: 10, success: true });
    collector.record({ guid: "g2", title: "Test 2", durationMs: 1000, sectionCount: 5, success: false, error: "timeout" });
    const metrics = collector.getMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics[0].guid).toBe("g1");
    expect(metrics[1].success).toBe(false);
  });

  test("computes summary", () => {
    const collector = new ScrapeMetricsCollector();
    collector.record({ guid: "g1", title: "A", durationMs: 500, sectionCount: 10, success: true });
    collector.record({ guid: "g2", title: "B", durationMs: 1500, sectionCount: 5, success: true });
    collector.record({ guid: "g3", title: "C", durationMs: 300, sectionCount: 0, success: false, error: "err" });
    const summary = collector.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.avgDurationMs).toBe(1000); // (500 + 1500) / 2
    expect(summary.maxDurationMs).toBe(1500);
    expect(summary.minDurationMs).toBe(500);
  });

  test("empty collector returns zeros", () => {
    const collector = new ScrapeMetricsCollector();
    const summary = collector.getSummary();
    expect(summary.total).toBe(0);
    expect(summary.avgDurationMs).toBe(0);
  });
});

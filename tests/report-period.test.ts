import { describe, expect, test } from "bun:test";
import { inPeriod, parseTargetMonth } from "../src/monthly_report.ts";

describe("monthly report period contract", () => {
  test("uses an exact UTC half-open month interval", () => {
    const period = parseTargetMonth("2026-02");
    expect(period.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    const filtered = inPeriod([
      { timestamp: "2026-01-31T23:59:59.999Z" },
      { timestamp: "2026-02-01T00:00:00.000Z" },
      { timestamp: "2026-02-28T23:59:59.999Z" },
      { timestamp: "2026-03-01T00:00:00.000Z" },
    ], period.start, period.end);
    expect(filtered.items).toHaveLength(2);
    expect(filtered.invalidTimestamps).toBe(0);
  });

  test("rejects invalid periods and reports malformed timestamps", () => {
    expect(() => parseTargetMonth("2026-13")).toThrow("expected YYYY-MM");
    const period = parseTargetMonth("2026-07");
    const result = inPeriod([{ timestamp: "not-a-date" }, { timestamp: "2026-07-04T00:00:00Z" }], period.start, period.end);
    expect(result.items).toHaveLength(1);
    expect(result.invalidTimestamps).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { computeAlertTypeTrends, ALERT_TREND_STEADY_BAND, type TimelineEntry } from "../src/alert_analytics";

const DAY = 24 * 60 * 60 * 1000;

function entry(type: TimelineEntry["type"], ageDays: number, now: number): TimelineEntry {
  return {
    timestamp: new Date(now - ageDays * DAY).toISOString(),
    type,
    severity: "WATCH",
    description: "synthetic test event",
    record: {},
  };
}

describe("computeAlertTypeTrends (per-type 30-day trend summary)", () => {
  const now = new Date("2026-08-28T12:00:00Z").getTime();

  test("steady band constant matches insights STEADY_BAND=1", () => {
    expect(ALERT_TREND_STEADY_BAND).toBe(1);
  });

  test("counts events inside the trailing 30-day window only", () => {
    const entries = [
      entry("tsunami", 5, now),
      entry("tsunami", 10, now),
      entry("tsunami", 45, now), // previous window
      entry("tsunami", 400, now), // outside both
    ];
    const trends = computeAlertTypeTrends(entries, new Date(now));
    const tsunami = trends.find(t => t.type === "tsunami")!;
    expect(tsunami.count30d).toBe(2);
    expect(tsunami.countPrevious30d).toBe(1);
    expect(tsunami.delta).toBe(1);
    expect(tsunami.trend).toBe("steady"); // |1| <= band
    expect(tsunami.eventTimestamps30d.length).toBe(2);
  });

  test("rising when current window exceeds previous by more than the band", () => {
    const entries = [entry("weather", 2, now), entry("weather", 3, now), entry("weather", 4, now), entry("weather", 40, now)];
    const trends = computeAlertTypeTrends(entries, new Date(now));
    expect(trends.find(t => t.type === "weather")!.trend).toBe("rising");
  });

  test("falling when current window is well below previous", () => {
    const entries = [entry("wildfire", 35, now), entry("wildfire", 40, now), entry("wildfire", 45, now)];
    const trends = computeAlertTypeTrends(entries, new Date(now));
    expect(trends.find(t => t.type === "wildfire")!.trend).toBe("falling");
  });

  test("both windows empty => insufficient (absence is never rendered as calm/rising)", () => {
    const trends = computeAlertTypeTrends([entry("marine", 400, now)], new Date(now));
    expect(trends.find(t => t.type === "marine")!.trend).toBe("insufficient");
    expect(trends.find(t => t.type === "marine")!.count30d).toBe(0);
  });

  test("undated entries are excluded, never guessed into a bucket", () => {
    // The undated record must REACH computeAlertTypeTrends: filtering it out
    // here would test the filter, not the exclusion the test claims to cover.
    const entries = [
      entry("fishing", 5, now),
      { timestamp: "not-a-date", type: "fishing", severity: "WATCH", description: "undated", record: {} },
    ] as TimelineEntry[];
    const trends = computeAlertTypeTrends(entries, new Date(now));
    const fishing = trends.find(t => t.type === "fishing")!;
    expect(fishing.count30d).toBe(1);
    expect(fishing.eventTimestamps30d.length).toBe(1);
    expect(fishing.eventTimestamps30d).not.toContain("not-a-date");
  });

  test("covers every alert type exactly once, in canonical order", () => {
    const trends = computeAlertTypeTrends([], new Date(now));
    expect(trends.map(t => t.type)).toEqual([
      "tsunami", "earthquake", "weather", "tides", "airquality", "wildfire", "marine", "fishing",
    ]);
  });
});

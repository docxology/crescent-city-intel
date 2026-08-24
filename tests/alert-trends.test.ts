import { describe, expect, test } from "bun:test";
import { ALERT_TYPES } from "../src/alert_analytics.ts";
import {
  ALERT_SOURCE_BY_TYPE,
  MAX_ALERT_TREND_DAYS,
  alertHeatIntensity,
  buildAlertTrendView,
  classifyAlertCondition,
  deriveAlertDisplayState,
} from "../src/gui/alert_trends.ts";
import { handleApiRoute } from "../src/gui/routes.ts";

const NOW = "2026-08-24T18:00:00.000Z";

function event(type: string, timestamp: string, description: string, severity = "WATCH") {
  return { type, timestamp, description, severity, record: { id: `${type}-${description}` } };
}

describe("alert trend aggregation", () => {
  test("covers the canonical eight monitor types and source names", () => {
    expect(Object.keys(ALERT_SOURCE_BY_TYPE)).toEqual([...ALERT_TYPES]);
    expect(ALERT_SOURCE_BY_TYPE.tsunami).toBe("NOAA Tsunami");
    expect(ALERT_SOURCE_BY_TYPE.fishing).toBe("CDFW Fishing");
  });

  test("builds inclusive UTC-day buckets and excludes events outside the window", () => {
    const view = buildAlertTrendView({
      now: NOW,
      days: 3,
      events: [
        event("tsunami", "2026-08-21T23:59:59.999Z", "outside"),
        event("tsunami", "2026-08-22T00:00:00.000Z", "start"),
        event("tsunami", "2026-08-23T01:00:00.000Z", "middle one"),
        event("tsunami", "2026-08-23T22:00:00.000Z", "middle two", "WARNING"),
        event("earthquake", "2026-08-24T23:59:59.999Z", "end"),
        event("earthquake", "2026-08-25T00:00:00.000Z", "next day"),
      ],
    });

    expect(view.startDate).toBe("2026-08-22");
    expect(view.endDate).toBe("2026-08-24");
    expect(view.rows.find(row => row.type === "tsunami")?.buckets.map(bucket => bucket.count)).toEqual([1, 2, 0]);
    expect(view.rows.find(row => row.type === "earthquake")?.buckets.map(bucket => bucket.count)).toEqual([0, 0, 1]);
    expect(view.maxCellCount).toBe(2);
  });

  test("deduplicates overlap between timeline and per-type history payloads", () => {
    const shared = event("weather", "2026-08-24T12:00:00.000Z", "same alert", "WARNING");
    const view = buildAlertTrendView({ now: NOW, days: 1, events: [shared, { ...shared }] });
    const weather = view.rows.find(row => row.type === "weather")!;

    expect(weather.windowEvents).toBe(1);
    expect(weather.sampledEvents).toBe(1);
    expect(view.processedEvents).toBe(1);
    expect(view.duplicateEvents).toBe(1);
  });

  test("rejects malformed entries without dropping valid records", () => {
    const view = buildAlertTrendView({
      now: NOW,
      days: 1,
      events: [
        null,
        { type: "bogus", timestamp: NOW },
        { type: "marine", timestamp: "not-a-date" },
        event("marine", "2026-08-24T08:00:00.000Z", "valid"),
      ],
    });

    expect(view.invalidEvents).toBe(3);
    expect(view.processedEvents).toBe(1);
    expect(view.rows.find(row => row.type === "marine")?.windowEvents).toBe(1);
  });

  test("keeps empty, stale, unavailable, and unknown distinct from explicit calm", () => {
    const sourceHealth = [
      { source: "NOAA Tsunami", status: "ok", checkedAt: NOW, itemCount: 1 },
      { source: "USGS Earthquake", status: "empty", checkedAt: NOW, itemCount: 0 },
      { source: "NWS Weather", status: "stale", checkedAt: NOW, itemCount: 2 },
      { source: "NOAA Tides", status: "unavailable", checkedAt: NOW, itemCount: 0, error: "station timeout" },
      { source: "EPA AirNow", status: "ok", checkedAt: NOW, itemCount: 1 },
      { source: "CAL FIRE Wildfire", status: "ok", checkedAt: NOW, itemCount: 1 },
      { source: "NDBC Marine", status: "ok", checkedAt: NOW, itemCount: 1 },
    ];
    const view = buildAlertTrendView({
      now: NOW,
      sourceHealth,
      currentLevels: {
        tsunami: "CALM",
        earthquake: "CALM",
        weather: "CALM",
        tides: "CALM",
        airquality: "GOOD",
        wildfire: "WARNING",
      },
    });
    const states = Object.fromEntries(view.rows.map(row => [row.type, row.displayState]));

    expect(states.tsunami).toBe("calm");
    expect(states.earthquake).toBe("empty");
    expect(states.weather).toBe("stale");
    expect(states.tides).toBe("unavailable");
    expect(states.airquality).toBe("calm");
    expect(states.wildfire).toBe("active");
    expect(states.marine).toBe("available");
    expect(states.fishing).toBe("unknown");
    expect(view.rows.find(row => row.type === "tides")?.healthError).toBe("station timeout");
  });

  test("classification helpers only call an explicit level calm", () => {
    expect(classifyAlertCondition("CALM")).toBe("calm");
    expect(classifyAlertCondition("good")).toBe("calm");
    expect(classifyAlertCondition("WATCH")).toBe("active");
    expect(classifyAlertCondition(undefined)).toBe("unknown");
    expect(deriveAlertDisplayState("ok", "unknown")).toBe("available");
    expect(deriveAlertDisplayState("stale", "calm")).toBe("stale");
  });

  test("bounds days and input events while retaining the input tail", () => {
    const view = buildAlertTrendView({
      now: NOW,
      days: 999,
      maxEvents: 2,
      events: [
        event("tsunami", "2026-08-22T01:00:00.000Z", "trimmed"),
        event("weather", "2026-08-23T01:00:00.000Z", "kept one"),
        event("marine", "2026-08-24T01:00:00.000Z", "kept two"),
      ],
    });

    expect(view.days).toBe(MAX_ALERT_TREND_DAYS);
    expect(view.truncatedEvents).toBe(1);
    expect(view.processedEvents).toBe(2);
    expect(view.rows.find(row => row.type === "tsunami")?.sampledEvents).toBe(0);
  });

  test("scales heat intensity into a stable zero-to-four range", () => {
    expect(alertHeatIntensity(0, 10)).toBe(0);
    expect(alertHeatIntensity(1, 10)).toBe(1);
    expect(alertHeatIntensity(5, 10)).toBe(2);
    expect(alertHeatIntensity(10, 10)).toBe(4);
    expect(alertHeatIntensity(99, 10)).toBe(4);
    expect(alertHeatIntensity(Number.NaN, 10)).toBe(0);
  });

  test("accepts the real timeline and history API envelopes without mocks", async () => {
    const timelineResponse = await handleApiRoute(new URL("http://localhost:3000/api/alerts/timeline"));
    const historyResponses = await Promise.all(ALERT_TYPES.map(type =>
      handleApiRoute(new URL(`http://localhost:3000/api/alerts/${type}/history?limit=5`))));
    expect(timelineResponse.status).toBe(200);
    expect(historyResponses.every(response => response.status === 200)).toBe(true);

    const timeline = await timelineResponse.json() as { timeline?: unknown[] };
    const histories = await Promise.all(historyResponses.map(response => response.json() as Promise<{ alerts?: unknown[] }>));
    const events = [
      ...(Array.isArray(timeline.timeline) ? timeline.timeline : []),
      ...histories.flatMap(history => Array.isArray(history.alerts) ? history.alerts : []),
    ];
    const view = buildAlertTrendView({ now: NOW, events });

    expect(view.rows.map(row => row.type)).toEqual([...ALERT_TYPES]);
    expect(view.rows.every(row => row.buckets.length === 14)).toBe(true);
  });

  test("fails closed on an invalid time anchor", () => {
    expect(() => buildAlertTrendView({ now: "not-a-date" })).toThrow("valid date");
  });
});

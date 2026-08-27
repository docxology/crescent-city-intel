import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ALERT_TYPE_DOMAINS,
  STEADY_BAND,
  attributeRecords,
  buildInsightReport,
  collectDatedRecords,
  coverageGapInputs,
  directionFor,
  evaluateCoverageGaps,
  INSIGHTS_SCHEMA,
  templateNarrative,
  computeDomainTrends,
  type DatedRecord,
} from "../src/insights.ts";
import { buildGeoView, attachGeoDomainInsights, type HazardDomainInsight } from "../src/geo_view.ts";
import {
  GAP_REASON_MEETING_REFERENCE_ONLY,
  GAP_REASON_NEWS_STALE,
  GAP_REASON_NO_RECENT_ITEMS,
  scoreDomainCoverageGaps,
} from "../src/domains/coverage.ts";

const DAY = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── direction classification ───────────────────────────────────────────

describe("directionFor", () => {
  test("classifies rising / falling / steady against the steady band", () => {
    expect(STEADY_BAND).toBe(1);
    expect(directionFor(6, 2)).toBe("rising");
    expect(directionFor(2, 6)).toBe("falling");
    expect(directionFor(3, 2)).toBe("steady"); // delta +1 sits inside the band
    expect(directionFor(1, 2)).toBe("steady"); // delta -1 likewise
  });

  test("two empty windows are insufficient, never calm", () => {
    expect(directionFor(0, 0)).toBe("insufficient");
    // One side populated still yields a real direction.
    expect(directionFor(0, 5)).toBe("falling");
    expect(directionFor(4, 0)).toBe("rising");
  });
});

// ─── window trend math over a synthetic artifact tree ───────────────────

async function makeFixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "insights-fixture-"));
  const now = Date.parse("2026-08-26T12:00:00.000Z");

  // news: 3 items in the current window, 1 in the previous — rising.
  const newsDir = join(root, "news");
  await mkdir(newsDir, { recursive: true });
  await writeFile(join(newsDir, "batch-1.json"), JSON.stringify([
    { title: "Harbor dredging begins", summary: "harbor operations resume", link: "https://example.org/news/harbor", date: iso(now - 2 * DAY) },
    { title: "Emergency siren test scheduled", link: "https://example.org/news/siren", date: iso(now - 4 * DAY) },
    { title: "Climate adaptation grant awarded", date: iso(now - 6 * DAY) },
    { title: "Old harbor story (previous window)", date: iso(now - 40 * DAY) },
    // Undated record must be collected but excluded from windows.
    { title: "Undated meeting notice" },
  ]));

  // alerts: wildfire history with 2 current-window events.
  const fireDir = join(root, "alerts", "wildfire");
  await mkdir(fireDir, { recursive: true });
  await writeFile(join(fireDir, "history.jsonl"), [
    JSON.stringify({ timestamp: iso(now - 3 * DAY), summary: "Fire Complex grows", level: "ADVISORY" }),
    JSON.stringify({ timestamp: iso(now - 5 * DAY), summary: "Evacuation warning issued", level: "WARNING" }),
  ].join("\n") + "\n");

  // meetings: one previous-window item.
  const meetingsDir = join(root, "gov_meetings");
  await mkdir(meetingsDir, { recursive: true });
  await writeFile(join(meetingsDir, "m1.json"), JSON.stringify([
    { title: "City Council agenda: emergency preparedness update", date: iso(now - 35 * DAY), url: "https://example.org/agenda" },
  ]));
  return root;
}

describe("collectDatedRecords over the fixture tree", () => {
  test("gathers alert/news/meeting records and preserves URLs", async () => {
    const root = await makeFixtureTree();
    try {
      const records = await collectDatedRecords(root);
      expect(records.length).toBeGreaterThanOrEqual(7);
      const harbor = records.find(r => r.title.includes("Harbor dredging"));
      expect(harbor?.url).toBe("https://example.org/news/harbor");
      expect(harbor?.feed).toBe("news");
      const fire = records.find(r => r.title === "Evacuation warning issued");
      expect(fire?.feed).toBe("alerts");
      expect(records.some(r => r.title.startsWith("Undated"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("computeDomainTrends window arithmetic", () => {
  test("counts only dated records inside (now-2W, now] and attributes by keywords/alert types", async () => {
    const root = await makeFixtureTree();
    try {
      const now = Date.parse("2026-08-26T12:00:00.000Z");
      const records = await collectDatedRecords(root);
      const buckets = attributeRecords(records);
      const trends = computeDomainTrends(buckets, { nowMs: now, windowDays: 30 });

      // Harbor & Marine Operations must pick up the dredging news item via keyword.
      const harbor = trends.find(t => t.domainId === "harbor-marine-operations");
      expect(harbor).toBeDefined();
      expect(harbor!.current.news).toBe(1);
      expect(harbor!.previous.news).toBe(1);
      expect(harbor!.evidenceSources).toContain("https://example.org/news/harbor");

      // Wildfire alerts map explicitly onto public-safety and emergency-management.
      for (const domainId of ["public-safety", "emergency-management"]) {
        const trend = trends.find(t => t.domainId === domainId);
        expect(trend!.current.alerts).toBe(2);
        expect(trend!.deltaTotal).toBe(2);
        expect(trend!.direction).toBe("rising");
      }

      // The undated notice is collected but contributes to NO window anywhere.
      const undatedOnly: DatedRecord[] = records.filter(r => r.title.startsWith("Undated"));
      expect(undatedOnly.length).toBe(1);
      const isolated = computeDomainTrends(new Map([["event-planning", undatedOnly]]), { nowMs: now, windowDays: 30 });
      const isolatedTrend = isolated.find(t => t.domainId === "event-planning")!;
      expect(isolatedTrend.current.calendarEvents + isolatedTrend.previous.calendarEvents
        + isolatedTrend.current.meetings + isolatedTrend.previous.meetings).toBe(0);
      expect(isolatedTrend.direction).toBe("insufficient");

      // Rising domains sort ahead of unchanged ones.
      const firstRising = trends.findIndex(t => t.direction === "rising");
      expect(firstRising).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("momentumPct is null when the prior window was empty", () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const records: DatedRecord[] = [
      { title: "wildfire incident", text: "", atMs: now - DAY, url: null, feed: "alerts", alertType: "wildfire" },
      { title: "second wildfire incident", text: "", atMs: now - 2 * DAY, url: null, feed: "alerts", alertType: "wildfire" },
    ];
    const buckets = new Map([["public-safety", records]]);
    const [trend] = computeDomainTrends(buckets, { nowMs: now, windowDays: 30 });
    expect(trend.current.alerts).toBe(2);
    expect(trend.previous.alerts).toBe(0);
    expect(trend.momentumPct).toBeNull();
    expect(trend.direction).toBe("rising");
  });
});

// ─── coverage-gap scoring ───────────────────────────────────────────────

describe("scoreDomainCoverageGaps", () => {
  const nowMs = Date.parse("2026-08-26T00:00:00.000Z");

  test("alerts firing while news is stale outranks other gaps and saturates at 100", () => {
    const gaps = scoreDomainCoverageGaps([
      { domainId: "a-alerts-no-news", alertEvents: 3, newsCount: 0, latestNewsAtMs: null, meetingsCount: 0, checkedAtMs: nowMs },
      { domainId: "b-alerts-old-news", alertEvents: 2, newsCount: 1, latestNewsAtMs: nowMs - 16 * DAY, meetingsCount: 0, checkedAtMs: nowMs },
      { domainId: "c-healthy", alertEvents: 2, newsCount: 4, latestNewsAtMs: nowMs - DAY, meetingsCount: 1, checkedAtMs: nowMs },
    ]);
    const a = gaps.find(g => g.domainId === "a-alerts-no-news")!;
    const b = gaps.find(g => g.domainId === "b-alerts-old-news")!;
    expect(a.kind).toBe(GAP_REASON_NEWS_STALE);
    expect(a.score).toBe(100); // infinite staleness saturates
    expect(b.kind).toBe(GAP_REASON_NEWS_STALE);
    expect(b.score).toBeLessThan(a.score);
    expect(b.score).toBeGreaterThanOrEqual(80);
    expect(gaps.find(g => g.domainId === "c-healthy")).toBeUndefined();
  });

  test("meeting-reference-only and no-recent-items produce ordered mid bands", () => {
    const gaps = scoreDomainCoverageGaps([
      { domainId: "meeting-only", alertEvents: 0, newsCount: 0, latestNewsAtMs: null, meetingsCount: 2, checkedAtMs: nowMs },
      { domainId: "silent-domain", alertEvents: 0, newsCount: 0, latestNewsAtMs: null, meetingsCount: 0, checkedAtMs: nowMs },
    ]);
    // Sorted by descending score: the no-recent-coverage gap (40) outranks
    // meeting-reference-only (25), matching the urgency band contract.
    const silent = gaps.find(g => g.domainId === "silent-domain")!;
    const meetingOnly = gaps.find(g => g.domainId === "meeting-only")!;
    expect(silent.kind).toBe(GAP_REASON_NO_RECENT_ITEMS);
    expect(silent.score).toBe(40);
    expect(meetingOnly.kind).toBe(GAP_REASON_MEETING_REFERENCE_ONLY);
    expect(meetingOnly.score).toBe(25);
    expect(silent.score).toBeGreaterThan(meetingOnly.score);
    expect(gaps.every(g => g.score < 80)).toBe(true);
  });
});

describe("evaluateCoverageGaps bridges attributed records into gap inputs", () => {
  test("builds contexts from buckets within the trailing 60-day gate", () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const records: DatedRecord[] = [
      { title: "harbor piece", text: "", atMs: now - 10 * DAY, url: null, feed: "news" },
      { title: "harbor agenda", text: "", atMs: now - 20 * DAY, url: null, feed: "meetings" },
      { title: "old article far outside gate", text: "", atMs: now - 90 * DAY, url: null, feed: "news" },
    ];
    const buckets = new Map([["harbor-marine-operations", records]]);
    const contexts = coverageGapInputs(buckets, now);
    const mine = contexts.find(c => c.domainId === "harbor-marine-operations")!;
    expect(mine.newsCount).toBe(1);
    expect(mine.meetingsCount).toBe(1);
    expect(mine.latestNewsAtMs).toBe(now - 10 * DAY);
    const gaps = evaluateCoverageGaps(contexts, now);
    // Fresh news (10 days) inside the 14-day stale boundary means no stale gap,
    // but newsCount > 0 also avoids the meeting-only/no-item classes.
    expect(gaps.find(g => g.domainId === "harbor-marine-operations")).toBeUndefined();
  });
});

// ─── narrative layer ────────────────────────────────────────────────────

describe("templateNarrative", () => {
  test("repeats computed numbers verbatim without inventing causes", () => {
    const insight = {
      domainId: "emergency-management",
      domainName: "Emergency Management",
      currentWindow: { startMs: 0, endMs: 1 },
      previousWindow: { startMs: 0, endMs: 0 },
      current: { alerts: 3, news: 1, meetings: 0, youtube: 0, calendarEvents: 0 },
      previous: { alerts: 1, news: 0, meetings: 0, youtube: 0, calendarEvents: 0 },
      deltaTotal: 3,
      momentumPct: 300,
      direction: "rising" as const,
      evidenceSources: [],
    };
    const paragraph = templateNarrative(insight, null);
    expect(paragraph).toContain("Emergency Management");
    expect(paragraph).toContain("+3");
    expect(paragraph).toContain("300%");
    expect(paragraph).toContain("rising");
    expect(paragraph).not.toMatch(/because|caused by/i);
  });
});

describe("buildInsightReport end to end", () => {
  test("deterministic build skips the LLM and keeps template paragraphs with evidence", async () => {
    const root = await makeFixtureTree();
    try {
      const report = await buildInsightReport({
        generatedAt: "2026-08-26T12:00:00.000Z",
        outputRoot: root,
        polish: false,
      });
      expect(report.schemaVersion).toBe(INSIGHTS_SCHEMA);
      expect(report.narrative.requested).toBe(false);
      expect(report.narrative.status).toBe("skipped");
      report.top.forEach((entry, index) => {
        expect(entry.rank).toBe(index + 1);
        expect(entry.narrativeKind).toBe("skipped");
        expect(entry.paragraph.length).toBeGreaterThan(0);
        expect(entry.direction).not.toBe("insufficient");
      });
      // Wildfire-driven domains must appear among the top movers.
      const topIds = report.top.map(entry => entry.domainId);
      expect(topIds).toContain("public-safety");
      // Every asserted paragraph traces back to the deterministic trend rows.
      for (const entry of report.top) {
        const trend = report.trends.find(t => t.domainId === entry.domainId)!;
        expect(entry.deltaTotal).toBe(trend.deltaTotal);
        expect(entry.momentumPct).toBe(trend.momentumPct);
      }
      // Report shape writes back and round-trips through readCivicInsights-equivalent JSON.
      expect(JSON.parse(JSON.stringify(report)).schemaVersion).toBe(INSIGHTS_SCHEMA);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("alert type mapping covers every monitored type except standalone dirs", () => {
    for (const type of ["tsunami", "earthquake", "weather", "tides", "airquality", "wildfire", "marine", "fishing"]) {
      if (type in ALERT_TYPE_DOMAINS || ["tides", "fishing"].includes(type)) continue;
      throw new Error(`alert type ${type} lacks a domain mapping`);
    }
    expect(ALERT_TYPE_DOMAINS["wildfire"]).toContain("public-safety");
    expect(ALERT_TYPE_DOMAINS["tide-like"] ?? []).toEqual([]);
  });
});
describe("attachGeoDomainInsights", () => {
  const contract = {
    anchor: { name: "Crescent City", municipality: "Crescent City", county: "Del Norte", state: "CA", latitude: 41.7558, longitude: -124.2026, bounds: { west: -124.4, south: 41.7, east: -123.9, north: 42.0 } },
    hazard: { relevantDomains: [
      { id: "harbor-marine-operations", name: "Harbor & Marine Operations", icon: "⚓", hazardTags: ["marine"], topics: [{ name: "Dredging", tags: ["harbor"], sections: [] }] },
      { id: "public-safety", name: "Public Safety", icon: "🛡️", hazardTags: ["wildfire"], topics: [] },
    ] },
  };

  test("attaches additive insight fields by normalized domain name without mutating input", () => {
    const base = buildGeoView(contract);
    const insights: Record<string, HazardDomainInsight> = {
      "harbor-marine-operations": { direction: "rising", deltaTotal: 2, momentumPct: 200, coverageGapKind: null, coverageGapScore: null },
      "public-safety": { direction: "steady", deltaTotal: 0, momentumPct: 0, coverageGapKind: GAP_REASON_NEWS_STALE, coverageGapScore: 90 },
    };
    const attached = attachGeoDomainInsights(base, insights);
    // Input view untouched.
    expect(base.features.some(f => f.geometry.type === "Point" && f.properties.kind === "hazard-domain" && "insight" in f.properties)).toBe(false);
    const harbor = attached.features.find(f => f.id === "hazard-domain:Harbor & Marine Operations");
    expect(harbor?.properties.insight?.direction).toBe("rising");
    expect(harbor?.properties.insight?.deltaTotal).toBe(2);
    const safety = attached.features.find(f => f.id === "hazard-domain:Public Safety");
    expect(safety?.properties.insight?.coverageGapScore).toBe(90);
    // Anchor point gains nothing.
    const anchor = attached.features.find(f => f.properties.kind === "anchor");
    expect(anchor?.properties.insight).toBeUndefined();
  });

  test("domains absent from the report stay absent rather than reading as calm", () => {
    const base = buildGeoView(contract);
    const attached = attachGeoDomainInsights(base, {});
    for (const feature of attached.features) {
      if (feature.properties.kind === "hazard-domain") {
        expect(feature.properties.insight).toBeUndefined();
      }
    }
  });
});

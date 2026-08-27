import { describe, expect, test } from "bun:test";
import {
  PAGES_DATE_MODIFIED_PLACEHOLDER,
  PAGES_DATE_PUBLISHED_PLACEHOLDER,
  buildPagesBreadcrumbJsonLd,
  buildPagesDatasetJsonLd,
  buildPagesEventsJsonLd,
  buildPagesFeedXml,
  buildPagesRobotsTxt,
  buildPagesWebPageJsonLd,
  embedPagesJsonLd,
  type PagesSnapshot,
} from "../src/pages_snapshot.ts";

function snapshotFixture(overrides: Partial<PagesSnapshot> = {}): PagesSnapshot {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-27T12:00:00.000Z",
    repository: "https://github.com/docxology/crescent-city-intel",
    commit: null,
    status: "ok",
    healthSummary: {} as PagesSnapshot["healthSummary"],
    sourceRegistry: [],
    sourceRegistryFingerprint: "0".repeat(64),
    sourceDiscovery: null,
    municipalCode: { available: true, source: "https://ecode360.com/CR4919", manifest: null, verification: null, coverage: null, readability: null },
    geoIntel: { available: true, schema: "crescent-city-geo-intel/v1", viewSchema: "crescent-city-geo-view/v1", domainCount: 0, hazardDomainCount: 0, featureCount: 0, sectionCount: 0 },
    events: { schemaVersion: "crescent-city-events/v1", generatedAt: "2026-08-27T12:00:00.000Z", count: 1, events: [] } as unknown as PagesSnapshot["events"],
    sourceHealth: [],
    news: [],
    meetings: [],
    youtube: [],
    triplicate: [],
    curated: [],
    alerts: { composite: null, current: [] },
    report: { monthly: null, metadata: null, weeklySummary: null, pipelineRun: null, curation: null },
    analytics: null,
    files: {} as PagesSnapshot["files"],
    publicationPolicy: { triplicate: "reference-citation-only", curationInputs: [], excludedFromSnapshot: [] },
    ...overrides,
  } as PagesSnapshot;
}

function parseBlock(block: string): Record<string, unknown> {
  return JSON.parse(block.replace('<script type="application/ld+json">', "").replace("</script>", ""));
}

describe("lane3: syndication feed (§3.6)", () => {
  test("feed covers news, meetings, and alerts with absolute links and dates", () => {
    const snapshot = snapshotFixture({
      news: [
        { title: "Council adopts budget", link: "https://example.com/budget", description: "A", pubDate: "2026-08-26T10:00:00Z" },
        { title: "No-link item", link: "not-a-url", pubDate: "2026-08-25T10:00:00Z" },
        { title: "   ", link: "https://example.com/blank" },
      ],
      meetings: [{ title: "Planning Commission", link: "https://example.com/meeting", date: "2026-08-20T18:00:00Z" }],
      alerts: { composite: null, current: [{ title: "High surf advisory", monitor: "tides", detail: "6.8 ft", timestamp: "2026-08-27T09:00:00Z" }] },
    });
    const xml = buildPagesFeedXml(snapshot);
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain("<title>The Quadruplicate</title>");
    expect(xml).toContain("<title>Council adopts budget</title>");
    expect(xml).toContain("<title>Planning Commission</title>");
    expect(xml).toContain("<title>Alerts · tides: High surf advisory</title>");
    expect(xml).toContain("<link>https://example.com/budget</link>");
    // Non-absolute item link falls back to the page that renders it.
    expect(xml).toContain("<link>https://quadruplicate.org/news.html</link>");
    // Blank titles are dropped, never invented.
    expect(xml).not.toContain("blank");
    expect(xml).toContain("lastBuildDate>");
  });

  test("feed respects the 60-item cap", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({ title: `Item ${index}`, link: `https://example.com/${index}` }));
    const xml = buildPagesFeedXml(snapshotFixture({ news: items }));
    expect([...xml.matchAll(/<item>/g)].length).toBe(60);
  });

  test("robots.txt carries the feed pointer", () => {
    expect(buildPagesRobotsTxt()).toContain("Feed: https://quadruplicate.org/feed.xml");
  });
});

describe("lane3: per-page JSON-LD (§3.5)", () => {
  test("WebPage block carries the page URL", () => {
    const parsed = parseBlock(buildPagesWebPageJsonLd({ file: "news.html", title: "Local news" }, "2026-08-27T12:00:00.000Z"));
    expect(parsed["@type"]).toBe("WebPage");
    expect(parsed.url).toBe("https://quadruplicate.org/news.html");
  });

  test("events page emits CollectionPage", () => {
    expect(buildPagesWebPageJsonLd({ file: "events.html", title: "Community calendar" }, "2026-08-27T12:00:00.000Z")).toContain('"CollectionPage"');
  });

  test("BreadcrumbList marks Front page then the page", () => {
    const parsed = parseBlock(buildPagesBreadcrumbJsonLd({ file: "sources.html", title: "Sources" }));
    expect(parsed.itemListElement[0].name).toBe("Front page");
    expect(parsed.itemListElement[1].name).toBe("Sources");
  });

  test("Dataset catalog describes the seven public artifacts", () => {
    const parsed = parseBlock(buildPagesDatasetJsonLd("2026-08-27T12:00:00.000Z"));
    expect(parsed["@type"]).toBe("DataCatalog");
    expect(parsed.dataset.length).toBe(7);
    for (const dataset of parsed.dataset) {
      expect(dataset["@type"]).toBe("Dataset");
      expect((dataset.url as string).startsWith("https://quadruplicate.org/")).toBe(true);
    }
  });

  test("Event JSON-LD keeps provenance links and skips undated events", () => {
    const events = [
      { title: "Harbor cleanup", dateStart: "2026-09-05", location: "Crescent City Harbor", organizer: "Harbor District", sourceLinks: ["https://example.com/cleanup"] },
      { title: "No date", dateStart: null, location: null, organizer: null, sourceLinks: [] },
      { title: "   ", dateStart: "2026-09-06", location: null, organizer: null, sourceLinks: [] },
    ];
    const parsed = parseBlock(buildPagesEventsJsonLd(events as never, "2026-08-27T12:00:00.000Z"));
    expect(parsed.itemListElement.length).toBe(1);
    const item = parsed.itemListElement[0].item;
    expect(item.name).toBe("Harbor cleanup");
    expect(item.location.name).toBe("Crescent City Harbor");
    expect(item.sameAs).toEqual(["https://example.com/cleanup"]);
  });

  test("embedPagesJsonLd rejects missing and duplicate markers", () => {
    expect(() => embedPagesJsonLd("<html></html>", "<!--MARK-->", "x", "p.html")).toThrow(/exactly one/);
    expect(() => embedPagesJsonLd("<!--MARK--><!--MARK-->", "<!--MARK-->", "x", "p.html")).toThrow(/exactly one/);
    expect(embedPagesJsonLd("a<!--MARK-->b", "<!--MARK-->", "X", "p.html")).toBe("aXb");
  });
});

describe("lane3: injected edition dates (§3.4)", () => {
  test("date placeholders are distinct markers", () => {
    expect(PAGES_DATE_PUBLISHED_PLACEHOLDER).not.toBe(PAGES_DATE_MODIFIED_PLACEHOLDER);
    expect(PAGES_DATE_PUBLISHED_PLACEHOLDER).toMatch(/^__/);
  });
});

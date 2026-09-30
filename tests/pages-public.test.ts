import { describe, expect, test } from "bun:test";
import { publicAnalytics, publicEvents, publicAlerts, publicSourceDiscovery, publicSourceHealth, assertPublicArtifact, assertPublicMunicipalFile, publicExposureErrors } from "../src/pages_public.ts";
describe("artifact-family public DTOs", () => {
  test("analytics keeps displayed metrics and severity maps while omitting unknown/operator fields", () => {
    const result = publicAnalytics({ schemaVersion: "1.0.0", metrics: { code: { articles: 2, sections: 5, words: 60, avgWordsPerSection: 12, privatePrompt: "hidden" }, sources: { present: 1, missing: 2, missingSources: ["A", "B"] }, content: { news: 3 } }, code: { totalWords: 60, titleBreakdown: [{ title: "General", articleCount: 2, sectionCount: 5, wordCount: 60 }], longestSections: [{ number: "1", title: "Purpose", words: 60, guid: "s1" }] }, alerts: { level: "WATCH", analytics: { typeStats: [{ type: "weather", totalEvents: 2, severityCounts: { WATCH: 2, CALM: 0 } }] } }, content: { recent: [{ id: "1", title: "Public story", url: "https://example.test/story", source: "Public feed", date: "2026-09-30" }] }, signals: [{ id: "operator", operatorOnly: true, detail: "/Users/private/operator" }, { id: "public", title: "Coverage", detail: "Two feeds unavailable" }], operatorSignalsNoticed: [{ detail: "/Users/private/operator" }], futurePrivateField: "/Users/private/future" }) as any;
    expect(result.metrics.code.sections).toBe(5); expect(result.metrics.sources.missingSources).toEqual(["A", "B"]);
    expect(result.code.titleBreakdown[0].wordCount).toBe(60); expect(result.code.longestSections[0].words).toBe(60);
    expect(result.alerts.analytics.typeStats[0].severityCounts).toEqual({ WATCH: 2, CALM: 0 });
    expect(result.content.recent[0].title).toBe("Public story"); expect(result.signals).toHaveLength(1);
    expect(result.metrics.code.privatePrompt).toBeUndefined(); expect(result.futurePrivateField).toBeUndefined(); expect(result.operatorSignalsNoticed).toBeUndefined();
    expect(() => assertPublicArtifact(result)).not.toThrow();
  });
  test("event summaries preserve dynamic event IDs and public alert records remain readable", () => {
    const events = publicEvents({ schemaVersion: "crescent-city-events/v1", events: [{ id: "event-1", title: "Meeting", dateStart: "2026-10-01", publicationAt: "2026-09-30T18:00:00Z", operatorMemo: "hidden" }], summaries: { "event-1": { text: "Public summary", status: "source_only", prompt: "hidden" } } }) as any;
    expect(events.events[0].title).toBe("Meeting"); expect(events.events[0].publicationAt).toBe("2026-09-30T18:00:00Z"); expect(events.summaries["event-1"].text).toBe("Public summary"); expect(events.summaries["event-1"].prompt).toBeUndefined();
    const alerts = publicAlerts({ composite: { level: "WATCH", reason: "Weather", hasUnavailableMonitors: true, monitors: { weather: { level: "WATCH", detail: "Wind", available: true }, airQuality: { level: "CALM", available: false } } }, current: [{ monitor: "weather", summary: "Strong wind", alerts: [{ severity: "Moderate", description: "Strong wind", secret: "hidden" }], operatorMemo: "hidden" }] });
    expect(alerts.composite?.level).toBe("WATCH"); expect(alerts.composite?.hasUnavailableMonitors).toBe(true); expect((alerts.composite?.monitors as any).airQuality.available).toBe(false); expect((alerts.current[0]?.alerts as any)[0].description).toBe("Strong wind"); expect(alerts.current[0]?.operatorMemo).toBeUndefined(); expect(alerts.current[0]?.summary).toBe("Strong wind");
    const discovery = publicSourceDiscovery({ countsByKind: { news: 2, alerts: 20 }, countsByAuthority: { official: 4 }, sources: [] }) as any;
    expect(discovery.countsByKind).toEqual({ news: 2, alerts: 20 });
  });
  test("collection identity and reachability remain separate while operator errors are omitted", () => {
    const result = publicSourceDiscovery({ probe: { checked: 1, unavailable: 0 }, sources: [{ id: "weather-fixture", collection: "unavailable", healthBinding: "source-id", reachability: { status: "ok", checkedAt: "2026-09-30T12:00:00Z", httpStatus: 200, error: "/Users/private/probe" }, healthReceipts: [{ sourceId: "weather-fixture", source: "Weather", status: "unavailable", checkedAt: "2026-09-30T12:00:00Z", error: "/Users/private/collection" }] }] }) as any;
    expect(result.sources[0].collection).toBe("unavailable");
    expect(result.sources[0].healthBinding).toBe("source-id");
    expect(result.sources[0].reachability.status).toBe("ok");
    expect(result.sources[0].healthReceipts[0].sourceId).toBe("weather-fixture");
    expect(result.sources[0].reachability.error).toBeUndefined();
    expect(result.sources[0].healthReceipts[0].error).toBeUndefined();
    expect((publicSourceHealth([{ sourceId: "weather-fixture", source: "Weather", status: "empty" }]) as any)[0].sourceId).toBe("weather-fixture");
    expect(() => assertPublicArtifact(result)).not.toThrow();
  });
  test("known public text cannot conceal operator paths or credential-bearing URLs", () => {
    for (const value of [{ title: "/Users/private/file" }, { url: "https://user:password@example.test/" }, { url: "https://example.test/?api_key=secret" }, { authorization: "secret" }, { url: "https://example.test/?key=secret" }, { url: "https://example.test/?auth=secret" }, { url: "https://example.test/?signature=secret" }, { url: "http://127.0.0.2/" }, { url: "http://10.2.3.4/" }, { url: "http://192.168.2.3/" }, { url: "http://[::ffff:127.0.0.2]/" }]) expect(publicExposureErrors(value).length).toBeGreaterThan(0);
  });
  test("URL fields reject executable protocols and non-HTTP credential URLs without banning ordinary prose", () => {
    for (const value of [
      { url: "javascript:alert(1)" }, { website: "data:text/html,private" },
      { sourceLinks: ["https://example.test/public", "ftp://user:password@example.test/private"] },
      { url: "HTTPS://example.test/?auth=private" }, { url: 42 },
      { summary: "Credentials: ftp://user:password@example.test/private" },
      { url: "https://example.test/#access_token=private-fixture-token" },
      { url: "https://example.test/#/oauth?credential=private-fixture-token" },
      { url: "https://example.test/#access_token%3Dprivate-fixture-token" },
      { url: "https://example.test/#section=1;access_token=private-fixture-token" },
      { url: "https://example.test/#section=1;auth=private-fixture-token" },
    ]) expect(() => assertPublicArtifact(value)).toThrow();
    expect(() => assertPublicArtifact({ text: "The expression javascript: is ordinary quoted source prose.", sourceLinks: ["https://example.test/public"] })).not.toThrow();
  });
  test("TOC links permit municipal relative paths while refusing executable links and malformed URL arrays", () => {
    for (const href of ["javascript:alert(1)", "//example.test/path", "/\\example.test/path", "/section?token=private", "/section#access_token=private"]) {
      expect(() => assertPublicMunicipalFile("toc.json", { guid: "test", title: "Test", href, children: [] })).toThrow();
    }
    for (const href of ["/CR4919", "/44236160#44236161", "#44236161", "https://ecode360.com/CR4919"]) {
      expect(() => assertPublicMunicipalFile("toc.json", { guid: "test", title: "Test", href, children: [] })).not.toThrow();
    }
    for (const sourceLinks of [[{ other: "javascript:alert(1)" }], [["https://example.test/public"]]]) expect(() => assertPublicArtifact({ sourceLinks })).toThrow();
  });
});

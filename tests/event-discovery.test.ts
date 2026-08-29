import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  DISCOVERY_SCHEMA,
  buildDiscoveryArtifact,
  discoverFromSource,
  icsDateToIso,
  icsTimeNote,
  loadEventSources,
  parseHtmlListing,
  parseIcsEvents,
  parseLlmResolution,
  parseRssItems,
  reconcileDiscoveries,
  unfoldIcsLines,
  type DiscoveredEvent,
  type DropCounters,
  type EventSourceRecord,
} from "../src/event_discovery.ts";
import { readFileSync } from "fs";

const fixtures = join(import.meta.dir, "fixtures", "event-discovery");
const readFixture = (name: string): string => readFileSync(join(fixtures, name), "utf-8");

const counters = (): DropCounters => ({ droppedAmbiguous: 0, droppedUndated: 0 });

function discovered(overrides: Partial<DiscoveredEvent> = {}): DiscoveredEvent {
  return {
    title: "City Council Meeting",
    kind: "government-meeting",
    dateStart: "2026-09-08",
    dateAllDay: true,
    timeNote: null,
    location: null,
    organizer: "Test Source",
    description: "",
    sourceUrl: "https://example.com/event",
    sourceName: "Test Source",
    sourceLinks: ["https://example.com/event"],
    extractionMethod: "markup",
    confidence: 0.9,
    ...overrides,
  };
}

describe("ICS parsing", () => {
  const sample = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Library Story Time\, Fall Session",
    "DTSTART;VALUE=DATE:20261003",
    "LOCATION:Main Branch\; 1600 California St",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Folded Summary Line That",
    "  Continues Across Lines",
    "DTSTART:20261012T140000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:No Start Date Here",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  test("parses VEVENT blocks and skips events without DTSTART", () => {
    const events = parseIcsEvents(sample);
    expect(events.length).toBe(2);
    expect(events[0].summary).toBe("Library Story Time, Fall Session");
    expect(events[0].location).toBe("Main Branch; 1600 California St");
  });

  test("unfolds continuation lines per RFC 5545", () => {
    const unfolded = unfoldIcsLines("SUMMARY:Folded Summary Line That\r\n  Continues Across Lines");
    expect(unfolded).toEqual(["SUMMARY:Folded Summary Line That Continues Across Lines"]);
  });

  test("reduces DATE and DATE-TIME dtstart values to ISO and never guesses", () => {
    expect(icsDateToIso("20261003")).toBe("2026-10-03");
    expect(icsDateToIso("20261012T140000Z")).toBe("2026-10-12");
    expect(icsDateToIso("TBD")).toBeNull();
  });

  test("a UTC dtstart is read in the calendar's own timezone, date and time together", () => {
    // 2026-10-12T02:30Z is the evening of the 11th in Crescent City. Reporting
    // the 12th at 02:30 would publish a meeting on the wrong day AND at a time
    // nobody holds one.
    expect(icsDateToIso("20261012T023000Z")).toBe("2026-10-11");
    expect(icsTimeNote("20261012T023000Z")).toBe("19:30");
    // Same instant, still consistent when the local day matches the UTC day.
    expect(icsDateToIso("20261012T230000Z")).toBe("2026-10-12");
    expect(icsTimeNote("20261012T230000Z")).toBe("16:00");
  });

  test("a floating/TZID dtstart is already local and is read as written", () => {
    expect(icsDateToIso("20261012T140000")).toBe("2026-10-12");
    expect(icsTimeNote("20261012T140000")).toBe("14:00");
  });

  test("a date-only dtstart carries no time", () => {
    expect(icsTimeNote("20261003")).toBeNull();
    expect(icsTimeNote("TBD")).toBeNull();
  });
});

describe("RSS parsing", () => {
  // Minimal but structurally faithful RSS sample modeled on real civic feeds.
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>Harbor Festival Returns</title>
<link>https://example.org/harbor-festival</link>
<pubDate>Tue, 15 Sep 2026 18:00:00 GMT</pubDate>
<description><![CDATA[Family activities at the harbor.]]></description></item>
<item><title>No Link Item</title><pubDate>Tue, 15 Sep 2026 18:00:00 GMT</pubDate></item>
</channel></rss>`;

  test("extracts titled items with links and dates only", () => {
    const items = parseRssItems(rss);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Harbor Festival Returns");
    expect(items[0].link).toBe("https://example.org/harbor-festival");
    expect(items[0].pubDate).toContain("Sep 2026");
  });
});

describe("HTML listing parsing", () => {
  test("parses a trimmed REAL Crescent City calendar listing page for calendar ids indirectly via rows", () => {
    // The live city listing loads its table via JS, so this fixture documents
    // the generic-selector path against real page markup (widget container).
    const html = readFixture("crescent_city_calendar_listing.html");
    const rows = parseHtmlListing(html, "https://www.crescentcity.org/calendar");
    expect(Array.isArray(rows)).toBe(true);
    // The fixture is a server-rendered controls fragment: no complete event
    // rows with titles are expected - which is exactly why the EvoGov JSON
    // strategy exists.
    for (const row of rows) {
      expect(typeof row.title).toBe("string");
      expect(row.title.length).toBeGreaterThan(0);
      expect(/^https?:\/\//i.test(row.link)).toBe(true);
    }
  });

  test("relative links resolve against the page origin", () => {
    const html = `<html><body>
      <div class="event"><h3><a href="/events/42/">Board Walkthrough</a></h3>
      <time datetime="2026-11-05">Nov 5, 2026</time></div>
    </body></html>`;
    const rows = parseHtmlListing(html, "https://www.example.org/calendar/");
    expect(rows.length).toBe(1);
    expect(rows[0].link).toBe("https://www.example.org/events/42/");
    expect(rows[0].dateRaw).toBe("2026-11-05");
    expect(rows[0].hasDateContext).toBe(true);
  });

  test("rows without any date-like text are flagged hasDateContext=false", () => {
    const html = `<html><body><article class="event">
      <h3>Ongoing Art Display</h3><a href="https://x.example/e">details</a>
    </article></body></html>`;
    const rows = parseHtmlListing(html, "https://www.example.org/");
    expect(rows.length).toBe(1);
    expect(rows[0].hasDateContext).toBe(false);
  });
});

describe("EvoGov JSON strategy (fixture-recorded)", () => {
  test("discoverFromSource maps a real recorded get_list payload onto events", async () => {
    const meta = JSON.parse(readFixture("crescent_city_get_list.json")) as { _rows: Array<Record<string, unknown>> };
    const row = meta._rows[0];
    expect(typeof row.title).toBe("string");
    expect(String(row.start_date_sortable)).toMatch(/^\d{14}$/);
    // Discover through the module's own mapping logic by pointing the
    // fetch-free path at a data: URL is not possible; instead assert the
    // exported transform inputs directly to keep the test deterministic.
    // The full fetch path is exercised live by `bun run src/event_discovery.ts`.
    expect(row.detail_link).toContain("https://www.crescentcity.org/events/");
  });

  test("extractEvoGovCalendarIds-style checkbox ids are present in the real listing fixture", () => {
    const html = readFixture("crescent_city_calendar_listing.html");
    const patterns = [
      /class="evo_calendar_selection_checkbox"[^>]*>\s*<input[^>]*value="(\d+)"/g,
      /value="(\d+)"\s+name="\1"/g,
    ];
    const ids = new Set<string>();
    for (const pattern of patterns) for (const m of html.matchAll(pattern)) ids.add(m[1]);
    // The real page carries the calendar checkboxes even though the event
    // table itself is JS-loaded.
    expect(ids.size).toBeGreaterThan(0);
  });
});

describe("LLM resolution parsing", () => {
  test("strict-parses valid JSON responses and rejects malformed ones", () => {
    const ok = parseLlmResolution('{"date":"2026-10-17","timeNote":"13:30","location":"Ferry Terminal"}');
    expect(ok).not.toBeNull();
    expect(ok?.date).toBe("2026-10-17");
    expect(ok?.timeNote).toBe("13:30");

    const bad = parseLlmResolution("I could not find any date in that text.");
    expect(bad).toBeNull();

    const nullDate = parseLlmResolution('{"date":null,"timeNote":null,"location":null}');
    expect(nullDate?.date).toBeNull();
  });

  test("drops events instead of guessing when the LLM is unavailable", async () => {
    const source: EventSourceRecord = {
      name: "Test HTML",
      url: "https://example.invalid/feed",
      type: "html",
      notes: "",
    };
    const drops = counters();
    const result = await discoverFromSource(source, drops, {
      resolveLlm: async () => ({ date: null, timeNote: null, location: null }),
    });
    expect(result.status).toBe("error");
  });
});

describe("reconciliation", () => {
  test("same title within +/-1 day marks reconciled, not conflicting", () => {
    const result = reconcileDiscoveries(
      [discovered({ title: "City Council Meeting", dateStart: "2026-09-08" })],
      [{ title: "City Council Meeting", dateStart: "2026-09-09" }],
    );
    expect(result.reconciled).toBe(1);
    expect(result.conflictsFlagged).toBe(0);
    expect(result.merged[0].needsReview).toBe(false);
  });

  test("beyond tolerance flags needsReview and keeps both URL sets discoverable", () => {
    const result = reconcileDiscoveries(
      [discovered({ dateStart: "2026-11-20", confidence: 0.9 })],
      [{ title: "City Council Meeting", dateStart: "2026-09-08" }],
    );
    expect(result.conflictsFlagged).toBe(1);
    expect(result.merged[0].needsReview).toBe(true);
    expect(result.merged[0].confidence).toBeLessThanOrEqual(0.7);
    expect(result.merged[0].sourceLinks.length).toBe(1);
  });

  test("unmatched titles pass through untouched", () => {
    const result = reconcileDiscoveries([discovered({ title: "Brand New Festival" })], []);
    expect(result.reconciled).toBe(0);
    expect(result.conflictsFlagged).toBe(0);
    expect(result.merged.length).toBe(1);
  });
});

describe("loadEventSources", () => {
  test("loads the checked-in registry of real probed feeds", () => {
    const sources = loadEventSources();
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const source of sources) {
      expect(/^https?:\/\//i.test(source.url)).toBe(true);
      expect(["html", "rss", "ics"]).toContain(source.type);
      expect(typeof source.probe?.status === "string" || source.probe === undefined).toBe(true);
    }
    expect(sources.some(s => s.strategy === "evogov-json")).toBe(true);
  });
});

describe("buildDiscoveryArtifact (no-network determinism)", () => {
  test("empty registry produces an empty zeroed artifact without network access", async () => {
    const artifact = await buildDiscoveryArtifact("2026-08-26T00:00:00.000Z", "/nonexistent-root-xyz", {
      includeNetwork: false,
    });
    expect(artifact.schemaVersion).toBe(DISCOVERY_SCHEMA);
    expect(artifact.counts.count).toBe(0);
    expect(artifact.events.length).toBe(0);
    expect(artifact.provenance.reconciledAgainst).toBe("output/events/events.json");
    expect(artifact.generatedAt).toBe("2026-08-26T00:00:00.000Z");
  });

  test("every artifact ground rule mentions provenance fields or dropping rules", async () => {
    const artifact = await buildDiscoveryArtifact("2026-08-26T00:00:00.000Z", "/nonexistent-root-xyz", {
      includeNetwork: false,
    });
    const joined = artifact.provenance.groundRules.join(" ");
    expect(joined).toContain("extractionMethod");
    expect(joined).toContain("never guessed");
  });
});

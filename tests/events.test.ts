import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  MAX_EVENTS,
  MAX_SOURCE_LINKS,
  buildEventsArtifact,
  classify,
  collectEvents,
  dedupeAndMerge,
  kindFor,
  buildEventsIcs,
  escapeIcsText,
  foldIcsLine,
  formatIcsStamp,
  nextIsoDay,
  parseEventDate,
  extractTimeNote,
  EVENTS_SCHEMA,
  type EventKind,
} from "../src/events.ts";

interface TestCandidate {
  title: string;
  link: string;
  kind: EventKind;
  dateStart: string | null;
  dateAllDay: boolean;
  timeNote: string | null;
  location: string | null;
  organizer: string | null;
  description: string;
  sourceName: string;
  fetchedAt: string | null;
  sourceLinks?: string[];
}

function candidate(overrides: Partial<TestCandidate> = {}): Parameters<typeof dedupeAndMerge>[0][number] {
  const link = overrides.link ?? "https://example.com/event-1";
  const built: TestCandidate = {
    title: "Planning Commission Meeting",
    link,
    kind: "government-meeting",
    dateStart: "2026-09-10",
    dateAllDay: true,
    timeNote: null,
    location: null,
    organizer: "Planning Commission",
    description: "",
    sourceName: "Government meeting",
    fetchedAt: null,
    ...overrides,
  };
  if (!built.sourceLinks) built.sourceLinks = [link];
  return built as Parameters<typeof dedupeAndMerge>[0][number];
}

async function writeFixture(root: string, relative: string, value: unknown): Promise<void> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("parseEventDate", () => {
  test("parses named US dates to ISO", () => {
    expect(parseEventDate("Mar 18, 2026")).toBe("2026-03-18");
    expect(parseEventDate("March 18, 2026")).toBe("2026-03-18");
  });

  test("passes ISO dates through", () => {
    expect(parseEventDate("2026-03-18")).toBe("2026-03-18");
    expect(parseEventDate("2026-03-18T19:00:00Z")).toBe("2026-03-18");
  });

  test("never fabricates a date", () => {
    expect(parseEventDate("NA")).toBeNull();
    expect(parseEventDate("N/A")).toBeNull();
    expect(parseEventDate("TBD")).toBeNull();
    expect(parseEventDate("")).toBeNull();
    expect(parseEventDate("garbage input")).toBeNull();
    expect(parseEventDate(null)).toBeNull();
    expect(parseEventDate(undefined)).toBeNull();
    expect(parseEventDate(42)).toBeNull();
  });
});

describe("classify", () => {
  test("future dates are scheduled", () => {
    expect(classify("2099-01-01")).toBe("scheduled");
  });

  test("past dates are completed", () => {
    expect(classify("2001-01-01")).toBe("completed");
  });

  test("null is unknown", () => {
    expect(classify(null)).toBe("unknown");
  });
});

describe("dedupeAndMerge", () => {
  test("merges same title + date with union of links", () => {
    const merged = dedupeAndMerge([
      candidate({ link: "https://a.example/one" }),
      candidate({ link: "https://b.example/two", sourceLinks: ["https://b.example/two", "https://c.example/three"] }),
      candidate({ link: "https://a.example/one" }),
    ]);
    expect(merged.length).toBe(1);
    const unique = new Set(merged[0].sourceLinks);
    expect(unique.size).toBe(merged[0].sourceLinks.length);
    expect(unique.has("https://b.example/two")).toBe(true);
    expect(unique.has("https://c.example/three")).toBe(true);
  });

  test("keeps different dates separate", () => {
    const merged = dedupeAndMerge([
      candidate({ dateStart: "2026-09-10" }),
      candidate({ dateStart: "2026-10-08" }),
    ]);
    expect(merged.length).toBe(2);
  });
});

describe("kindFor", () => {
  test("maps source types onto kinds", () => {
    expect(kindFor("meetings")).toBe("government-meeting");
    expect(kindFor("youtube")).toBe("youtube");
    expect(kindFor("news", "Holiday closure notice")).toBe("holiday-closure");
    expect(kindFor("news", "Community listing board")).toBe("community-listing");
    expect(kindFor("news", "Lost Coast Outpost")).toBe("civic-news");
  });
});

describe("buildEventsArtifact", () => {
  test("is deterministic with non-empty boundaries", () => {
    const events = [
      { ...candidate(), id: "event-one", status: classify("2026-09-10") } as never as Parameters<typeof buildEventsArtifact>[1][number],
    ];
    const artifact = buildEventsArtifact("2026-08-26T00:00:00.000Z", events);
    expect(artifact.schemaVersion).toBe(EVENTS_SCHEMA);
    expect(artifact.count).toBe(events.length);
    expect(Array.isArray(artifact.provenance.boundaries) && artifact.provenance.boundaries.length > 0).toBe(true);
    expect(artifact.provenance.deterministicFrom).toEqual(["output/gov_meetings", "output/news", "output/youtube"]);
    expect(artifact.llm.status).toBe("skipped");
  });
});

describe("collectEvents against real fixture output trees", () => {
  test("reads gov_meetings, news, and youtube layouts offline", async () => {
    const root = await mkdtemp(join(process.cwd(), ".events-test-"));
    try {
      await writeFixture(root, "gov_meetings/gov_meetings-2026-08-25.json", {
        fetchedAt: "2026-08-25T21:50:13.769Z",
        items: [
          { title: "Planning Commission Meeting", link: "https://www.crescentcity.org/events/101110/", date: "2026-09-10", content: "Agenda attached.", source: "Planning Commission", fetchedAt: "2026-08-25T21:50:13Z" },
          { title: "Planning Commission Meeting", link: "https://mirror.example/101110", date: "2026-09-10", fetchedAt: "2026-08-25T22:00:13Z" },
        ],
      });
      await writeFixture(root, "gov_meetings/source-health.json", { sources: [] });
      await writeFixture(root, "news/news-2026-08-25.json", {
        items: [
          { title: "Hot Dog Hangout at Arcata PD HQ", link: "https://lostcoastoutpost.com/2026/aug/25/x/", pubDate: "Sat, 29 Aug 2026 08:07:14 -0700", content: "", source: "Lost Coast Outpost" },
          { title: "Undated announcement stays out of the calendar", link: "https://example.com/no-date/", pubDate: "not a date", content: "", source: "Local Blog" },
        ],
      });
      await writeFixture(root, "youtube/e2qTN0kivE0.json", {
        videoId: "e2qTN0kivE0",
        title: "Downtown Visioning Workshop",
        channel: "City of Crescent City, California",
        uploadDate: "NA",
        status: "ok",
      });

      const events = await collectEvents(root);
      const meeting = events.find(event => event.title === "Planning Commission Meeting");
      expect(meeting).toBeDefined();
      expect(meeting!.kind).toBe("government-meeting");
      expect(meeting!.dateStart).toBe("2026-09-10");
      // dedupe merged the two batches into one event with both links
      expect(meeting!.sourceLinks.length).toBe(2);

      const datedNews = events.find(event => event.title === "Hot Dog Hangout at Arcata PD HQ");
      expect(datedNews).toBeDefined();
      expect(datedNews!.dateStart).toBe("2026-08-29");

      const undated = events.find(event => event.title === "Undated announcement stays out of the calendar");
      expect(undated).toBeUndefined();

      const youtube = events.find(event => event.title === "Downtown Visioning Workshop");
      expect(youtube).toBeDefined();
      expect(youtube!.kind).toBe("youtube");
      expect(youtube!.dateStart).toBeNull();
      expect(youtube!.status).toBe("unknown");

      // sorted ascending by date with nulls last
      const datedPositions = events.filter(event => event.dateStart !== null).map(event => event.dateStart as string);
      expect([...datedPositions].sort()).toEqual(datedPositions);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("escapeIcsText", () => {
  test("escapes RFC 5545 specials and newlines", () => {
    expect(escapeIcsText("back\\\\slash")).toBe("back\\\\\\\\slash");
    expect(escapeIcsText("semi;comma,colon")).toBe("semi\\;comma\\,colon");
    expect(escapeIcsText("line one\nline two")).toBe("line one\\nline two");
    expect(escapeIcsText("crlf\r\nline")).toBe("crlf\\nline");
  });
});

describe("nextIsoDay", () => {
  test("advances across month and year boundaries in UTC", () => {
    expect(nextIsoDay("2026-08-31")).toBe("2026-09-01");
    expect(nextIsoDay("2026-12-31")).toBe("2027-01-01");
    expect(nextIsoDay("2028-02-28")).toBe("2028-02-29");
    expect(nextIsoDay("2026-02-28")).toBe("2026-03-01");
  });

  test("rejects malformed dates", () => {
    expect(nextIsoDay("not-a-date")).toBeNull();
    expect(nextIsoDay("2026-3-01")).toBeNull();
    expect(nextIsoDay("")).toBeNull();
  });
});

describe("formatIcsStamp", () => {
  test("converts ISO timestamps to ICS UTC form", () => {
    expect(formatIcsStamp("2026-08-26T12:34:56.789Z")).toBe("20260826T123456Z");
    expect(formatIcsStamp("garbage")).toBe("19700101T000000Z");
  });
});

describe("foldIcsLine", () => {
  test("keeps short lines unfolded", () => {
    expect(foldIcsLine("SUMMARY:short")).toEqual(["SUMMARY:short"]);
  });

  test("folds long ASCII lines at octet budget with continuation spaces", () => {
    const line = `DESCRIPTION:${"x".repeat(200)}`;
    const folded = foldIcsLine(line);
    expect(folded.length).toBeGreaterThan(1);
    for (const part of folded) expect(part.length).toBeLessThanOrEqual(75);
    // unfolding (removing CRLF + single space) reconstructs the original
    expect((folded[0] + folded.slice(1).map(part => part.slice(1)).join(""))).toBe(line);
  });
});

describe("buildEventsIcs", () => {
  const base = {
    id: "planning-commission-meeting-2026-09-10-000",
    title: "Planning Commission Meeting",
    dateStart: "2026-09-10",
    location: 'Council Chamber, 186 Main St',
    description: "Agenda; items, and backslashes.",
    sourceLinks: ["https://example.com/agenda.pdf"],
    status: "scheduled",
  } as never as Parameters<typeof buildEventsIcs>[0][number];

  test("emits deterministic VCALENDAR with stable UIDs and fixed DTSTAMP", () => {
    const first = buildEventsIcs([base], { stamp: "2026-08-26T00:00:00.000Z" });
    const second = buildEventsIcs([base], { stamp: "2026-08-26T00:00:00.000Z" });
    expect(first).toBe(second);
    expect(first.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:")).toBe(true);
    expect(first.includes(`UID:${base.id}@crescent-city-intel`)).toBe(true);
    expect(first.includes("DTSTAMP:20260826T000000Z")).toBe(true);
    expect(first.includes("DTSTART;VALUE=DATE:20260910")).toBe(true);
    expect(first.includes("DTEND;VALUE=DATE:20260911")).toBe(true);
    expect(first.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  test("default DTSTAMP is the fixed epoch value, independent of clock", () => {
    expect(buildEventsIcs([base]).includes("DTSTAMP:19700101T000000Z")).toBe(true);
  });

  test("escapes commas, semicolons, and quotes in text fields", () => {
    const ics = buildEventsIcs([base]);
    expect(ics.includes("LOCATION:Council Chamber\\, 186 Main St")).toBe(true);
    expect(ics.includes("DESCRIPTION:Agenda\\; items\\, and backslashes.")).toBe(true);
    expect(ics).not.toContain('Agenda; items');
  });

  test("skips undated events instead of fabricating DTSTART", () => {
    const ics = buildEventsIcs([base, { ...base, id: "undated-one", dateStart: null }]);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(ics).not.toContain("undated-one");
  });

  test("marks unknown-status events TENTATIVE and maps scheduled to CONFIRMED", () => {
    const ics = buildEventsIcs([{ ...base, status: "unknown" }, { ...base, id: "e2", status: "completed" }]);
    expect(ics.includes("STATUS:TENTATIVE")).toBe(true);
    expect((ics.match(/STATUS:CONFIRMED/g)?.length ?? 0)).toBe(1);
  });

  test("sorts nothing but preserves input order deterministically", () => {
    const a = { ...base, id: "a-first", title: "Alpha" };
    const b = { ...base, id: "b-second", title: "Beta", dateStart: "2025-01-01" };
    const forward = buildEventsIcs([a, b]);
    const backward = buildEventsIcs([b, a]);
    expect(forward.indexOf("a-first")).toBeLessThan(forward.indexOf("b-second"));
    expect(backward.indexOf("b-second")).toBeLessThan(backward.indexOf("a-first"));
  });
});

describe('collectEvents > discovery merge', () => {
  test('merges discovered calendar events and drops URL-less/undated discovery records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'events-disc-'));
    const batch = (items: unknown[]) => JSON.stringify({ schemaVersion: 'x', items });
    await mkdir(join(base, 'gov_meetings'), { recursive: true });
    await Bun.write(join(base, 'gov_meetings', 'batch-1.json'), batch([
      { title: 'Council Regular Meeting', link: 'https://example.com/m1', date: '2026-09-15', source: 'City Council' },
    ]));
    await mkdir(join(base, 'events'), { recursive: true });
    await Bun.write(join(base, 'events', 'event_discovery.json'), JSON.stringify({
      schemaVersion: 'crescent-city-events-discovery/v1',
      events: [
        { title: 'Board of Supervisors', kind: 'government-meeting', dateStart: '2026-10-06', sourceUrl: 'https://example.com/bos', sourceName: 'County of Del Norte Community Events Calendar', confidence: 0.9 },
        { title: 'No URL Workshop', kind: 'community-listing', dateStart: '2026-10-07', sourceName: 'Library' },
        { title: 'Undated Fair', kind: 'community-listing', sourceUrl: 'https://example.com/fair', sourceName: 'Chamber' },
      ],
    }));
    const events = await collectEvents(base);
    const titles = events.map(event => event.title);
    expect(titles).toContain('Council Regular Meeting');
    expect(titles).toContain('Board of Supervisors');
    expect(titles).not.toContain('No URL Workshop');
    expect(titles).not.toContain('Undated Fair');
    const bos = events.find(event => event.title === 'Board of Supervisors')!;
    expect(bos.kind).toBe('government-meeting');
    expect(bos.dateStart).toBe('2026-10-06');
    expect(bos.sourceLinks).toContain('https://example.com/bos');
    await rm(base, { recursive: true, force: true });
  });
});

describe('extractTimeNote — publish metadata vs event time', () => {
  test('rejects full RFC-2822 and ISO publish stamps', () => {
    expect(extractTimeNote('Thu, 06 Aug 2026 16:45:19 +0000')).toBeNull();
    expect(extractTimeNote('Wed, 12 Aug 2026 16:25:00 -0700')).toBeNull();
    expect(extractTimeNote('2026-09-10T17:30:00Z')).toBeNull();
    expect(extractTimeNote('2026-09-10 17:30:00')).toBeNull();
  });
  test('extracts bare clock times with optional meridiem', () => {
    expect(extractTimeNote('5:30 PM')).toBe('5:30 PM');
    expect(extractTimeNote('6:00pm')).toBe('6:00 PM');
    expect(extractTimeNote('10:00')).toBe('10:00');
    expect(extractTimeNote('Meets 9:00 AM upstairs')).toBe('9:00 AM');
  });
  test('returns null for absent or junk input', () => {
    expect(extractTimeNote(null)).toBeNull();
    expect(extractTimeNote('')).toBeNull();
    expect(extractTimeNote('all day')).toBeNull();
    expect(extractTimeNote('25:99')).toBeNull();
  });
  test('structured discovery timeNote passes through collectEvents', async () => {
    const base = await mkdtemp(join(tmpdir(), 'events-time-'));
    await mkdir(join(base, 'events'), { recursive: true });
    await Bun.write(join(base, 'events', 'event_discovery.json'), JSON.stringify({
      schemaVersion: 'crescent-city-events-discovery/v1',
      events: [
        { title: 'Board of Supervisors', kind: 'government-meeting', dateStart: '2026-10-06', timeNote: '10:00 AM', sourceUrl: 'https://example.com/bos', sourceName: 'County of Del Norte Community Events Calendar' },
        { title: 'Workshop No Time', kind: 'community-listing', dateStart: '2026-10-07', sourceUrl: 'https://example.com/w', sourceName: 'Library' },
      ],
    }));
    const events = await collectEvents(base);
    const bos = events.find(event => event.title === 'Board of Supervisors')!;
    expect(bos.timeNote).toBe('10:00 AM');
    const ws = events.find(event => event.title === 'Workshop No Time')!;
    expect(ws.timeNote).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});

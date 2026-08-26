import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  MAX_EVENTS,
  MAX_SOURCE_LINKS,
  buildEventsArtifact,
  classify,
  collectEvents,
  dedupeAndMerge,
  kindFor,
  parseEventDate,
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

import { describe, expect, test } from "bun:test";
import {
  parseTriplicateCalendar,
  splitStreamedJson,
  resolveDevalue,
} from "../src/event_discovery.ts";
import {
  splitStreamedJsonObjects,
  resolveDevalueArticle,
} from "../src/triplicate_monitor.ts";

// Real captured structure shapes (devalue format) from triplicate.com
// __data.json endpoints, trimmed to the fields the parsers consume.

const CALENDAR_CHUNK = JSON.stringify({
  type: "data",
  nodes: [
    { data: [
      { events: 1 },
      [2, 8],
      { id: 3, title: 4, description: 5, location: 6, organizer: 7, start_date: 9, end_date: 10, start_time: 11 },
      "37d712de-uuid",
      "Crescent City Ghost Tours",
      "A haunted walking tour",
      null,
      "Del Norte Visitor's Guide",
      "2025-02-24",
      "2025-02-24",
      "2027-01-01",
      "18:00",
    ] },
  ],
});

const ARTICLE_CHUNK = JSON.stringify({
  type: "data",
  nodes: [
    { data: [
      { id: 1, headline: 2, body_html: 3, released_at: 4, byline_given: 5, byline_family: 6 },
      "e1e049d9-uuid",
      "DNSO Meth Bust off Elk Valley Road",
      "<p>First paragraph.</p><p>Second &amp; third.</p>",
      "2025-09-19 12:00:00+00",
      null,
      null,
    ] },
  ],
});

describe("parseTriplicateCalendar (devalue __data.json)", () => {
  test("resolves index-referenced event records into dated events", () => {
    const events = parseTriplicateCalendar(CALENDAR_CHUNK);
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.title).toBe("Crescent City Ghost Tours");
    expect(ev.startDate).toBe("2025-02-24");
    expect(ev.endDate).toBe("2027-01-01");
    expect(ev.startTime).toBe("18:00");
    expect(ev.organizer).toBe("Del Norte Visitor's Guide");
    expect(ev.location).toBeNull();
  });

  test("sorts by start date then title, and drops undated/untitled records", () => {
    const two = CALENDAR_CHUNK.replace('"Crescent City Ghost Tours"', '"Alpha Event"').replace("2025-02-24", "2024-01-01");
    const combined = CALENDAR_CHUNK + "\n" + two;
    const events = parseTriplicateCalendar(combined);
    expect(events.length).toBe(2);
    expect(events[0].startDate <= events[1].startDate).toBe(true);
  });

  test("returns [] for garbage or empty payloads rather than throwing", () => {
    expect(parseTriplicateCalendar("")).toEqual([]);
    expect(parseTriplicateCalendar("not json at all")).toEqual([]);
    expect(parseTriplicateCalendar(JSON.stringify({ nodes: [{ data: [] }] }))).toEqual([]);
  });
});

describe("splitStreamedJson (SvelteKit streamed responses)", () => {
  test("walks concatenated objects and skips truncated tails", () => {
    const a = JSON.stringify({ type: "data", n: 1 });
    const b = JSON.stringify({ type: "data", nodes: [{ data: [42] }] });
    const truncated = '{"type":"data","nodes":[{"dat';
    const objs = splitStreamedJson([a, b, truncated].join("\n"));
    expect(objs.length).toBe(2);
  });

  test("resolveDevalue dereferences integer node indices recursively", () => {
    const nodes = ["shared-string", { title: 0, tags: [0] }, "ignored"];
    const resolved = resolveDevalue(nodes, { title: 0, tags: [0] } as unknown);
    expect((resolved as { title: string }).title).toBe("shared-string");
    expect((resolved as { tags: string[] }).tags).toEqual(["shared-string"]);
  });
});

describe("Triplicate deep-article channel", () => {
  test("resolves headline + body_html + byline from the article node", () => {
    const objs = splitStreamedJsonObjects(ARTICLE_CHUNK);
    expect(objs.length).toBe(1);
    const nodes = (objs[0] as { nodes: Array<{ data: unknown[] }> }).nodes[0].data;
    const articleNode = nodes.find(v => typeof v === "object" && v !== null && "headline" in (v as object)) as Record<string, unknown>;
    const resolved = resolveDevalueArticle(nodes, articleNode) as Record<string, unknown>;
    expect(resolved.headline).toBe("DNSO Meth Bust off Elk Valley Road");
    expect(resolved.body_html).toContain("<p>First paragraph.</p>");
    expect(resolved.byline_given).toBeNull();
  });
});

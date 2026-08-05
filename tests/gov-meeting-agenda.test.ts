/**
 * Tests for the structured agenda/minutes extraction in src/gov_meeting_monitor.ts
 * (extractLinkItems). Zero-mock: pure function over fixture anchor HTML.
 */
import { describe, test, expect } from "bun:test";
import { extractLinkItems } from "../src/gov_meeting_monitor.ts";

describe("extractLinkItems", () => {
  test("parses anchor title + absolute href", () => {
    const items = extractLinkItems(['<a href="https://s3.us-west.example/a.pdf">Agenda Packet</a>']);
    expect(items).toEqual([{ title: "Agenda Packet", url: "https://s3.us-west.example/a.pdf" }]);
  });

  test("resolves relative hrefs against the city origin", () => {
    const items = extractLinkItems(['<a href="/meetingfiles/123/agenda.pdf">Agenda</a>']);
    expect(items[0].url).toBe("https://www.crescentcity.org/meetingfiles/123/agenda.pdf");
    expect(items[0].title).toBe("Agenda");
  });

  test("falls back to the URL when the anchor has no text or entities", () => {
    const items = extractLinkItems(['<a href="/x.pdf"></a>', "<a href='/y.pdf'>Minutes &amp; Agenda</a>"]);
    expect(items[0].title).toBe(items[0].url);
    expect(items[1].title).toBe("Minutes & Agenda");
  });

  test("returns [] for undefined/empty input and skips anchors without href", () => {
    expect(extractLinkItems(undefined)).toEqual([]);
    expect(extractLinkItems([])).toEqual([]);
    expect(extractLinkItems(["<a>no href</a>"])).toEqual([]);
  });
});

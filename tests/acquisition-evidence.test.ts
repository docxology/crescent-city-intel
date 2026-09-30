import { expect, test } from "bun:test";
import { acquireOfficialMeetingDocuments, parseOfficialMeetingDocuments } from "../src/official_meetings.ts";
import { boundedFetchBytes, resetConnectorState } from "../src/alerts/connector.ts";
import { custodyHash } from "../src/corpus_editions.ts";

test("official document discovery binds record-local dates and meaningful labels without collecting navigation", () => {
  const source = { id: "harbor-agendas", name: "Harbor Commission", url: "https://agency.example/archive" };
  const html = `<nav><a href="/meetings">Board meetings</a><a href="/calendar">Calendar</a></nav>
    <article><time datetime="2026-09-30"></time><a href="/docs/agenda.pdf" aria-label="View Harbor Commission Meeting September 30, 2026">Read more »</a></article>
    <article><a href="/docs/minutes-2026-08-15.pdf">Minutes August 15, 2026</a></article>
    <article><a href="/docs/%E0%A4%A.pdf">Undated attachment</a></article>`;
  const records = parseOfficialMeetingDocuments(html, source);
  expect(records).toHaveLength(3);
  const meeting = records.find(record => record.link.endsWith("agenda.pdf"))!;
  expect(meeting.title).toBe("Harbor Commission Meeting September 30, 2026");
  expect(meeting.date).toBe("2026-09-30"); expect(meeting.dateEvidence).toBe("meeting-context");
  expect(meeting.occurrenceEligible).toBe(false); // Meeting-context PDF remains a document, not another occurrence.
  const minutes = records.find(record => record.title.startsWith("Minutes"))!;
  expect(minutes.date).toBe("2026-08-15"); expect(minutes.dateEvidence).toBe("document-label");
  expect(records.find(record => record.title === "Undated attachment")!.dateEvidence).toBe("unknown");
  expect(records.every(record => record.sourceId === source.id && /^[a-f0-9]{64}$/.test(record.hash))).toBe(true);
  const notices = parseOfficialMeetingDocuments('<article><time datetime="2026-09-30"></time><h3>Board meeting</h3><a href="/2026-09-30-board-meeting">Read more »</a></article><article><time datetime="2026-10-01"></time><h3>Notice of Cancellation</h3><a href="/2026-10-01-board-meeting">Read more »</a></article>', source);
  expect(notices.map(notice => notice.occurrenceEligible)).toEqual([true, false]);
});

test("real HTTP agency acquisition retains exact bytes and distinguishes a portal shell", async () => {
  resetConnectorState();
  const html = '<article><time datetime="2026-09-30"></time><a href="/agenda.pdf">Board agenda</a></article>';
  const server = Bun.serve({ port: 0, fetch(request): Response {
    const path = new URL(request.url).pathname;
    return path === "/robots.txt" ? new Response("User-agent: *\nAllow: /\n") : new Response(path === "/archive" ? html : "<nav><a href='/meetings'>Board meetings</a></nav>");
  } });
  const options = { allowPrivateHosts: ["127.0.0.1"], minIntervalMs: 0, retry: false };
  try {
    const source = { id: "fixture-agendas", name: "Fixture board", url: `http://127.0.0.1:${server.port}/archive` };
    const acquired = await acquireOfficialMeetingDocuments(source, options);
    expect(acquired.rawHtml).toBe(html); expect(acquired.rawSha256).toBe(custodyHash(html)); expect(acquired.items).toHaveLength(1);
    expect(acquired.coverage).toBe("documents-discovered"); expect(acquired.parserVersion).toBe("official-meeting-links/v2"); expect(Number.isFinite(Date.parse(acquired.fetchedAt))).toBe(true);
    expect((await acquireOfficialMeetingDocuments({ ...source, url: source.url.replace("archive", "portal") }, options)).coverage).toBe("unrecognized-page");
  } finally { server.stop(true); resetConnectorState(); }
});

test("binary connector preserves non-UTF8 source bytes and enforces policy and size caps", async () => {
  resetConnectorState(); const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255, 128, 10]); let deniedRequests = 0;
  const server = Bun.serve({ port: 0, fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /denied\nAllow: /\n");
    if (path === "/denied") deniedRequests++;
    return new Response(bytes);
  } });
  const base = `http://127.0.0.1:${server.port}`;
  const options = { label: "fixture PDF bytes", maxBytes: bytes.length, timeoutMs: 1000, minIntervalMs: 0, retry: false, allowPrivateHosts: ["127.0.0.1"] };
  try {
    expect(await boundedFetchBytes(`${base}/document`, options)).toEqual(bytes);
    await expect(boundedFetchBytes(`${base}/document`, { ...options, maxBytes: bytes.length - 1 })).rejects.toMatchObject({ kind: "size" });
    await expect(boundedFetchBytes(`${base}/denied`, options)).rejects.toMatchObject({ kind: "robots" }); expect(deniedRequests).toBe(0);
  } finally { server.stop(true); resetConnectorState(); }
});

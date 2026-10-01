import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireOfficialMeetingDocuments, parseCountyMeetingEvents, countyMeetingFileUrl, isCountyMeetingFileUrl, COUNTY_CIVICCLERK_API, COUNTY_CIVICCLERK_PORTAL, OFFICIAL_MEETING_SOURCES } from "../src/official_meetings.ts";
import { withTransportScope } from "../src/shared/transport.ts";
import { resetConnectorState } from "../src/alerts/connector.ts";
import { custodyHash } from "../src/corpus_editions.ts";
import { fetchGovMeetingsDetailed } from "../src/gov_meeting_monitor.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";
import { paths } from "../src/shared/paths.ts";
const source = OFFICIAL_MEETING_SOURCES.find(row => row.id === "county-meetings")!;
const fixture = await Bun.file("tests/fixtures/county-civicclerk-events.json").json();
const asOf = "2026-10-01T20:00:00Z";
const parse = (value: unknown) => parseCountyMeetingEvents(value, "2026-09-01", "2026-10-31", asOf);
const landing = `<a href="${COUNTY_CIVICCLERK_PORTAL}">Agenda System</a>`;
const allowedOrigins = [new URL(source.url).origin, new URL(COUNTY_CIVICCLERK_API).origin];

test("captured County fields produce only published documents with civil date and completion uncertainty", () => {
  const result = parse(fixture);
  expect(result.items).toHaveLength(6);
  expect(result.counts).toMatchObject({ returnedEventCount: 4, selectedEventCount: 4, scheduledNoticeCount: 2, publishedDocumentCount: 6, retainedDocumentCount: 6, nextPagePresent: false, coverage: "bounded-provider-window", timeZoneEvidence: "unknown" });
  for (const item of result.items) {
    expect(item).toMatchObject({ sourceId: "county-meetings", recordKind: "meeting-document", dateEvidence: "provider-civil-date", occurrenceEligible: false, timeZoneEvidence: "unknown", meetingStatus: "historical-notice" });
    expect(item.date).toMatch(/^2026-09-(?:08|22)$/); expect(item.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(isCountyMeetingFileUrl(item.link)).toBe(true);
  }
  expect(result.items.filter(item => item.minuteItems.length)).toHaveLength(2);
  const currentDay = structuredClone(fixture); currentDay.value = [currentDay.value[2]]; currentDay.value[0].eventDate = "2026-10-01T10:00:00Z";
  expect(parseCountyMeetingEvents(currentDay, "2026-09-01", "2026-10-31", "2026-10-02T00:00:00Z").items.every(item => item.meetingStatus === "scheduled-notice")).toBe(true);
});

test("County consumed fields reject malformed identity, dates, coercion, duplicates and future publication", () => {
  for (const mutate of [
    (row: any) => { row.id = "216"; },
    (row: any) => { row.eventDate = "2026-08-31T10:00:00Z"; },
    (row: any) => { row.eventDate = "2026-10-31T10:00:00Z"; },
    (row: any) => { row.eventDate = "2026-02-30T10:00:00Z"; },
    (row: any) => { row.publishedFiles[0].type = ["Minutes"]; row.publishedFiles[0].fileType = 4; },
    (row: any) => { row.publishedFiles[0].fileId = "765"; },
    (row: any) => { row.publishedFiles[0].fileType = 4; },
    (row: any) => { row.publishedFiles[0].publishOn = "2026-10-02T00:00:00Z"; },
    (row: any) => { row.publishedFiles.push({ ...row.publishedFiles[0] }); },
  ]) {
    const value = structuredClone(fixture); mutate(value.value[2]); expect(() => parse(value)).toThrow();
  }
  expect(() => parse({ value: [fixture.value[2], fixture.value[2]] })).toThrow("identity");
  expect(() => parse({ value: Array(201).fill(fixture.value[2]) })).toThrow("oversized");
  expect(() => parse({ value: [], "@odata.nextLink": {} })).toThrow();
  expect(() => parseCountyMeetingEvents({ value: [] }, "2026-01-01", "2026-12-31", asOf)).toThrow("window");
  const hidden = structuredClone(fixture); hidden.value[2].isPublished = "Draft"; hidden.value[3].isDeleted = true;
  expect(parse(hidden).items).toHaveLength(0);
});

test("County document truncation and unvisited next page stay explicit", () => {
  const value = { value: Array.from({ length: 150 }, (_, index) => ({ ...fixture.value[2], id: index + 1,
    publishedFiles: fixture.value[2].publishedFiles.map((file: any, j: number) => ({ ...file, fileId: index * 3 + j + 1 })) })), "@odata.nextLink": "https://unapproved.invalid/private-next-page" };
  const result = parse(value);
  expect(result.items).toHaveLength(200); expect(result.counts).toMatchObject({ publishedDocumentCount: 450, retainedDocumentCount: 200, documentLimitReached: true, nextPagePresent: true });
});

test("real bounded County HTTP acquisition authenticates the linked tenant and retains exact provider bytes only in acquisition", async () => {
  resetConnectorState(); let apiRequests = 0; const requests: string[] = [];
  const rawJson = JSON.stringify({ ...fixture, "@odata.nextLink": "https://unapproved.invalid/page", operatorMarker: "private-upstream-only" });
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url); requests.push(url.pathname);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
    if (url.pathname === "/meetings/85/") return new Response(landing);
    if (url.pathname === "/v1/Events") { apiRequests++; expect(url.searchParams.get("$top")).toBe("200"); expect(url.searchParams.get("$filter")).toContain("2026-09-01T00:00:00Z"); return new Response(rawJson); }
    return new Response("Unexpected path", { status: 500 });
  } });
  try {
    const acquired = await withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins } }, () => acquireOfficialMeetingDocuments(source, { asOf, minIntervalMs: 0 }));
    expect(acquired.items).toHaveLength(6); expect(acquired.parserVersion).toBe("county-civicclerk-documents/v1"); expect(acquired.provider).toMatchObject({ rawJson, rawSha256: custodyHash(rawJson), nextPagePresent: true, windowStart: "2026-09-01", windowEndExclusive: "2026-10-31" });
    expect(JSON.stringify(acquired.items)).not.toContain("private-upstream-only"); expect(apiRequests).toBe(1);
    expect(requests.every(path => ["/robots.txt", "/meetings/85/", "/v1/Events"].includes(path))).toBe(true);
  } finally { server.stop(true); resetConnectorState(); }
});

test("County tenant substitution, unbounded redirects and invalid API rows fail without false source availability", async () => {
  resetConnectorState(); let apiRequests = 0; let page = `<a href="https://delnortecoca.portal.civicclerk.com.attacker.invalid/">Agenda</a>`; let api = new Response(JSON.stringify(fixture));
  const server = Bun.serve({ port: 0, fetch(request) { const path = new URL(request.url).pathname;
    if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
    if (path === "/meetings/85/") return new Response(page);
    apiRequests++; return api.clone();
  } });
  const run = () => withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins } }, () => acquireOfficialMeetingDocuments(source, { asOf, minIntervalMs: 0 }));
  try {
    await expect(run()).rejects.toThrow("approved public agenda tenant"); expect(apiRequests).toBe(0);
    page = `<a href="https://user:password@delnortecoca.portal.civicclerk.com/">Agenda</a>`;
    await expect(run()).rejects.toThrow("approved public agenda tenant"); expect(apiRequests).toBe(0);
    page = landing; api = new Response("", { status: 302, headers: { location: "https://unapproved.invalid/private" } });
    await expect(run()).rejects.toMatchObject({ kind: "redirect" });
    api = new Response(JSON.stringify({ value: [{ ...fixture.value[2], eventDate: "2027-01-01T00:00:00Z" }] }));
    await expect(run()).rejects.toThrow("outside the requested window");
  } finally { server.stop(true); resetConnectorState(); }
});

test("recognized empty County window is source-health empty and retained separately from public meeting rows", async () => {
  resetConnectorState(); const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(path === "/robots.txt" ? "User-agent: *\nAllow: /\n" : path === "/meetings/85/" ? landing : JSON.stringify({ value: [] }));
  } });
  try {
    await withEmptyCorpus(async () => {
      const result = await withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins } }, () => fetchGovMeetingsDetailed(source.url, source.name));
      expect(result.items).toHaveLength(0); expect(result.health.status).toBe("empty"); expect(result.health.sourceId).toBe("county-meetings"); expect(result.health.fetchedAt).toBeTruthy(); expect(result.health.provenance).toContain("timezone unknown");
      const directory = join(paths.govMeetings, "acquisitions"); const files = await readdir(directory); expect(files).toHaveLength(1);
      const receipt = JSON.parse(await readFile(join(directory, files[0]!), "utf8")); expect(receipt).toMatchObject({ coverage: "recognized-empty", provider: { rawJson: '{"value":[]}', returnedEventCount: 0 } });
    });
  } finally { server.stop(true); resetConnectorState(); }
});

test("unchanged County landing HTML preserves distinct provider capture receipts across observations", async () => {
  resetConnectorState(); let sequence = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(path === "/robots.txt" ? "User-agent: *\nAllow: /\n" : path === "/meetings/85/" ? landing : JSON.stringify({ value: [], capture: ++sequence }));
  } });
  try {
    await withEmptyCorpus(async () => {
      const run = () => withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins } }, () => fetchGovMeetingsDetailed(source.url, source.name));
      expect((await run()).health.status).toBe("empty"); expect((await run()).health.status).toBe("empty");
      const directory = join(paths.govMeetings, "acquisitions"), files = await readdir(directory);
      expect(files).toHaveLength(2);
      const receipts = await Promise.all(files.map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
      expect(new Set(receipts.map(receipt => receipt.rawSha256)).size).toBe(1);
      expect(new Set(receipts.map(receipt => receipt.provider.rawSha256)).size).toBe(2);
      expect(receipts.map(receipt => JSON.parse(receipt.provider.rawJson).capture).sort()).toEqual([1, 2]);
    });
  } finally { server.stop(true); resetConnectorState(); }
}, 15_000);

test("County provider body and robots admission remain bounded before reporting source availability", async () => {
  resetConnectorState(); let denyApiRobots = false, robotsRequests = 0, apiRequests = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/robots.txt") { robotsRequests++; return denyApiRobots && robotsRequests === 2 ? new Response("denied", { status: 403 }) : new Response("User-agent: *\nAllow: /\n"); }
    if (path === "/meetings/85/") return new Response(landing);
    apiRequests++; return new Response(JSON.stringify(fixture));
  } });
  const run = () => withTransportScope({ fixture: { origin: `http://127.0.0.1:${server.port}`, allowedOrigins } }, () => acquireOfficialMeetingDocuments(source, { asOf, minIntervalMs: 0, maxBytes: 256 }));
  try {
    await expect(run()).rejects.toMatchObject({ kind: "size" }); expect(apiRequests).toBe(1);
    resetConnectorState(); denyApiRobots = true; robotsRequests = 0; apiRequests = 0;
    await expect(run()).rejects.toMatchObject({ kind: "robots" }); expect(apiRequests).toBe(0);
  } finally { server.stop(true); resetConnectorState(); }
});

test("County file-stream admission is exact tenant, path, integer and no credential/query/fragment alias", () => {
  const accepted = countyMeetingFileUrl(768); expect(isCountyMeetingFileUrl(accepted)).toBe(true);
  for (const value of [accepted.replace("768", "0768"), accepted.replace("768", "-1"), accepted.replace("768", "2147483648"), accepted.replace("false", "true"), accepted + "?token=secret", accepted + "#secret", accepted.replace("https://", "http://"), accepted.replace(".api.civicclerk.com", ".api.civicclerk.com.attacker.invalid"), accepted.replace("https://", "https://user:secret@"), accepted.replace("GetMeetingFileStream", "GetEventFileStream")]) expect(isCountyMeetingFileUrl(value)).toBe(false);
});

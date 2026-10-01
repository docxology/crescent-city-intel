import { expect, test } from "bun:test";
import { documentPageSpans, isRetainablePdf, meetingDocumentCandidates } from "../src/meeting_documents.ts";
import { custodyHash } from "../src/corpus_editions.ts";
import { withEmptyCorpus } from "./helpers/output-root.ts";
import { writeJsonAtomic } from "../src/shared/source_health.ts";
import { paths } from "../src/shared/paths.ts";
import { join } from "node:path";
import { countyMeetingFileUrl } from "../src/official_meetings.ts";
test("retained extracted text has exact page offsets and independent page identities", () => {
  const result = documentPageSpans("Page one\r\n\f\fPage three\n\f");
  expect(result.pages.length).toBe(3); expect(result.pages[1]!.text).toBe("");
  for (const page of result.pages) { expect(result.text.slice(page.start, page.end)).toBe(page.text); expect(page.textSha256).toBe(custodyHash(page.text)); }
  expect(result.pages.map(page => page.page)).toEqual([1, 2, 3]);
  expect(() => documentPageSpans("bad\0text")).toThrow();
  expect(isRetainablePdf(new TextEncoder().encode("<html>A document portal, not a PDF</html>"))).toBe(false);
  expect(isRetainablePdf(new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(32) + "\n%%EOF\n"))).toBe(true);
  expect(isRetainablePdf(new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(32)))).toBe(false);
});
test("document discovery is bounded to latest declared agenda and minute PDF links", async () => {
  await withEmptyCorpus(async () => {
    await writeJsonAtomic(join(paths.govMeetings, "gov_meetings-2026-01-01.json"), { items: [{ title: "old", link: "https://agency.example/old.pdf" }] });
    await writeJsonAtomic(join(paths.govMeetings, "gov_meetings-2026-09-30.json"), { items: [{ title: "Meeting", date: "2026-09-29", source: "Official agency", link: "https://agency.example/portal", agendaItems: [{ url: "https://agency.example/agenda.pdf" }, { url: "https://user:secret@agency.example/private.pdf" }], minuteLinks: ["https://agency.example/minutes.pdf", "javascript:bad.pdf"] }] });
    const candidates = await meetingDocumentCandidates();
    expect(candidates.length).toBe(2); expect(candidates.every(candidate => candidate.meetingDate === "2026-09-29")).toBe(true);
    expect(candidates.some(candidate => candidate.url.includes("old.pdf"))).toBe(false);
    expect(candidates.some(candidate => candidate.url.includes("secret"))).toBe(false);
  });
});
test("extensionless County published PDFs require exact provider route and County source identity", async () => {
  await withEmptyCorpus(async () => {
    const url = countyMeetingFileUrl(768);
    await writeJsonAtomic(join(paths.govMeetings, "gov_meetings-2026-10-01.json"), { items: [
      { title: "Minutes", date: "2026-09-22", source: "Del Norte County meetings and agendas", sourceId: "county-meetings", link: url },
      { title: "Unbound source", link: countyMeetingFileUrl(763) },
      { title: "Wrong provider", sourceId: "county-meetings", link: url.replace(".api.civicclerk.com", ".api.civicclerk.com.attacker.invalid") },
      { title: "Wrong path", sourceId: "county-meetings", link: url.replace("GetMeetingFileStream", "GetEventFileStream") },
      { title: "Query alias", sourceId: "county-meetings", link: url + "?key=secret" },
    ] });
    expect(await meetingDocumentCandidates()).toEqual([{ title: "Minutes", url, meetingDate: "2026-09-22", source: "Del Norte County meetings and agendas" }]);
  });
});

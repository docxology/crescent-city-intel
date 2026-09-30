/** Bounded public agency document discovery; unknown dates/content remain explicit. */
import { load } from "cheerio";
import { boundedFetchText } from "./alerts/connector.js";
import type { BoundedFetchOptions } from "./alerts/connector.js";
import { custodyHash } from "./corpus_editions.js";
import { parseEventDate } from "./events.js";
export const OFFICIAL_MEETING_SOURCES = [
  { id: "harbor-agendas", name: "Harbor Commission", url: "https://www.ccharbor.com/archived-agendas" },
  { id: "county-meetings", name: "Del Norte County meetings and agendas", url: "https://www.co.del-norte.ca.us/meetings/85/" },
  { id: "county-city-media-hub", name: "Del Norte County and City government media hub", url: "https://media.co.del-norte.ca.us/" },
] as const;
export interface OfficialMeetingDocument { title: string; link: string; date: string; dateEvidence: "meeting-context" | "document-label" | "unknown"; occurrenceEligible: boolean; content: string; hash: string; sourceId: string; recordKind: "meeting-document"; agendaItems: Array<{ title: string; url: string }>; minuteItems: Array<{ title: string; url: string }> }
export interface OfficialMeetingAcquisition { items: OfficialMeetingDocument[]; rawHtml: string; rawSha256: string; fetchedAt: string; parserVersion: "official-meeting-links/v2"; coverage: "documents-discovered" | "unrecognized-page"; limitations: string[] }
function documentDate(context: string): string {
  for (const pattern of [/\b\d{4}-\d{2}-\d{2}\b/g, /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}\b/gi, /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g]) {
    const matches = [...context.matchAll(pattern)];
    if (matches.length === 1) { const date = parseEventDate(matches[0][0]); if (date) return date; }
  }
  return "";
}
function decodedPath(path: string): string { try { return decodeURIComponent(path); } catch { return path; } }
export function parseOfficialMeetingDocuments(html: string, source: { id: string; name: string; url: string }): OfficialMeetingDocument[] {
  const $ = load(html); const items = new Map<string, OfficialMeetingDocument>();
  $("a[href]").each((_, element) => {
    const anchor = $(element); const href = anchor.attr("href") ?? ""; const label = anchor.text().replace(/\s+/g, " ").trim();
    let link: string; try { const url = new URL(href, source.url); if (!/^https?:$/.test(url.protocol) || url.username || url.password) return; link = url.toString(); } catch { return; }
    const pdf = /\.pdf(?:\?|$)/i.test(link);
    const datedNotice = /\d{4}-\d{2}-\d{2}/.test(href) && /agenda|minutes|meeting/i.test(label + " " + href);
    if (!pdf && !datedNotice) return; // Navigation/portal links do not establish meeting records.
    if (!label && !/\.pdf(?:\?|$)/i.test(link)) return;
    // Use one bounded record container; never assign a page-wide date to every anchor.
    const ariaLabel = anchor.attr("aria-label") ?? "";
    let context = ariaLabel || label; let parent = anchor.parent(); let meetingDate = documentDate(ariaLabel); let contextHeading = "";
    for (let depth = 0; depth < 3 && parent.length; depth++, parent = parent.parent()) {
      if (parent.is("body,html")) break;
      const text = parent.text().replace(/\s+/g, " ").trim();
      if (text.length > 700) break;
      const times = parent.find("time[datetime]").map((_, time) => $(time).attr("datetime") ?? "").get();
      if (times.length > 1) break;
      if (new Set(times).size === 1 && times[0]) meetingDate = parseEventDate(times[0]) ?? "";
      const headings = parent.find("h1,h2,h3,h4"); if (headings.length === 1) contextHeading = headings.first().text().replace(/\s+/g, " ").trim();
      if (documentDate(text)) { context = text; break; }
    }
    const title = /^(read more\s*[»>]?|agenda|minutes)$/i.test(label) && (ariaLabel || contextHeading) ? (ariaLabel || contextHeading).replace(/^(?:View|Read more about)\s+/i, "") : label || decodedPath(new URL(link).pathname.split("/").pop() ?? "Public meeting document");
    const date = meetingDate || documentDate(context) || documentDate(decodedPath(new URL(link).pathname));
    const minutes = /minutes/i.test(label + " " + href); const agenda = /agenda/i.test(label + " " + href);
    const occurrenceEligible = !pdf && datedNotice && !!meetingDate && !/cancel(?:led|ed|lation)/i.test(title + " " + context);
    const content = context.slice(0, 700); const hash = custodyHash(JSON.stringify([title, link, date, content, occurrenceEligible]));
    items.set(link, { title, link, date, dateEvidence: meetingDate ? "meeting-context" : date ? "document-label" : "unknown", occurrenceEligible, content, hash, sourceId: source.id, recordKind: "meeting-document", agendaItems: agenda ? [{ title, url: link }] : [], minuteItems: minutes ? [{ title, url: link }] : [] });
  });
  return [...items.values()].slice(0, 200);
}
export async function acquireOfficialMeetingDocuments(source: { id: string; name: string; url: string }, options: Partial<BoundedFetchOptions> = {}): Promise<OfficialMeetingAcquisition> {
  const rawHtml = await boundedFetchText(source.url, { label: source.name, maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000, minIntervalMs: 1000, retry: false, ...options });
  const items = parseOfficialMeetingDocuments(rawHtml, source);
  return { items, rawHtml, rawSha256: custodyHash(rawHtml), fetchedAt: new Date().toISOString(), parserVersion: "official-meeting-links/v2", coverage: items.length ? "documents-discovered" : "unrecognized-page",
    limitations: ["Document links are discovered records; PDF text, votes and effective dates are not inferred", "Unknown document dates remain blank", "Calendar pagination and completeness require separate source acceptance"] };
}

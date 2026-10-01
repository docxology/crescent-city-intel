/** Bounded public agency document discovery; unknown dates/content remain explicit. */
import { load } from "cheerio";
import { boundedFetchText, boundedFetchBytes } from "./alerts/connector.js";
import type { BoundedFetchOptions } from "./alerts/connector.js";
import { custodyHash } from "./corpus_editions.js";
import { parseEventDate, pacificDay } from "./events.js";
import { isCivilDate, isStrictTimestamp } from "./schema_validation.js";
import { withinDeadline } from "./shared/transport.js";
export const COUNTY_CIVICCLERK_PORTAL = "https://delnortecoca.portal.civicclerk.com/";
export const COUNTY_CIVICCLERK_API = "https://delnortecoca.api.civicclerk.com/v1/Events";
const COUNTY_EVENT_LIMIT = 200;
const COUNTY_DOCUMENT_LIMIT = 200;
export const OFFICIAL_MEETING_SOURCES = [
  { id: "harbor-agendas", name: "Harbor Commission", url: "https://www.ccharbor.com/archived-agendas" },
  { id: "county-meetings", name: "Del Norte County meetings and agendas", url: "https://www.co.del-norte.ca.us/meetings/85/" },
  { id: "county-city-media-hub", name: "Del Norte County and City government media hub", url: "https://media.co.del-norte.ca.us/" },
] as const;
export interface OfficialMeetingDocument { title: string; link: string; date: string; dateEvidence: "meeting-context" | "document-label" | "provider-civil-date" | "unknown"; occurrenceEligible: boolean; content: string; hash: string; sourceId: string; recordKind: "meeting-document"; agendaItems: Array<{ title: string; url: string }>; minuteItems: Array<{ title: string; url: string }>; meetingStatus?: "scheduled-notice" | "historical-notice"; timeZoneEvidence?: "unknown" }
export interface CountyMeetingEvidence {
  endpointUrl: string; rawJson: string; rawSha256: string; windowStart: string; windowEndExclusive: string;
  eventLimit: number; documentLimit: number; returnedEventCount: number; selectedEventCount: number; scheduledNoticeCount: number;
  publishedDocumentCount: number; retainedDocumentCount: number; nextPagePresent: boolean; documentLimitReached: boolean;
  coverage: "bounded-provider-window"; timeZoneEvidence: "unknown";
}
export interface OfficialMeetingAcquisition { items: OfficialMeetingDocument[]; rawHtml: string; rawSha256: string; fetchedAt: string; parserVersion: "official-meeting-links/v2" | "county-civicclerk-documents/v1"; coverage: "documents-discovered" | "recognized-empty" | "unrecognized-page"; limitations: string[]; provider?: CountyMeetingEvidence }
export interface OfficialMeetingOptions extends Partial<BoundedFetchOptions> {
  asOf?: string;
}
/** The County portal's published-file route; no arbitrary provider-supplied URL is followed. */
export function countyMeetingFileUrl(fileId: number): string {
  if (!Number.isSafeInteger(fileId) || fileId < 1 || fileId > 2_147_483_647) throw new Error("Invalid County published file identity");
  return `https://delnortecoca.api.civicclerk.com/v1/Meetings/GetMeetingFileStream(fileId=${fileId},plainText=false)`;
}
export function isCountyMeetingFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const match = /^\/v1\/Meetings\/GetMeetingFileStream\(fileId=([1-9]\d{0,9}),plainText=false\)$/.exec(url.pathname);
    return url.origin === "https://delnortecoca.api.civicclerk.com" && !url.username && !url.password && !url.search && !url.hash && !!match && countyMeetingFileUrl(Number(match[1])) === value;
  } catch { return false; }
}
/** Keep the provider's literal civil day; its UTC suffix does not establish meeting timezone semantics. */
export function parseCountyMeetingEvents(value: unknown, windowStart: string, windowEndExclusive: string, asOf: string): { items: OfficialMeetingDocument[]; counts: Omit<CountyMeetingEvidence, "endpointUrl" | "rawJson" | "rawSha256" | "windowStart" | "windowEndExclusive"> } {
  if (!isCivilDate(windowStart) || !isCivilDate(windowEndExclusive) || !isStrictTimestamp(asOf) || windowStart >= windowEndExclusive || Date.parse(windowEndExclusive) - Date.parse(windowStart) > 60 * 86_400_000) throw new Error("Invalid County collection window");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed County event envelope");
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.value) || envelope.value.length > COUNTY_EVENT_LIMIT || envelope["@odata.nextLink"] !== undefined && typeof envelope["@odata.nextLink"] !== "string") throw new Error("Malformed or oversized County event page");
  const items = new Map<string, OfficialMeetingDocument>(); const eventIds = new Set<number>();
  let selectedEventCount = 0, scheduledNoticeCount = 0, publishedDocumentCount = 0;
  for (const input of envelope.value) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Malformed County event row");
    const row = input as Record<string, unknown>;
    if (!Number.isSafeInteger(row.id) || (row.id as number) < 1 || eventIds.has(row.id as number) || typeof row.categoryName !== "string" || typeof row.isPublished !== "string" || typeof row.eventDate !== "string" || !isStrictTimestamp(row.eventDate)) throw new Error("Invalid County event identity or date");
    eventIds.add(row.id as number);
    const date = row.eventDate.slice(0, 10);
    if (!isCivilDate(date) || date < windowStart || date >= windowEndExclusive) throw new Error("County provider returned an event outside the requested window");
    if (row.categoryName !== "Board of Supervisors" || row.isPublished !== "Published" || row.isDeleted === true) continue;
    if (row.isDeleted !== undefined && typeof row.isDeleted !== "boolean" || !Array.isArray(row.publishedFiles) || row.publishedFiles.length > 20) throw new Error("Invalid County published document roster");
    selectedEventCount++;
    const scheduled = date >= pacificDay(new Date(asOf)); if (scheduled) scheduledNoticeCount++;
    for (const inputFile of row.publishedFiles) {
      if (!inputFile || typeof inputFile !== "object" || Array.isArray(inputFile)) throw new Error("Malformed County published file");
      const file = inputFile as Record<string, unknown>;
      if (typeof file.type !== "string") throw new Error("Invalid County published file type");
      if (!["Agenda", "Agenda Packet", "Minutes"].includes(file.type)) continue;
      const expectedType = file.type === "Agenda" ? 1 : file.type === "Agenda Packet" ? 2 : 4;
      if (file.fileType !== expectedType || !Number.isSafeInteger(file.fileId) || typeof file.name !== "string" || !file.name.trim() || file.name.length > 300 || typeof file.publishOn !== "string" || !isStrictTimestamp(file.publishOn) || Date.parse(file.publishOn) > Date.parse(asOf)) throw new Error("Invalid County published file fields");
      const link = countyMeetingFileUrl(file.fileId as number);
      if (items.has(link)) throw new Error("Duplicate County published file identity");
      const title = `${file.type}: ${file.name.trim()}`;
      const content = `Board of Supervisors ${date}; ${scheduled ? "scheduled meeting notice" : "historical meeting notice"}; ${file.type} published ${file.publishOn}. Meeting time zone and meeting completion are not established.`;
      const item: OfficialMeetingDocument = { title, link, date, dateEvidence: "provider-civil-date", occurrenceEligible: false, content,
        hash: custodyHash(JSON.stringify([row.id, title, link, date, content])), sourceId: "county-meetings", recordKind: "meeting-document",
        agendaItems: file.type === "Minutes" ? [] : [{ title, url: link }], minuteItems: file.type === "Minutes" ? [{ title, url: link }] : [],
        meetingStatus: scheduled ? "scheduled-notice" : "historical-notice", timeZoneEvidence: "unknown" };
      items.set(link, item); publishedDocumentCount++;
    }
  }
  const retained = [...items.values()].slice(0, COUNTY_DOCUMENT_LIMIT);
  return { items: retained, counts: { eventLimit: COUNTY_EVENT_LIMIT, documentLimit: COUNTY_DOCUMENT_LIMIT, returnedEventCount: envelope.value.length, selectedEventCount, scheduledNoticeCount, publishedDocumentCount,
    retainedDocumentCount: retained.length, nextPagePresent: !!envelope["@odata.nextLink"], documentLimitReached: publishedDocumentCount > retained.length, coverage: "bounded-provider-window", timeZoneEvidence: "unknown" } };
}
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
export async function acquireOfficialMeetingDocuments(source: { id: string; name: string; url: string }, options: OfficialMeetingOptions = {}): Promise<OfficialMeetingAcquisition> {
  const asOf = options.asOf ?? new Date().toISOString();
  if (!isStrictTimestamp(asOf)) throw new Error("Invalid official acquisition clock");
  return withinDeadline(async signal => {
    const fetchOptions = { ...options, signal, label: source.name, maxBytes: Math.min(options.maxBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024), timeoutMs: Math.min(options.timeoutMs ?? 15_000, 15_000), minIntervalMs: options.minIntervalMs ?? 1000, retry: false };
    const rawHtml = await boundedFetchText(source.url, source.id === "county-meetings" ? { ...fetchOptions, maxRedirects: 0 } : fetchOptions);
    if (source.id === "county-meetings") {
      if (source.url !== OFFICIAL_MEETING_SOURCES.find(row => row.id === "county-meetings")!.url) throw new Error("County source identity differs from the official registry landing page");
      const $ = load(rawHtml);
      const linked = $("a[href]").toArray().some(element => {
        try { const url = new URL($(element).attr("href")!, source.url); return !url.username && !url.password && !url.search && !url.hash && url.href === COUNTY_CIVICCLERK_PORTAL; } catch { return false; }
      });
      if (!linked) throw new Error("Official County page does not link the approved public agenda tenant");
      const day = pacificDay(new Date(asOf)), midnight = Date.parse(`${day}T00:00:00Z`);
      const windowStart = new Date(midnight - 30 * 86_400_000).toISOString().slice(0, 10);
      const windowEndExclusive = new Date(midnight + 30 * 86_400_000).toISOString().slice(0, 10);
      const endpoint = new URL(COUNTY_CIVICCLERK_API);
      endpoint.searchParams.set("$filter", `startDateTime ge ${windowStart}T00:00:00Z and startDateTime lt ${windowEndExclusive}T00:00:00Z`);
      endpoint.searchParams.set("$orderby", "startDateTime desc, eventName desc"); endpoint.searchParams.set("$top", String(COUNTY_EVENT_LIMIT));
      const rawBytes = await boundedFetchBytes(endpoint.href, { ...fetchOptions, maxRedirects: 0 });
      const rawJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBytes);
      const parsed = parseCountyMeetingEvents(JSON.parse(rawJson), windowStart, windowEndExclusive, asOf);
      const provider: CountyMeetingEvidence = { endpointUrl: endpoint.href, rawJson, rawSha256: custodyHash(rawBytes), windowStart, windowEndExclusive, ...parsed.counts };
      return { items: parsed.items, rawHtml, rawSha256: custodyHash(rawHtml), fetchedAt: new Date().toISOString(), parserVersion: "county-civicclerk-documents/v1", coverage: parsed.items.length ? "documents-discovered" : "recognized-empty", provider,
        limitations: ["One bounded County Board of Supervisors provider page; additional pages and archive completeness are not established", "Future and historical notice dates do not establish completed meetings; time zone semantics are unknown", "Published links are documents; PDF text, votes, adoption and legal effective dates require separate retained-byte review", "Raw upstream provider fields remain in the private acquisition receipt rather than public meeting items"] };
    }
    const items = parseOfficialMeetingDocuments(rawHtml, source);
    return { items, rawHtml, rawSha256: custodyHash(rawHtml), fetchedAt: new Date().toISOString(), parserVersion: "official-meeting-links/v2", coverage: items.length ? "documents-discovered" : "unrecognized-page",
      limitations: ["Document links are discovered records; PDF text, votes and effective dates are not inferred", "Unknown document dates remain blank", "Calendar pagination and completeness require separate source acceptance"] };
  }, Math.min(options.timeoutMs ?? 30_000, 60_000), options.signal);
}

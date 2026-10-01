/** Retained official PDF bytes and page-addressable text; no legal interpretation or OCR. */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedFetchBytes, type BoundedFetchOptions } from "./alerts/connector.js";
import { custodyHash } from "./corpus_editions.js";
import { paths } from "./shared/paths.js";
import { runBoundedChild } from "./shared/subprocess.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { withFileLease } from "./shared/storage.js";
import { isCountyMeetingFileUrl } from "./official_meetings.js";

export interface MeetingDocumentCandidate { title: string; url: string; meetingDate: string; source: string }
export interface DocumentPage { page: number; start: number; end: number; text: string; textSha256: string }
export interface MeetingDocumentReceipt {
  schemaVersion: "official-meeting-pdf/v1"; source: MeetingDocumentCandidate;
  captureId: string; receiptFile: string;
  fetchedAt: string; rawSha256: string; rawBytes: number; rawFile: string;
  extractor: { name: "pdftotext"; version: string; layout: true; ocrAttempted: false };
  textSha256: string; text: string; pages: DocumentPage[];
  limitations: string[];
}

/** Offsets address the exact normalized extracted text, never the PDF binary. */
export function documentPageSpans(extracted: string): { text: string; pages: DocumentPage[] } {
  if (extracted.length > 8 * 1024 * 1024 || extracted.includes("\0")) throw new Error("Invalid extracted document text");
  const pieces = extracted.replace(/\r\n?/g, "\n").split("\f");
  if (pieces.length > 1 && pieces.at(-1) === "") pieces.pop();
  if (pieces.length > 2000) throw new Error("Document page limit exceeded");
  let cursor = 0;
  const pages = pieces.map((text, index) => {
    const page = { page: index + 1, start: cursor, end: cursor + text.length, text, textSha256: custodyHash(text) };
    cursor = page.end + (index < pieces.length - 1 ? 1 : 0);
    return page;
  });
  return { text: pieces.join("\f"), pages };
}

export function isRetainablePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 32 || bytes.length > 8 * 1024 * 1024) return false;
  const head = new TextDecoder().decode(bytes.slice(0, 8));
  const tail = new TextDecoder().decode(bytes.slice(-2048));
  return /^%PDF-1\.[0-9]/.test(head) && /%%EOF\s*$/.test(tail);
}

export async function captureMeetingDocument(candidate: MeetingDocumentCandidate, options: {
  signal?: AbortSignal; extractor?: string; fetchOptions?: Partial<BoundedFetchOptions>;
} = {}): Promise<MeetingDocumentReceipt> {
  const url = new URL(candidate.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid official document URL");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
  const bytes = await boundedFetchBytes(candidate.url, { label: "Official meeting PDF", maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000, retry: false, minIntervalMs: 1000, ...options.fetchOptions, signal });
  if (!isRetainablePdf(bytes)) throw new Error("Source is not a complete supported PDF");
  const fetchedAt = new Date().toISOString(); const rawSha256 = custodyHash(bytes);
  const temporary = await mkdtemp(join(tmpdir(), "cci-meeting-pdf-"));
  try {
    const input = join(temporary, "source.pdf"); await writeFile(input, bytes, { mode: 0o600 });
    const extractor = options.extractor ?? "pdftotext";
    const version = await runBoundedChild([extractor, "-v"], { timeoutMs: 5000, maxBytes: 4096, signal });
    if (version.status !== "ok") throw new Error("pdftotext is unavailable");
    const result = await runBoundedChild([extractor, "-layout", "-enc", "UTF-8", input, "-"], { timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024, signal });
    if (result.status !== "ok" || !result.reaped) throw new Error("PDF extraction did not complete");
    const spans = documentPageSpans(result.stdout);
    const directory = join(paths.output, "meeting_documents", "raw"); await mkdir(directory, { recursive: true });
    const rawFile = `raw/${rawSha256}.pdf`; const destination = join(directory, `${rawSha256}.pdf`);
    const staged = join(directory, `.${rawSha256}.${crypto.randomUUID()}.tmp`);
    try { await writeFile(staged, bytes, { mode: 0o600 }); await rename(staged, destination); }
    finally { await rm(staged, { force: true }); }
    if (custodyHash(new Uint8Array(await readFile(destination))) !== rawSha256) throw new Error("Retained PDF identity mismatch");
    signal.throwIfAborted();
    const captureId = crypto.randomUUID();
    const receiptFile = `${rawSha256}-${custodyHash(candidate.url).slice(0, 16)}-${captureId}.json`;
    const receipt: MeetingDocumentReceipt = {
      schemaVersion: "official-meeting-pdf/v1", source: candidate, captureId, receiptFile, fetchedAt, rawSha256, rawBytes: bytes.length, rawFile,
      extractor: { name: "pdftotext", version: (version.stderr || version.stdout).split("\n")[0]!.slice(0, 160), layout: true, ocrAttempted: false },
      textSha256: custodyHash(spans.text), ...spans,
      limitations: ["Text extraction does not verify meeting decisions, votes or legal effective dates", "Scanned pages may have no extractable text; OCR was not attempted", "Page offsets address extracted text rather than PDF bytes"],
    };
    signal.throwIfAborted();
    await writeJsonAtomic(join(paths.output, "meeting_documents", receiptFile), receipt);
    return receipt;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Select declared agenda/minute links from one latest batch, with no portal crawling. */
export async function meetingDocumentCandidates(): Promise<MeetingDocumentCandidate[]> {
  let files: string[]; try { files = (await readdir(paths.govMeetings)).filter(file => /^gov_meetings-.*\.json$/.test(file)).sort(); } catch { return []; }
  if (!files.length) return [];
  const file = Bun.file(join(paths.govMeetings, files.at(-1)!)); if (file.size > 8 * 1024 * 1024) throw new Error("Meeting batch exceeds document-discovery limit");
  const batch: unknown = await file.json(); if (!batch || typeof batch !== "object" || !Array.isArray((batch as { items?: unknown }).items)) throw new Error("Invalid meeting batch");
  const found = new Map<string, MeetingDocumentCandidate>();
  for (const item of (batch as { items: unknown[] }).items.slice(0, 1000)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const links = [row.link, ...[row.agendaItems, row.minuteItems, row.agendaLinks, row.minuteLinks].flatMap(value => Array.isArray(value) ? value : [])];
    for (const link of links) {
      const candidate = typeof link === "string" ? link : link && typeof link === "object" && "url" in link ? (link as { url: unknown }).url : null;
      if (typeof candidate !== "string" || !/\.pdf(?:\?|$)/i.test(candidate) && !(row.sourceId === "county-meetings" && isCountyMeetingFileUrl(candidate))) continue;
      try { const url = new URL(candidate); if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue; } catch { continue; }
      found.set(candidate, { title: String(row.title ?? "Official meeting document").slice(0, 300), url: candidate, meetingDate: typeof row.date === "string" ? row.date : "", source: String(row.source ?? row.sourceId ?? "official-agency").slice(0, 160) });
    }
  }
  return [...found.values()].sort((a, b) => b.meetingDate.localeCompare(a.meetingDate) || a.url.localeCompare(b.url));
}

export async function captureMeetingDocuments(options: { limit?: number; deadlineMs?: number; signal?: AbortSignal } = {}) {
  const limit = options.limit ?? 10; const deadlineMs = options.deadlineMs ?? 300_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 900_000) throw new Error("Invalid document capture limits");
  const deadline = Date.now() + deadlineMs;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(deadlineMs)]) : AbortSignal.timeout(deadlineMs);
  return withFileLease(join(paths.state, "meeting-documents.lock"), async () => {
    signal.throwIfAborted();
    const candidates = await meetingDocumentCandidates();
    signal.throwIfAborted();
    const documents: Array<{ source: MeetingDocumentCandidate; status: "captured" | "unavailable"; rawSha256?: string; receiptFile?: string; pages?: number; emptyPages?: number; error?: string }> = [];
    for (const candidate of candidates.slice(0, limit)) {
      signal.throwIfAborted();
      try { const receipt = await captureMeetingDocument(candidate, { signal }); documents.push({ source: candidate, status: "captured", rawSha256: receipt.rawSha256, receiptFile: receipt.receiptFile, pages: receipt.pages.length, emptyPages: receipt.pages.filter(page => !page.text.trim()).length }); }
      catch (error) { signal.throwIfAborted(); documents.push({ source: candidate, status: "unavailable", error: error instanceof Error ? error.name : "AcquisitionError" }); }
    }
    signal.throwIfAborted();
    const receipt = { schemaVersion: "official-meeting-document-batch/v1", checkedAt: new Date().toISOString(), candidateCount: candidates.length, selectedCount: documents.length, capturedCount: documents.filter(document => document.status === "captured").length, coverage: "bounded-selected-documents", documents };
    await writeJsonAtomic(join(paths.state, "meeting-documents.json"), receipt);
    return receipt;
  }, { waitMs: Math.max(1, Math.min(5000, deadline - Date.now())) });
}

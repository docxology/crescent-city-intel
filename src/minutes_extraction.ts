#!/usr/bin/env bun
import { boundedHttpFetch, type TransportOptions } from "./shared/transport.js";
/**
 * Deterministic meeting-minutes extraction and document hash-drift reports.
 *
 * Three capabilities, all deterministic and testable without live network:
 *
 * 1. `extractVotes(minutesText)` — finds EVERY vote tally in a minutes document
 *    (the existing `parseVotes` in gov_meeting_monitor.ts returns only the first
 *    match). Text is scanned per block so a multi-item agenda yields one
 *    VoteResult per vote taken.
 * 2. `computeDocumentHashes` — SHA-256 per agenda/minutes document text.
 * 3. `diffDocumentHashes` — pure change detection: compare a previous hash map
 *    against the current one and report drift per URL. The result is written
 *    into the meeting report itself (`documentDrift` + `changedDocuments` in
 *    output/gov_meetings/*.json) as well as the gov-meetings source-health
 *    sidecar.
 *
 * Data honesty: nothing here invents dates or vote outcomes; a block with no
 * parseable vote yields no result, and a URL with no prior hash is `isNew`,
 * not "changed".
 */
import { computeSha256 } from "./utils.js";

export type { VoteResult } from "./gov_meeting_monitor.js";
import type { VoteResult } from "./gov_meeting_monitor.js";
import { parseVotes } from "./gov_meeting_monitor.js";

/**
 * Split minutes text into candidate blocks: paragraph breaks, numbered or
 * lettered item starts, and ALL-CAPS heading lines.
 *
 * The third alternative used to be `\n(?=[A-Z0-9])` — a split before *any*
 * line beginning with a capital or digit. That destroyed the one construct this
 * module exists to read: a roll call is a name per line
 *
 *     Roll call:
 *     Smith - Yea
 *     Jones - Nay
 *
 * so each name became its own block, `parseVotes` saw a single name per block
 * (below the 3-name threshold, and with no motion context to satisfy the
 * alternative path), and `extractVotes` returned [] for the item. It was also
 * format-fragile: indenting the identical roll call by two spaces defeated both
 * the capital-letter and numbered-item alternatives, so the same minutes parsed
 * or did not depending on whitespace. Headings are now matched as headings —
 * short, upper-case lines — not any capitalised line.
 */
function voteBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n|(?=\n\s*\(?[a-z0-9]+[\).]\s)|\n(?=[A-Z][A-Z0-9 ,.'()/-]{3,60}\n)/)
    .map(b => b.trim())
    .filter(b => b.length > 0);
}

/**
 * Extract every parseable vote from a minutes document, in document order.
 *
 * Collapsing is deliberately narrow: an identical tally is treated as the same
 * vote described twice only when the preceding block gives positive evidence of
 * duplication — it is a roll-call line ("Roll call: Alpha: Yea, Beta: Nay"
 * followed by "Vote: 2 yea, 1 nay"), or the two blocks are byte-identical.
 *
 * Adjacency plus an identical tally is NOT sufficient evidence. A consent
 * calendar's items 3a and 3b sit in adjacent blocks, separated only by a blank
 * line, and both tally 5-0 — each a genuinely separate vote. Collapsing on
 * adjacency alone deleted one of them, and a consent calendar routinely passes
 * item after item unanimously, so this class of loss was systematic.
 *
 * Never throws; returns [] for empty/unparseable input.
 */
export function extractVotes(minutesText: string): VoteResult[] {
  if (!minutesText || typeof minutesText !== "string") return [];
  const results: VoteResult[] = [];
  let previous: { vote: VoteResult; blockIndex: number } | null = null;
  const blocks = voteBlocks(minutesText);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!;
    const vote = parseVotes(block);
    if (!vote) continue;
    const previousBlock = previous !== null ? blocks[previous.blockIndex] ?? "" : "";
    const isDuplication = /\broll\s*call\b/i.test(previousBlock) || previousBlock === block;
    const restatesPrevious = previous !== null
      && blockIndex === previous.blockIndex + 1
      && isDuplication
      && previous.vote.yea === vote.yea
      && previous.vote.nay === vote.nay
      && previous.vote.abstain === vote.abstain
      && previous.vote.passed === vote.passed;
    if (!restatesPrevious) results.push(vote);
    // Either way this block is now the one an adjacent restatement follows.
    previous = { vote, blockIndex };
  }
  return results;
}

export type DocumentHashMap = Record<string, string>;

/**
 * SHA-256 per document. `docs` pairs a fetchable URL with its already-fetched
 * text; hashing is over the exact fetched text (trimmed) so the same bytes
 * always produce the same hash.
 */
export async function computeDocumentHashes(
  docs: Array<{ url: string; text: string }>,
): Promise<DocumentHashMap> {
  const hashes: DocumentHashMap = {};
  for (const doc of docs) {
    if (!doc?.url || typeof doc?.text !== "string") continue;
    hashes[doc.url] = await computeSha256(doc.text.trim());
  }
  return hashes;
}

export interface DocumentDrift {
  url: string;
  /** True only when a previous hash exists AND differs. First sighting is new, not changed. */
  changed: boolean;
  isNew: boolean;
  previousHash: string | null;
  currentHash: string;
}

/**
 * Pure change detection between the previously recorded hashes and the
 * current fetch. URLs present before but absent now are NOT reported as
 * changed (absence is not drift — the document may simply not have been
 * re-fetched this cycle).
 */
export function diffDocumentHashes(
  previous: DocumentHashMap | undefined | null,
  current: DocumentHashMap,
): DocumentDrift[] {
  const drift: DocumentDrift[] = [];
  for (const [url, currentHash] of Object.entries(current)) {
    const previousHash = previous?.[url] ?? null;
    drift.push({
      url,
      changed: previousHash !== null && previousHash !== currentHash,
      isNew: previousHash === null,
      previousHash,
      currentHash,
    });
  }
  return drift;
}

/** Content types whose bodies are text a vote parser can honestly read. */
const TEXTUAL_CONTENT_TYPES = [
  /^text\//i,
  /^application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml)\b/i,
];

/**
 * Whether a Content-Type header names a textual body.
 *
 * A missing or unrecognized type is NOT textual. Agenda packets are usually
 * PDFs, and `response.text()` on a PDF yields decoded binary that the vote
 * regexes will happily find numbers in — inventing tallies out of font tables.
 * Skipping an unverifiable document loses a document; parsing it invents data.
 */
export function isTextualContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim();
  return TEXTUAL_CONTENT_TYPES.some(pattern => pattern.test(type));
}

/**
 * Bounded fetch of one document's text; null on any failure, on a non-OK
 * status, or on a body that is not verifiably text (never throws).
 */
export async function fetchDocumentText(url: string, timeoutMs: number, transport: TransportOptions = {}): Promise<string | null> {
  try {
    const response = await boundedHttpFetch(url, {
      ...transport, maxBytes: 4 * 1024 * 1024,
      headers: { "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)" },
      signal: transport.signal ? AbortSignal.any([transport.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    if (!isTextualContentType(response.headers.get("content-type"))) return null;
    return await response.text();
  } catch {
    return null;
  }
}

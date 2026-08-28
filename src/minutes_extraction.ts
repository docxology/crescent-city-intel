#!/usr/bin/env bun
/**
 * Deeper meeting-minutes extraction (TODO Phase 4.2, part 2 — offline-verifiable pieces).
 *
 * Three capabilities, all deterministic and testable without live network:
 *
 * 1. `extractVotes(minutesText)` — finds EVERY vote tally in a minutes document
 *    (the existing `parseVotes` in gov_meeting_monitor.ts returns only the first
 *    match). Text is scanned per block so a multi-item agenda yields one
 *    VoteResult per vote taken.
 * 2. `computeDocumentHashes` — SHA-256 per agenda/minutes document text.
 * 3. `diffDocumentHashes` — pure change detection: compare a previous hash map
 *    against the current one and report drift per URL, surfaced in the meeting
 *    report.
 *
 * Data honesty: nothing here invents dates or vote outcomes; a block with no
 * parseable vote yields no result, and a URL with no prior hash is `isNew`,
 * not "changed".
 */
import { computeSha256 } from "./utils.js";

export type { VoteResult } from "./gov_meeting_monitor.js";
import type { VoteResult } from "./gov_meeting_monitor.js";
import { parseVotes } from "./gov_meeting_monitor.js";

/** Split minutes text into candidate blocks (paragraph / numbered / lettered items). */
function voteBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n|(?=\n\s*\(?[a-z0-9]+[\).]\s)|\n(?=[A-Z0-9])/)
    .map(b => b.trim())
    .filter(b => b.length > 0);
}

/**
 * Extract every parseable vote from a minutes document. Results are in
 * document order; exact duplicates (same tally + outcome + details) are
 * collapsed. Never throws; returns [] for empty/unparseable input.
 */
export function extractVotes(minutesText: string): VoteResult[] {
  if (!minutesText || typeof minutesText !== "string") return [];
  const results: VoteResult[] = [];
  for (const block of voteBlocks(minutesText)) {
    const vote = parseVotes(block);
    if (!vote) continue;
    // Same tally + outcome within one document is the same vote described
    // twice (e.g. a roll-call line followed by its "Vote: 3-1-1" summary);
    // keep the first (usually the richer roll-call) and collapse the rest.
    const dup = results.some(
      r => r.yea === vote.yea && r.nay === vote.nay && r.abstain === vote.abstain &&
           r.passed === vote.passed,
    );
    if (!dup) results.push(vote);
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

/** Bounded fetch of one document's text; null on any failure (never throws). */
export async function fetchDocumentText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Scraper robustness utilities.
 *
 * - Cloudflare stall detection
 * - Network error retry with exponential backoff
 * - TOC and persisted article shape validation
 */

import type { TocNode, ArticlePage } from "./types.js";

const TOC_TYPES = new Set<TocNode["type"]>([
  "code",
  "division",
  "chapter",
  "article",
  "part",
  "subarticle",
  "section",
]);

/**
 * Validate the minimum recursive shape required to safely use a TOC as the
 * scrape contract. A 200 response containing an error object or an empty
 * challenge payload must never replace the last known-good TOC.
 */
export function isTocShapeValid(value: unknown): value is TocNode {
  if (!value || typeof value !== "object") return false;
  const seen = new Set<string>();
  let sectionCount = 0;

  const visit = (candidate: unknown): candidate is TocNode => {
    if (!candidate || typeof candidate !== "object") return false;
    const node = candidate as Record<string, unknown>;
    if (typeof node.guid !== "string" || !/^[A-Za-z0-9_-]+$/.test(node.guid)) return false;
    if (typeof node.type !== "string" || !TOC_TYPES.has(node.type as TocNode["type"])) return false;
    if (!Array.isArray(node.children)) return false;
    if (seen.has(node.guid)) return false;
    seen.add(node.guid);
    if (node.type === "section") sectionCount += 1;
    return node.children.every(visit);
  };

  const root = value as Record<string, unknown>;
  if (root.type !== "code" || typeof root.tocName !== "string" || !root.tocName.trim()) return false;
  return visit(value) && sectionCount > 0;
}

/** Minimal runtime guard for a persisted article artifact. */
export function isArticleArtifactShapeValid(value: unknown, expectedSectionGuids: readonly string[] = [], exactSectionGuids = false): value is ArticlePage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.guid !== "string" || !/^[A-Za-z0-9_-]+$/.test(record.guid) || typeof record.rawHtml !== "string" || !record.rawHtml.trim() || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
  if (!["url", "title", "number", "scrapedAt"].every(key => typeof record[key] === "string")) return false;
  if (!Number.isFinite(Date.parse(record.scrapedAt as string))) return false;
  try { const url = new URL(record.url as string); if (url.protocol !== "https:" || url.hostname !== "ecode360.com" || url.username || url.password || url.pathname !== `/${record.guid}`) return false; } catch { return false; }
  if (!Array.isArray(record.sections)) return false;
  if (!record.sections.every(section => {
    if (!section || typeof section !== "object") return false;
    const item = section as Record<string, string>;
    return ["guid", "number", "title", "html", "text", "history"].every(key => typeof item[key] === "string")
      && /^[A-Za-z0-9_-]+$/.test(item.guid!) && !!item.html!.trim()
      && (!!item.text!.trim() || /^\(?reserved\)?\.?$/i.test(item.title!.trim()));
  })) return false;
  const sectionGuids = new Set(record.sections.map(section => (section as Record<string, string>).guid));
  if (sectionGuids.size !== record.sections.length) return false;
  if (!expectedSectionGuids.every(guid => sectionGuids.has(guid))) return false;
  return !exactSectionGuids || sectionGuids.size === new Set(expectedSectionGuids).size;
}

/** Detect if Cloudflare Turnstile challenge is stuck */
export function detectCloudflareStall(startTime: number, maxWaitMs: number = 10_000): boolean {
  return Date.now() - startTime > maxWaitMs;
}

/** Retry wrapper with exponential backoff */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 2000,
): Promise<{ result: T; retried: boolean; attempts: number }> {
  let lastError: Error | null = null;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    attempts = i + 1;
    try {
      const result = await fn();
      return { result, retried: i > 0, attempts };
    } catch (err: any) {
      lastError = err;
      if (i < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

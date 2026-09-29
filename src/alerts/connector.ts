/**
 * Bounded live-fetch connector for the five 2026-09-28 expansion monitors
 * (permits, dredging, fuel, pacfin, ais).
 *
 * Every live fetch these monitors make goes through `boundedFetchText`, which
 * enforces four connector bounds in one place:
 *
 *   1. TIMEOUT — the request is aborted after `timeoutMs`
 *                 (SOURCE_FETCH_TIMEOUT_MS by default, env-overridable).
 *   2. SIZE    — the body is streamed and rejected once it exceeds `maxBytes`,
 *                even when the server omits Content-Length.
 *   3. RATE    — per-host minimum interval between fetches, so repeated runs
 *                or a healer retry racing the batch cannot hammer a source.
 *   4. ROBOTS  — the host's robots.txt (bounded fetch, cached 24 h) is checked
 *                for `User-agent: *` Disallow rules; a disallowed path throws
 *                BoundedFetchError("robots") so the run records an honest
 *                unavailable-with-reason health state instead of scraping
 *                against a published content-use signal.
 *
 * Errors carry a stable `kind` (`timeout` | `size` | `robots` | `status` |
 * `network`) so source-health reporting and tests can assert the failure mode,
 * not just "it failed". The 2026-09-26/27 correctness doctrine applies
 * downstream: a dead or blocked source surfaces as a thrown error → the
 * monitor's `null` return → a degraded SourceHealth record. Nothing here
 * fabricates a plausible result.
 */
import { SOURCE_FETCH_TIMEOUT_MS } from "../shared/source_health.js";

export type FetchFailureKind = "timeout" | "size" | "robots" | "status" | "network";

export class BoundedFetchError extends Error {
  readonly kind: FetchFailureKind;
  readonly url: string;
  constructor(kind: FetchFailureKind, url: string, message: string) {
    super(message);
    this.name = "BoundedFetchError";
    this.kind = kind;
    this.url = url;
  }
}

export const CONNECTOR_USER_AGENT =
  "CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)";

export interface BoundedFetchOptions {
  label: string;
  maxBytes: number;
  timeoutMs?: number;
  /** Per-host minimum interval between fetches; defaults to the shared 5 s. */
  minIntervalMs?: number;
  headers?: Record<string, string>;
  retry?: boolean;
  skipRobots?: boolean;
}

const DEFAULT_MIN_INTERVAL_MS = 5_000;

const nextAllowedAt = new Map<string, number>();

export function setHostRateLimit(host: string, nextAllowedAtMs: number): void {
  nextAllowedAt.set(host, Math.max(nextAllowedAtMs, nextAllowedAt.get(host) ?? 0));
}

export function resetConnectorState(): void {
  nextAllowedAt.clear();
  robotsCache.clear();
}

async function awaitHostRateLimit(host: string, minIntervalMs: number): Promise<void> {
  const allowed = nextAllowedAt.get(host) ?? 0;
  const wait = allowed - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  nextAllowedAt.set(host, Date.now() + minIntervalMs);
}

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_MAX_BYTES = 256 * 1024;

interface RobotsDecision {
  allowed: boolean;
  reason?: string;
  checkedAt: number;
}

const robotsCache = new Map<string, RobotsDecision>();

/** Disallow test for the `User-agent: *` group of a robots.txt body: any matching Disallow denies. */
export function robotsAllowsPath(robotsTxt: string, path: string): { allowed: boolean; reason?: string } {
  let inStarBlock = false;
  let longestMatched = "";
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      inStarBlock = value === "*";
    } else if (inStarBlock && key === "disallow" && value && path.startsWith(value) && value.length > longestMatched.length) {
      longestMatched = value;
    }
  }
  if (longestMatched) {
    return { allowed: false, reason: `Disallow: ${longestMatched}` };
  }
  return { allowed: true };
}

async function checkRobots(url: URL): Promise<void> {
  const cached = robotsCache.get(url.host);
  if (cached && Date.now() - cached.checkedAt < ROBOTS_TTL_MS) {
    if (!cached.allowed) throw robotsError(url, cached.reason!);
    return;
  }
  let decision: RobotsDecision;
  try {
    const response = await fetch(`${url.protocol}//${url.host}/robots.txt`, {
      headers: { "User-Agent": CONNECTOR_USER_AGENT },
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      // A walled robots endpoint must not widen permissions by defaulting to allow.
      decision = { allowed: false, reason: `robots.txt unreachable (HTTP ${response.status})`, checkedAt: Date.now() };
    } else {
      const body = response.ok ? (await response.text()).slice(0, ROBOTS_MAX_BYTES) : "";
      const verdict = robotsAllowsPath(body, url.pathname);
      decision = { allowed: verdict.allowed, reason: verdict.reason, checkedAt: Date.now() };
    }
  } catch (err) {
    if (err instanceof BoundedFetchError) throw err;
    decision = { allowed: true, checkedAt: Date.now() };
  }
  robotsCache.set(url.host, decision);
  if (!decision.allowed) throw robotsError(url, decision.reason ?? "robots.txt disallows this path");
}

function robotsError(url: URL, reason: string): BoundedFetchError {
  return new BoundedFetchError(
    "robots",
    url.toString(),
    `${url.host} robots.txt disallows automated fetching of ${url.pathname} (${reason}) — source declined, not scraped`,
  );
}

/** Read the response body with an incremental cap that works without Content-Length. */
async function readBodyWithCap(response: Response, url: URL, label: string, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new BoundedFetchError("size", url.toString(), `${label} response exceeds the ${maxBytes}-byte size cap`);
    return text;
  }
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BoundedFetchError("size", url.toString(), `${label} response exceeds the ${maxBytes}-byte size cap`);
    }
  }
  return text;
}

async function boundedFetchOnce(url: string, options: BoundedFetchOptions): Promise<string> {
  const parsed = new URL(url);
  await awaitHostRateLimit(parsed.host, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  if (!options.skipRobots) await checkRobots(parsed);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": CONNECTOR_USER_AGENT,
        "Accept-Encoding": "gzip",
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind: FetchFailureKind = /abort|time\s?-?out|timed\s+out/i.test(message) ? "timeout" : "network";
    throw new BoundedFetchError(kind, url, `${options.label} fetch failed (${kind}): ${message}`);
  }
  if (!response.ok) {
    throw new BoundedFetchError("status", url, `${options.label} returned HTTP ${response.status}: ${response.statusText}`);
  }
  try {
    return await readBodyWithCap(response, parsed, options.label, options.maxBytes);
  } catch (err) {
    if (err instanceof BoundedFetchError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BoundedFetchError("network", url, `${options.label} body read failed: ${message}`);
  }
}

/**
 * Bounded live fetch: per-host rate limit → robots.txt gate → timeout-capped,
 * size-capped, once-retried GET. Every failure throws BoundedFetchError with a
 * stable `kind`; the caller (monitor run wrapper) converts it to null + a
 * recorded error so source health degrades honestly.
 */
export async function boundedFetchText(url: string, options: BoundedFetchOptions): Promise<string> {
  const attempts = options.retry === false ? 1 : 2;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const text = await boundedFetchOnce(url, options);
      if (!text.trim()) throw new BoundedFetchError("status", url, `${options.label} returned an empty body`);
      return text;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

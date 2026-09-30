/** API middleware: sliding-window rate limiting, multi-key auth, request logging.
 *
 * Rate limiting uses a **sliding window** algorithm: each IP stores a list of
 * request timestamps within the current window. Old timestamps are pruned on
 * every check, so the window truly slides rather than resetting in a block.
 */
import { createLogger } from "../logger.js";
import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isIP } from "node:net";
import { createHmac } from "node:crypto";
import { apiContract } from "./contracts.js";
import { outputRoot } from "../shared/paths.js";
import { writeJsonAtomic } from "../shared/source_health.js";
import { withFileLease } from "../shared/storage.js";
import { randomBytes } from "crypto";

const logger = createLogger("api-middleware");

// ─── Configuration ────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour sliding window
const RATE_LIMIT_MAX_REQUESTS = 100; // per IP per window

/** Exact operational probes have a separate, still bounded quota. */
const MAX_RATE_BUCKETS = 10_000;

// ─── API Key Store ────────────────────────────────────────────────

/** Per-boot generated credential used only when CRESCENT_CITY_API_KEY is unset. */
let generatedDefaultKey: string | null = null;
let VALID_API_KEYS = buildValidKeySet();

/**
 * Build the set of valid API keys. When `CRESCENT_CITY_API_KEY` is unset we
 * refuse to ship a well-known built-in secret (historically `dev-key-12345`):
 * any deployment that forgets the env var would otherwise authenticate with a
 * credential that is present in source and could be handed to every LAN node
 * via `getPrimaryApiKey()`. Instead we generate a random per-boot credential
 * and log a warning. The server injects it only into pages requested through
 * an actual loopback socket and loopback hostname, outside a configured proxy.
 */
function buildValidKeySet(): Set<string> {
  const raw = process.env.CRESCENT_CITY_API_KEY;
  if (raw && raw.trim() !== "") {
    return new Set(raw.split(",").map(k => k.trim()).filter(Boolean));
  }
  if (!generatedDefaultKey) {
    generatedDefaultKey = `boot-${randomBytes(24).toString("hex")}`;
    logger.warn(
      "CRESCENT_CITY_API_KEY is not set; generated a random per-boot API key. " +
        "Set CRESCENT_CITY_API_KEY in the environment for a stable credential."
    );
  }
  return new Set([generatedDefaultKey]);
}

/** Reload API keys from env (for hot-reload scenarios). */
export function reloadApiKeys(): void {
  VALID_API_KEYS = buildValidKeySet();
}

/**
 * The key used for the GUI's authenticated requests. server.ts injects it only
 * for a trusted loopback socket peer; a served page is not itself proof of
 * trust. External API callers supply their configured key in X-API-Key.
 */
export function getPrimaryApiKey(): string {
  return VALID_API_KEYS.values().next().value ?? "";
}

// ─── Sliding Window Store ─────────────────────────────────────────

/** Map of IP → sorted array of request timestamps within the current window. */
const rateLimitStore = new Map<string, number[]>();

/** Lifetime count of 429 responses returned (reset on process restart). */
let rateLimitBlockedCount = 0;

/** Clean up stale IP entries every 5 minutes to prevent unbounded memory growth.
 * Entries with only expired timestamps are removed entirely. */
setInterval(() => {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of rateLimitStore) {
    const active = timestamps.filter(t => t > cutoff);
    if (active.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, active);
    }
  }
}, 5 * 60 * 1000).unref();

/** Prune + count requests in the sliding window. Returns current count after pruning. */
function slidingWindowCount(ip: string, now: number): number {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitStore.get(ip) ?? []).filter(t => t > windowStart);
  if (timestamps.length < effectiveLimitForBucket(ip)) timestamps.push(now);
  else return timestamps.length + 1;
  rateLimitStore.set(ip, timestamps);
  return timestamps.length;
}

function effectiveLimitForBucket(bucket: string): number { return bucket.startsWith("probe:") ? 1000 : bucket.startsWith("chat:") ? 20 : bucket.startsWith("vector:") ? 10 : RATE_LIMIT_MAX_REQUESTS; }

/** Seconds until the oldest request in the window expires. */
function retryAfterSeconds(ip: string, now: number): number {
  const timestamps = rateLimitStore.get(ip) ?? [];
  if (timestamps.length === 0) return 0;
  const oldest = timestamps[0];
  return Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
}

// ─── Request log ─────────────────────────────────────────────────

const requestLogSalt = randomBytes(32);
const MAX_LOG_RECORDS = 1000;
function safeContract(path: string, method: string) { try { return apiContract(path, method); } catch { return null; } }
async function logRequest(method: string, path: string, ip: string, status: number, ms: number): Promise<void> {
  const file = join(outputRoot(), "state", "request-log.json");
  const entry = { ts: new Date().toISOString(), method, route: safeContract(path, method)?.path ?? "unknown", client: createHmac("sha256", requestLogSalt).update(ip).digest("hex").slice(0, 16), status, ms };
  try {
    await mkdir(dirname(file), { recursive: true });
    await withFileLease(`${file}.lock`, async () => {
      const records = await readFile(file, "utf8").then(raw => JSON.parse(raw)).catch(() => []);
      const recent = Array.isArray(records) ? records.filter(item => Number.isFinite(Date.parse(item?.ts)) && Date.now() - Date.parse(item.ts) < 7 * 86400000) : [];
      await writeJsonAtomic(file, [...recent, entry].slice(-MAX_LOG_RECORDS));
    });
  } catch { /* Logging does not change the response. No query, body, key or raw IP is retained. */ }
}

/**
 * Record one request-log entry with its REAL HTTP status and wall-clock
 * duration. The logging middleware cannot know the status (it runs before the
 * route handler), so it previously wrote a hardcoded 0 every time — every
 * entry in request-log.jsonl claimed status 0. The server now calls this after
 * it has the actual Response (middleware short-circuit OR handled route) so the
 * log is honest: status reflects the real code and ms reflects the full round
 * trip through the (possibly gzipped) response.
 */
export function recordRequestLog(
  method: string,
  path: string,
  ip: string,
  status: number,
  ms: number
): void {
  void logRequest(method, path, ip, status, ms);
}

// ─── Middleware functions ─────────────────────────────────────────

/**
 * Resolve the socket peer. Forwarded headers are accepted only from an exact
 * explicitly configured proxy IP. A local peer remains subject to quotas.
 */
export function resolveIp(req: Request, socketIp?: string): string {
  const peer = normalizeIp(socketIp ?? "");
  if (isTrustedProxyPeer(peer)) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip")?.trim() ?? "";
    const value = normalizeIp(forwarded);
    if (isIP(value)) return value;
  }
  return isIP(peer) ? peer : "unknown";
}
function normalizeIp(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  // WHATWG URL canonicalizes valid IPv6 case, compression and embedded IPv4.
  let canonical: string;
  try { canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1); }
  catch { return ""; } // Scoped/unsupported literals cannot establish proxy trust.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
/** One normalized proxy identity policy for forwarded headers and HTML credentials. */
export function isTrustedProxyPeer(socketIp?: string): boolean {
  const peer = normalizeIp(socketIp ?? "");
  return !!isIP(peer) && (process.env.CRESCENT_TRUSTED_PROXY_IPS ?? "").split(",")
    .map(ip => normalizeIp(ip.trim())).some(ip => !!isIP(ip) && ip === peer);
}
/** Only an actual loopback socket may receive the local GUI credential. */
export function isTrustedLocalIp(ip: string): boolean {
  const value = normalizeIp(ip);
  return value === "::1" || (isIP(value) === 4 && value.split(".")[0] === "127");
}

/** Rate limiting with sliding window algorithm. */
export function rateLimitMiddleware() {
  return async (req: Request, socketIp?: string): Promise<Response | null> => {
    const path = new URL(req.url).pathname;

    const ip = resolveIp(req, socketIp);
    const bucket = ["/api/health", "/api/monitor/status", "/api/openapi.yaml"].includes(path) ? "probe"
      : /^\/api\/(chat|summarize)(?:\/|$)/.test(path) ? "chat"
        : path === "/api/analytics/embeddings" || path === "/api/search/semantic" ? "vector" : "public";
    const key = `${bucket}:${ip}`;
    if (!rateLimitStore.has(key) && rateLimitStore.size >= MAX_RATE_BUCKETS) return Response.json({ error: "Request capacity is busy" }, { status: 503, headers: { "Retry-After": "60" } });

    const now = _getNow();
    const limit = effectiveLimitForBucket(key);
    const count = slidingWindowCount(key, now);
    const remaining = Math.max(0, limit - count);

    if (count > limit) {
      rateLimitBlockedCount += 1;
      const retryAfter = retryAfterSeconds(key, now);
      logger.warn("Rate limit exceeded", { route: safeContract(path, req.method)?.path ?? "unknown", count, limit, retryAfter });
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          message: `Too many requests. Try again in ${retryAfter} seconds.`,
          limit,
          remaining: 0,
          retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": "0",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Attach rate-limit headers for use in route handlers via a custom request header
    // (We can't mutate the original Request, so we signal via a sentinel value)
    req.headers.set?.("x-ratelimit-remaining", String(remaining));
    return null;
  };
}

/** API key authentication middleware. */
export function apiKeyMiddleware() {
  return async (req: Request, _socketIp?: string): Promise<Response | null> => {
    const path = new URL(req.url).pathname;
    let contract;
    try { contract = apiContract(path, req.method); } catch { return Response.json({ error: "Invalid encoded path" }, { status: 400 }); }
    if (!contract) return Response.json({ error: "Not found" }, { status: 404 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Allow": [...contract.methods, "OPTIONS"].join(", "), "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": contract.methods.join(", "), "Access-Control-Allow-Headers": "Content-Type, X-API-Key" } });
    if (!contract.methods.includes(req.method)) return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: contract.methods.join(", ") } });
    if (contract.public) return null;

    // Header-only auth. The prior `?api_key=` query-parameter fallback leaked
    // credentials into proxy/access logs and browser history, so it is no
    // longer accepted (header-only is also what the GUI's apiFetch() sends).
    const apiKey = req.headers.get("x-api-key");

    if (!apiKey) {
      logger.warn(`Missing API key for ${path}`);
      return new Response(
        JSON.stringify({ error: "API key required", message: "Provide key via the X-API-Key header" }),
        { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    if (!VALID_API_KEYS.has(apiKey)) {
      logger.warn("Invalid API key attempt");
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    logger.debug(`Valid API key used for ${path}`);
    return null;
  };
}

/** Request logging middleware — logs method, path, IP. */
export function requestLoggingMiddleware() {
  return async (req: Request, socketIp?: string): Promise<Response | null> => {
    const url = new URL(req.url);
    const method = req.method;
    logger.debug("API request", { method, route: safeContract(url.pathname, method)?.path ?? "unknown" });

    // The JSONL request-log entry is written by the server (recordRequestLog)
    // once the real Response exists, so it carries an honest status instead of
    // this middleware's fixed 0. Console logging stays here for live visibility.
    return null;
  };
}

/**
 * Apply all middleware in order.
 * Returns a Response if any middleware short-circuits (rate limit / auth),
 * or null to continue to the route handler.
 */
export async function applyMiddleware(req: Request, socketIp?: string): Promise<Response | null> {
  for (const fn of [requestLoggingMiddleware, rateLimitMiddleware, apiKeyMiddleware]) {
    const result = await fn()(req, socketIp);
    if (result !== null) return result;
  }
  return null;
}

// ─── Test hooks (exported for deterministic unit testing only) ────

/**
 * Override the clock used for rate-limit timestamps.
 * Test suites needing deterministic window exhaustion should use
 * `_testHooks.setNow()` before calling `rateLimitMiddleware()`;
 * the rate limiter reads this clock instead of `Date.now()`.
 */
let _injectedNow: number | null = null;

/** Internal clock used by middleware. Exported so tests can swap it. */
export function _getNow(): number {
  return _injectedNow ?? Date.now();
}

/**
 * Live rate-limiter diagnostics for /api/health and operational dashboards.
 * `peakUsage` is the largest per-IP window count currently tracked;
 * `blocked` counts 429s returned since process start.
 */
export interface RateLimitStats {
  trackedIps: number;
  peakUsage: number;
  blocked: number;
}

export function getRateLimitStats(): RateLimitStats {
  let peakUsage = 0;
  for (const timestamps of rateLimitStore.values()) {
    if (timestamps.length > peakUsage) peakUsage = timestamps.length;
  }
  return { trackedIps: rateLimitStore.size, peakUsage, blocked: rateLimitBlockedCount };
}

export const _testHooks = {
  /** Reset the blocked-429 counter (test isolation). */
  resetBlockedCount(): void { rateLimitBlockedCount = 0; },
  /** Override the clock used for rate-limit timestamps */
  setNow(ts: number): void { _injectedNow = ts; },
  /** Clear clock override — use real Date.now() again */
  clearNow(): void { _injectedNow = null; },
  /** Reset all per-IP window state */
  resetAll(): void { rateLimitStore.clear(); },
  /** Return the default public rate limit */
  getPublicLimit(): number { return RATE_LIMIT_MAX_REQUESTS; },
  /** Return the window duration in ms */
  getWindowMs(): number { return RATE_LIMIT_WINDOW_MS; },
} as const;

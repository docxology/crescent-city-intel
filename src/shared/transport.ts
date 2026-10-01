/** Bounded outbound HTTP with validated, pinned DNS addresses and explicit fixture policy. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";

export interface TransportScope {
  signal?: AbortSignal;
  /** Explicit local acceptance only. Every original origin must be named. */
  fixture?: { origin: string; allowedOrigins: readonly string[] };
}
const transportScopes = new AsyncLocalStorage<TransportScope>();
export function withTransportScope<T>(scope: TransportScope, task: () => T): T {
  const parent = transportScopes.getStore();
  const signal = parent?.signal && scope.signal ? AbortSignal.any([parent.signal, scope.signal]) : scope.signal ?? parent?.signal;
  if (scope.fixture) {
    const origin = new URL(scope.fixture.origin);
    if (!["http:", "https:"].includes(origin.protocol) || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.origin !== scope.fixture.origin || !scope.fixture.allowedOrigins.length) throw new Error("Transport fixtures require one explicit loopback origin and original-origin roster");
    for (const value of scope.fixture.allowedOrigins) { const source = new URL(value); if (!["http:", "https:"].includes(source.protocol) || source.origin !== value || source.username || source.password) throw new Error("Invalid transport fixture original origin"); }
  }
  return transportScopes.run({ ...parent, ...scope, fixture: scope.fixture ?? parent?.fixture, signal }, task);
}
export function currentTransportSignal(): AbortSignal | undefined { return transportScopes.getStore()?.signal; }
/** Browser-only fixture projection shares the exact allowlisted origin policy. */
export function fixtureDestination(value: string): string {
  const fixture = transportScopes.getStore()?.fixture; if (!fixture) return value;
  const source = new URL(value);
  if (source.username || source.password || hasCredentialFragment(source) || !fixture.allowedOrigins.includes(source.origin)) throw new TransportError("destination", redactUrl(value), "Browser request outside explicit fixture roster");
  return new URL(source.pathname + source.search, fixture.origin).toString();
}

export type TransportFailure = "timeout" | "size" | "destination" | "redirect" | "network" | "status";
export class TransportError extends Error {
  constructor(readonly kind: TransportFailure, readonly url: string, message: string) {
    super(message); this.name = "TransportError";
  }
}
export interface TransportOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  headers?: HeadersInit;
  method?: "GET" | "POST";
  body?: string | Uint8Array;
  /** Exact hostnames accepted for private-address fixtures. Never inferred from NODE_ENV. */
  allowPrivateHosts?: readonly string[];
  /** Called for every redirect destination, before its request. */
  beforeRequest?: (url: URL, signal: AbortSignal) => Promise<void>;
  resolver?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value); url.username = ""; url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (credentialParameter(name)) url.searchParams.set(name, "[redacted]");
    }
    if (hasCredentialFragment(url)) url.hash = "[redacted]";
    return url.toString();
  } catch { return "[invalid URL]"; }
}

/** OAuth/router fragment credentials never identify a public source section. */
function hasCredentialFragment(url: URL): boolean {
  let fragment = url.hash.slice(1);
  try { fragment = decodeURIComponent(fragment); } catch { /* preserve malformed fragments for validation */ }
  return [...fragment.matchAll(/(?:^|[?&;])([^=&;?]+)=/g)].some(match => credentialParameter(match[1]!));
}
function credentialParameter(name: string): boolean { return /key|token|secret|password|authorization|signature|credential/i.test(name) || /^(?:auth|sig|bearer|jwt)$/i.test(name); }

export function isPublicAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
      || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    if (address.startsWith("::ffff:")) {
      const suffix = address.slice(7);
      if (suffix.includes(".")) return isPublicAddress(suffix);
      const parts = suffix.split(":");
      if (parts.length === 2) {
        const n = (parseInt(parts[0], 16) * 65536) + parseInt(parts[1], 16);
        return isPublicAddress([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join("."));
      }
      return false;
    }
    // Global-unicast only: reject loopback, unspecified, ULA, multicast,
    // link-local and IPv4-compatible/tunnel encodings rather than guessing.
    return /^[23][0-9a-f]{3}:/.test(address) && !address.startsWith("2001:db8:") && !address.startsWith("2002:");
  }
  return false;
}

export async function validateDestination(value: string | URL, options: TransportOptions = {}): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new TransportError("destination", "[invalid URL]", "Invalid outbound URL"); }
  const safe = redactUrl(url.toString());
  if (hasCredentialFragment(url)) throw new TransportError("destination", safe, "Credential-bearing URL fragments are not public source destinations");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new TransportError("destination", safe, "Outbound URL must use HTTP(S) without credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await (options.resolver ?? (host => lookup(host, { all: true })))(hostname);
  const fixture = options.allowPrivateHosts?.includes(hostname) === true;
  if (records.length === 0 || records.some(record => ![4, 6].includes(record.family) || !isIP(record.address) || !fixture && !isPublicAddress(record.address))) {
    throw new TransportError("destination", safe, "Outbound destination resolves to a disallowed address");
  }
  records.sort((a, b) => a.family - b.family);
  return { url, ...records[0] };
}

export function throwIfAborted(signal: AbortSignal, url = "[operation]"): void {
  if (signal.aborted) throw new TransportError("timeout", redactUrl(url), "Operation cancelled or deadline exceeded");
}

export async function withinDeadline<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("A positive finite timeout is required");
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("Deadline exceeded")), timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(new TransportError("timeout", "[operation]", "Operation cancelled or deadline exceeded"));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) { abort(); return; }
      task(controller.signal).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    });
  } finally { clearTimeout(timer); parent?.removeEventListener("abort", cancel); }
}

export async function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new TransportError("timeout", "[rate wait]", "Rate wait cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestPinned(destination: Awaited<ReturnType<typeof validateDestination>>, options: TransportOptions, signal: AbortSignal): Promise<Response> {
  const { url, address, family } = destination;
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    headers["accept-encoding"] ??= "identity";
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers, signal, method: options.method ?? "GET",
      lookup: (_hostname, opts, callback) => {
        if (typeof opts === "object" && "all" in opts && opts.all) {
          (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
        } else callback(null, address, family);
      },
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0; let wireBytes = 0;
      const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
      const encoding = response.headers["content-encoding"];
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
      const body = decoder ? response.pipe(decoder) : response;
      const oversized = () => {
        const error = new TransportError("size", redactUrl(url.toString()), `Response exceeds the ${maxBytes}-byte size cap`);
        response.destroy(error); decoder?.destroy(error); request.destroy(error); reject(error);
      };
      response.on("data", (chunk: Buffer) => { wireBytes += chunk.byteLength; if (wireBytes > maxBytes) oversized(); });
      body.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) oversized();
        else chunks.push(chunk);
      });
      response.on("error", reject);
      body.on("error", reject);
      body.on("end", () => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        if (decoder) { resultHeaders.delete("content-encoding"); resultHeaders.delete("content-length"); }
        const status = response.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, statusText: response.statusMessage, headers: resultHeaders }));
      });
    });
    request.on("error", reject); request.end(options.body);
  });
}

/** Total deadline includes DNS, destination policy, redirects and complete body. */
export function redirectHeaders(from: URL, to: URL, input: HeadersInit): Headers {
  if (from.protocol === "https:" && to.protocol === "http:") throw new TransportError("redirect", redactUrl(from.toString()), "HTTPS redirect downgrade denied");
  const headers = new Headers(input);
  if (to.origin !== from.origin) for (const name of [...headers.keys()]) if (/authorization|cookie|api[-_]?key|token|secret|credential/i.test(name)) headers.delete(name);
  return headers;
}
export async function boundedHttpFetch(value: string, options: TransportOptions = {}): Promise<Response> {
  const originalValue = value;
  const scope = transportScopes.getStore();
  const signal = scope?.signal && options.signal ? AbortSignal.any([scope.signal, options.signal]) : options.signal ?? scope?.signal;
  options = { ...options, signal };
  if (scope?.fixture) {
    const original = new URL(value), fixture = new URL(scope.fixture.origin);
    if (original.username || original.password || hasCredentialFragment(original) || !scope.fixture.allowedOrigins.includes(original.origin)) throw new TransportError("destination", redactUrl(value), "Request outside explicit fixture source roster or credential policy");
    value = new URL(original.pathname + original.search, fixture).toString();
    options = { ...options, allowPrivateHosts: [fixture.hostname.replace(/^\[|\]$/g, "")], maxRedirects: 0 };
  }
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (options.method !== undefined && !["GET", "POST"].includes(options.method) || options.body !== undefined && (options.method !== "POST" || Buffer.byteLength(options.body) > 16_000)) throw new Error("Invalid bounded request method/body");
  return withinDeadline(async signal => {
    let current = value;
    let headers = new Headers(options.headers);
    for (let redirects = 0; ; redirects++) {
      throwIfAborted(signal, current);
      const destination = await validateDestination(current, options);
      throwIfAborted(signal, current);
      await options.beforeRequest?.(scope?.fixture ? new URL(originalValue) : destination.url, signal);
      let response: Response;
      try { response = await requestPinned(destination, { ...options, headers: Object.fromEntries(headers) }, signal); }
      catch (error) {
        if (error instanceof TransportError) throw error;
        throwIfAborted(signal, current);
        throw new TransportError("network", redactUrl(current), "Outbound request failed");
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (options.method === "POST") throw new TransportError("redirect", redactUrl(current), "POST redirects are denied");
      const location = response.headers.get("location");
      if (!location || redirects >= (options.maxRedirects ?? 5)) throw new TransportError("redirect", redactUrl(current), "Invalid or excessive redirects");
      const next = new URL(location, destination.url);
      headers = redirectHeaders(destination.url, next, headers);
      current = next.toString();
    }
  }, options.timeoutMs ?? 15_000, options.signal);
}

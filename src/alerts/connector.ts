/** Robots-aware, path-specific acquisition policy over the shared bounded transport. */
import { SOURCE_FETCH_TIMEOUT_MS } from '../shared/source_health.js';
import { boundedHttpFetch, redactUrl, TransportError, waitWithSignal, withinDeadline, type TransportOptions } from '../shared/transport.js';

export type FetchFailureKind = 'timeout' | 'size' | 'robots' | 'status' | 'network' | 'destination' | 'redirect';
export class BoundedFetchError extends Error {
  constructor(readonly kind: FetchFailureKind, readonly url: string, message: string) { super(message); this.name = 'BoundedFetchError'; }
}
export const CONNECTOR_USER_AGENT = 'CrescentCityIntelligenceSystem/1.0 (github.com/docxology/crescent-city-intel)';
export interface BoundedFetchOptions extends TransportOptions {
  label: string; maxBytes: number; minIntervalMs?: number; retry?: boolean; skipRobots?: boolean; robotsTtlMs?: number;
}
const nextAllowedAt = new Map<string, number>();
const robotsCache = new Map<string, { body: string; denied?: string; checkedAt: number }>();
export function setHostRateLimit(host: string, time: number): void { nextAllowedAt.set(host, Math.max(time, nextAllowedAt.get(host) ?? 0)); }
export function resetConnectorState(): void { nextAllowedAt.clear(); robotsCache.clear(); }
async function reserveHost(host: string, interval: number, signal: AbortSignal): Promise<void> {
  const reserved = Math.max(Date.now(), nextAllowedAt.get(host) ?? 0);
  nextAllowedAt.set(host, reserved + Math.max(0, interval));
  await waitWithSignal(reserved - Date.now(), signal);
}

/** Most specific user-agent group; longest matching path; Allow wins ties. */
export function robotsAllowsPath(body: string, path: string, userAgent = CONNECTOR_USER_AGENT): { allowed: boolean; reason?: string } {
  if (/<!doctype\s+html|<html[\s>]/i.test(body)) return { allowed: false, reason: 'robots endpoint returned HTML' };
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let group: typeof groups[number] | null = null; let hasRules = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); const colon = line.indexOf(':'); if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!group || hasRules) { group = { agents: [], rules: [] }; groups.push(group); hasRules = false; }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(key)) {
      hasRules = true; if (value) group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const agent = userAgent.toLowerCase();
  const score = (g: typeof groups[number]) => Math.max(-1, ...g.agents.map(a => a === '*' ? 0 : agent.includes(a) ? a.length : -1));
  const specificity = Math.max(-1, ...groups.map(score));
  let best: { allow: boolean; path: string; length: number } | null = null;
  for (const g of groups.filter(g => score(g) === specificity && specificity >= 0)) for (const rule of g.rules) {
    const end = rule.path.endsWith('$');
    const pattern = rule.path.replace(/\$$/, '').split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (!new RegExp('^' + pattern + (end ? '$' : '')).test(path)) continue;
    const length = rule.path.replace(/[\*$]/g, '').length;
    if (!best || length > best.length || length === best.length && rule.allow) best = { ...rule, length };
  }
  return best && !best.allow ? { allowed: false, reason: 'Disallow: ' + best.path } : { allowed: true };
}

async function checkRobots(url: URL, options: BoundedFetchOptions, signal: AbortSignal): Promise<void> {
  let policy = robotsCache.get(url.origin);
  if (!policy || Date.now() - policy.checkedAt >= (options.robotsTtlMs ?? 86400000)) {
    await reserveHost(url.host, options.minIntervalMs ?? 5000, signal);
    try {
      const response = await boundedHttpFetch(url.origin + '/robots.txt', {
        ...options, signal, maxBytes: 256 * 1024, maxRedirects: 0, beforeRequest: undefined,
        headers: { 'User-Agent': CONNECTOR_USER_AGENT },
      });
      if (response.status === 404 || response.status === 410) policy = { body: '', checkedAt: Date.now() };
      else if (!response.ok) policy = { body: '', denied: 'robots.txt returned HTTP ' + response.status, checkedAt: Date.now() };
      else policy = { body: await response.text(), checkedAt: Date.now() };
    } catch (error) {
      if (error instanceof TransportError && ['timeout', 'size', 'destination'].includes(error.kind)) throw error;
      policy = { body: '', denied: 'robots.txt could not be checked', checkedAt: Date.now() };
    }
    robotsCache.set(url.origin, policy);
  }
  const verdict = policy.denied ? { allowed: false, reason: policy.denied } : robotsAllowsPath(policy.body, url.pathname + url.search);
  if (!verdict.allowed) throw new BoundedFetchError('robots', redactUrl(url.toString()), 'Source policy declined acquisition: ' + verdict.reason);
}

export async function boundedFetchBytes(url: string, options: BoundedFetchOptions): Promise<Uint8Array> {
  try {
    return await withinDeadline(async signal => {
      const attempts = options.retry === false ? 1 : 2; let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const response = await boundedHttpFetch(url, {
            ...options, signal,
            headers: { 'User-Agent': CONNECTOR_USER_AGENT, ...Object.fromEntries(new Headers(options.headers).entries()) },
            beforeRequest: async destination => {
              if (!options.skipRobots) await checkRobots(destination, options, signal);
              await reserveHost(destination.host, options.minIntervalMs ?? 5000, signal);
              await options.beforeRequest?.(destination, signal);
            },
          });
          if (!response.ok) throw new BoundedFetchError('status', redactUrl(url), options.label + ' returned HTTP ' + response.status);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (!bytes.length) throw new BoundedFetchError('status', redactUrl(url), options.label + ' returned an empty body');
          return bytes;
        } catch (error) {
          lastError = error;
          if (error instanceof BoundedFetchError && error.kind === 'robots' || error instanceof TransportError && ['destination', 'size', 'redirect'].includes(error.kind)) throw error;
        }
      }
      throw lastError;
    }, options.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS, options.signal);
  } catch (error) {
    if (error instanceof BoundedFetchError) throw error;
    if (error instanceof TransportError) throw new BoundedFetchError(error.kind, redactUrl(url), error.message);
    throw new BoundedFetchError('network', redactUrl(url), options.label + ' acquisition failed');
  }
}
export async function boundedFetchText(url: string, options: BoundedFetchOptions): Promise<string> {
  const bytes = await boundedFetchBytes(url, options);
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) throw new BoundedFetchError('status', redactUrl(url), options.label + ' returned an empty body');
  return text;
}

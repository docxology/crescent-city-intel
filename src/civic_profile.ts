/** Public, immutable jurisdiction configuration. Regional adapters remain explicit capabilities. */
import { AsyncLocalStorage } from "node:async_hooks";
import { openSync, closeSync, fstatSync, readSync, constants as fsConstants } from "node:fs";

export interface CivicProfile {
  schemaVersion: "civic-profile/v1";
  id: string; name: string; municipality: string; county: string; state: string; countryCode: string;
  timeZone: string;
  anchor: { latitude: number; longitude: number; bounds: { west: number; south: number; east: number; north: number } };
  code: { provider: "ecode360"; municipalityCode: string } | null;
  corpusSlug: string; vectorNamespace: string;
  calendar: { uidDomain: string; productId: string };
  publication: { title: string; description: string; siteUrl: string; repositoryUrl: string };
  capabilities: string[];
}
const context = new AsyncLocalStorage<CivicProfile>();
const admittedProfiles = new WeakSet<object>();
const fingerprints = new WeakMap<object, string>();
function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error(`Invalid ${label} fields`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, limit = 200): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function token(value: unknown, label: string): string {
  const result = text(value, label, 63);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`Invalid ${label}`);
  return result;
}
function coordinate(value: unknown, limit: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) throw new Error("Invalid civic coordinate");
  return value;
}
function publicUrl(value: unknown, label: string, site = false): string {
  const result = text(value, label, 2048); let url: URL;
  try { url = new URL(result); } catch { throw new Error(`Invalid ${label}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || /[<>"'\\]/.test(result) || url.hostname === "localhost" || /^\d+(?:\.\d+){3}$/.test(url.hostname)) throw new Error(`Invalid public ${label}`);
  if (site && (url.pathname !== "/" || result.endsWith("/"))) throw new Error("Publication siteUrl must be an HTTPS origin without a trailing slash; subpath hosting is not yet supported");
  return result;
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
/** Strict allowlist prevents local paths, credentials and unrelated configuration entering public receipts. */
export function validateCivicProfile(value: unknown): CivicProfile {
  if (value && typeof value === "object" && admittedProfiles.has(value)) return value as CivicProfile;
  const p = record(value, ["schemaVersion", "id", "name", "municipality", "county", "state", "countryCode", "timeZone", "anchor", "code", "corpusSlug", "vectorNamespace", "calendar", "publication", "capabilities"], "civic profile");
  if (p.schemaVersion !== "civic-profile/v1") throw new Error("Unsupported civic profile schema");
  const anchor = record(p.anchor, ["latitude", "longitude", "bounds"], "anchor");
  const bounds = record(anchor.bounds, ["west", "south", "east", "north"], "bounds");
  const latitude = coordinate(anchor.latitude, 90), longitude = coordinate(anchor.longitude, 180);
  const west = coordinate(bounds.west, 180), east = coordinate(bounds.east, 180), south = coordinate(bounds.south, 90), north = coordinate(bounds.north, 90);
  if (west >= east || south >= north || longitude < west || longitude > east || latitude < south || latitude > north) throw new Error("Civic anchor must lie within ordered bounds; antimeridian extents require a separate adapter");
  const timeZone = text(p.timeZone, "timeZone", 100);
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw new Error("Invalid civic IANA timezone"); }
  const calendar = record(p.calendar, ["uidDomain", "productId"], "calendar"), publication = record(p.publication, ["title", "description", "siteUrl", "repositoryUrl"], "publication");
  const uidDomain = text(calendar.uidDomain, "calendar uidDomain", 100);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(uidDomain)) throw new Error("Invalid calendar UID namespace");
  let code: CivicProfile["code"] = null;
  if (p.code !== null) { const c = record(p.code, ["provider", "municipalityCode"], "code provider"); if (c.provider !== "ecode360" || typeof c.municipalityCode !== "string" || !/^[A-Z]{2}\d{4}$/.test(c.municipalityCode)) throw new Error("Unsupported municipal code provider identity"); code = { provider: "ecode360", municipalityCode: c.municipalityCode }; }
  if (typeof p.countryCode !== "string" || !/^[A-Z]{2}$/.test(p.countryCode)) throw new Error("Invalid countryCode");
  const allowed = new Set(["ecode360", "news", "events", "analytics", "geo", "crescent-city-adapters"]);
  if (!Array.isArray(p.capabilities) || p.capabilities.length > allowed.size || p.capabilities.some(c => typeof c !== "string" || !allowed.has(c)) || new Set(p.capabilities).size !== p.capabilities.length || p.capabilities.includes("ecode360") !== (code !== null)) throw new Error("Invalid civic capability roster");
  const result: CivicProfile = { schemaVersion: "civic-profile/v1", id: token(p.id, "id"), name: text(p.name, "name"), municipality: text(p.municipality, "municipality"), county: text(p.county, "county"), state: text(p.state, "state"), countryCode: p.countryCode, timeZone, anchor: { latitude, longitude, bounds: { west, south, east, north } }, code, corpusSlug: token(p.corpusSlug, "corpusSlug"), vectorNamespace: token(p.vectorNamespace, "vectorNamespace"), calendar: { uidDomain, productId: text(calendar.productId, "calendar productId") }, publication: { title: text(publication.title, "publication title"), description: text(publication.description, "publication description", 500), siteUrl: publicUrl(publication.siteUrl, "siteUrl", true), repositoryUrl: publicUrl(publication.repositoryUrl, "repositoryUrl") }, capabilities: [...p.capabilities].sort() };
  if (result.vectorNamespace.length < 3) throw new Error("Vector namespace requires at least three characters");
  admittedProfiles.add(result); return freeze(result);
}
export const defaultCivicProfile = validateCivicProfile({ schemaVersion: "civic-profile/v1", id: "crescent-city", name: "Crescent City", municipality: "Crescent City, CA", county: "Del Norte County", state: "California", countryCode: "US", timeZone: "America/Los_Angeles", anchor: { latitude: 41.76, longitude: -124.2, bounds: { west: -124.408, south: 41.458, east: -123.536, north: 42.006 } }, code: { provider: "ecode360", municipalityCode: "CR4919" }, corpusSlug: "crescent-city-code", vectorNamespace: "crescent-city-code", calendar: { uidDomain: "crescent-city-intel", productId: "-//Crescent City Intel//Events Calendar//EN" }, publication: { title: "The Quadruplicate", description: "Civic intelligence for Crescent City and Del Norte County", siteUrl: "https://quadruplicate.org", repositoryUrl: "https://github.com/docxology/crescent-city-intel" }, capabilities: ["ecode360", "news", "events", "analytics", "geo", "crescent-city-adapters"] });
export function civicProfileFingerprint(profile: CivicProfile = currentCivicProfile()): string { const checked = validateCivicProfile(profile); const cached = fingerprints.get(checked); if (cached) return cached; const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(checked)).digest("hex"); fingerprints.set(checked, hash); return hash; }
export function isCrescentCityProfile(profile: CivicProfile = currentCivicProfile()): boolean { return civicProfileFingerprint(profile) === civicProfileFingerprint(defaultCivicProfile); }
function assertProfileIsolation(profile: CivicProfile): void {
  if (!isCrescentCityProfile(profile) && (profile.id === defaultCivicProfile.id || profile.corpusSlug === defaultCivicProfile.corpusSlug || profile.vectorNamespace === defaultCivicProfile.vectorNamespace || profile.calendar.uidDomain === defaultCivicProfile.calendar.uidDomain || profile.capabilities.includes("crescent-city-adapters"))) throw new Error("Alternate civic profile must use independent identities and cannot enable unconfigured Crescent City adapters");
}
const processProfiles = new Map<string, CivicProfile>();
/** A profile file is read once per process. Restart after editing it; contexts never mutate global env. */
export function currentCivicProfile(): CivicProfile {
  const scoped = context.getStore(); if (scoped) return scoped;
  const file = process.env.CIVIC_PROFILE; if (!file) return defaultCivicProfile;
  const cached = processProfiles.get(file); if (cached) return cached;
  const handle = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  let value: unknown;
  try {
    const info = fstatSync(handle); if (!info.isFile() || info.size > 64 * 1024) throw new Error("Civic profile must be a bounded regular JSON file");
    const buffer = Buffer.alloc(64 * 1024 + 1); let count = 0, read: number;
    while ((read = readSync(handle, buffer, count, buffer.length - count, count)) > 0) { count += read; if (count > 64 * 1024) throw new Error("Civic profile exceeds byte bound"); }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)));
  } finally { closeSync(handle); }
  const profile = validateCivicProfile(value); assertProfileIsolation(profile); processProfiles.set(file, profile); return profile;
}
export function withCivicProfile<T>(profile: CivicProfile, task: () => T): T { const checked = validateCivicProfile(profile); assertProfileIsolation(checked); return context.run(checked, task); }
export function municipalCodeId(): string { const profile = currentCivicProfile(); if (!profile.code || !profile.capabilities.includes("ecode360")) throw new Error("Selected civic profile has no configured ecode360 adapter"); return profile.code.municipalityCode; }
export function assertCivicCorpusIdentity(toc: unknown, manifest?: unknown, code?: unknown): void {
  const expected = municipalCodeId();
  const t = toc as Record<string, unknown> | null, m = manifest as Record<string, unknown> | undefined, c = code as Record<string, unknown> | undefined;
  if (!t || t.guid !== expected || m?.municipalityGuid !== undefined && m.municipalityGuid !== expected || m?.sourceUrl !== undefined && m.sourceUrl !== `https://ecode360.com/${expected}` || c && (c.guid !== expected || c.source !== `https://ecode360.com/${expected}`)) throw new Error("Municipal corpus identity differs from selected civic profile");
}
/** Admission only; provider coverage cannot be gained by changing a display name. */
export function assertCivicProducerSupported(name: string): void {
  if (isCrescentCityProfile()) return;
  const supported: Record<string, string> = { news: "news", events: "events", "source-discovery": "geo", "municipal-monitor": "ecode360" };
  if (!supported[name] || !currentCivicProfile().capabilities.includes(supported[name]!)) throw new Error(`Producer ${name} has no configured adapter for civic profile ${currentCivicProfile().id}`);
}
/** Bind before a producer writes. Unbound alternate roots must contain no retained data. */
export async function bindCivicOutputRoot(root: string): Promise<void> {
  const { join } = await import("node:path"), { readdir } = await import("node:fs/promises");
  const { withFileLease, assertSafeFilesystemPath } = await import("./shared/storage.js"), { writeJsonAtomic } = await import("./shared/source_health.js");
  const { captureArtifactBytes } = await import("./artifact_custody.js");
  const profile = currentCivicProfile(), fingerprint = civicProfileFingerprint(profile);
  await withFileLease(join(root, "state", "civic-profile.lock"), async () => {
    const path = join(root, "state", "civic-profile.json");
    await assertSafeFilesystemPath(path);
    let existing: unknown;
    try { existing = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await captureArtifactBytes(path, 4096))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing !== undefined) {
      const receipt = record(existing, ["schemaVersion", "profileId", "profileSha256"], "output civic identity");
      if (receipt.schemaVersion !== "civic-output-profile/v1" || receipt.profileId !== profile.id || receipt.profileSha256 !== fingerprint) throw new Error("Output root belongs to a different civic profile");
      return;
    }
    if (!isCrescentCityProfile(profile)) {
      const rows = await readdir(root, { withFileTypes: true });
      if (rows.some(row => row.name !== "state" || !row.isDirectory() || row.isSymbolicLink())) throw new Error("Cannot adopt an unbound nonempty output root for an alternate civic profile");
      const state = await readdir(join(root, "state"));
      if (state.some(name => name !== "producers" && name !== "civic-profile.lock")) throw new Error("Cannot adopt retained state without civic identity");
    }
    await writeJsonAtomic(path, { schemaVersion: "civic-output-profile/v1", profileId: profile.id, profileSha256: fingerprint });
  }, { staleMs: 0 });
}

if (import.meta.main) console.log(JSON.stringify({ profile: currentCivicProfile(), sha256: civicProfileFingerprint(), boundary: "Configuration identity only; no live adapter availability, legal correctness or operational multitenancy claim" }, null, 2));

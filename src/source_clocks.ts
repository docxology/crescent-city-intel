/** Source-specific consumption clocks. Retrieval proves a check, not a new observation. */
import type { SourceHealth } from "./types.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const SOURCE_CLOCK_POLICIES = {
  tsunami: { basis: "retrieval", maxAgeMs: HOUR }, earthquake: { basis: "retrieval", maxAgeMs: HOUR },
  weather: { basis: "retrieval", maxAgeMs: HOUR }, airquality: { basis: "observation", maxAgeMs: 2 * HOUR },
  wildfire: { basis: "retrieval", maxAgeMs: HOUR }, marine: { basis: "observation", maxAgeMs: 2 * HOUR },
  marinezone: { basis: "product", maxAgeMs: DAY }, tides: { basis: "retrieval", maxAgeMs: HOUR },
  fishing: { basis: "retrieval", maxAgeMs: DAY }, drought: { basis: "product", maxAgeMs: 10 * DAY },
  psps: { basis: "retrieval", maxAgeMs: HOUR }, smoke: { basis: "product", maxAgeMs: DAY },
  roads: { basis: "retrieval", maxAgeMs: HOUR }, schools: { basis: "retrieval", maxAgeMs: DAY },
  uscg: { basis: "retrieval", maxAgeMs: DAY }, permits: { basis: "retrieval", maxAgeMs: DAY },
  dredging: { basis: "retrieval", maxAgeMs: DAY }, fuel: { basis: "product", maxAgeMs: 10 * DAY },
  pacfin: { basis: "retrieval", maxAgeMs: DAY }, ais: { basis: "observation", maxAgeMs: HOUR / 3 },
} as const;
export type SourceClockKey = keyof typeof SOURCE_CLOCK_POLICIES;
type Clock = Pick<SourceHealth, "timestampBasis" | "observedAt" | "productDate" | "validUntil" | "observationAgeMs" | "observationFreshness">;
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function civil(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function timestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && civil(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60; }
/** An absent required primary clock is unknown, even after a successful refetch. */
export function assessSourceClock(key: SourceClockKey, value: unknown, now = Date.now()): Clock & { usable: boolean; reason?: string } {
  const row = record(value), policy = SOURCE_CLOCK_POLICIES[key];
  const result: Clock = { timestampBasis: policy.basis, observationFreshness: "unknown" };
  let raw: unknown = row.observedAt;
  if (key === "marine") raw ??= Array.isArray(row.observations) && row.observations.length ? row.observations.map(item => record(item).timestamp).sort()[0] : undefined;
  if (key === "ais") raw ??= Array.isArray(row.vesselsInWatchArea) && row.vesselsInWatchArea.length ? row.vesselsInWatchArea.map(item => record(item).positionAt).sort()[0] : undefined;
  if (policy.basis === "product") {
    const product = row.productDate ?? (key === "fuel" ? record(row.latest).weekOf : undefined);
    if (product !== undefined && !civil(product)) return { ...result, usable: false, reason: "Invalid source product date" };
    if (civil(product)) { result.productDate = product; raw ??= `${product}T00:00:00Z`; }
    if (key === "smoke") raw ??= row.timestamp;
  }
  if (policy.basis === "retrieval") raw = row.fetchedAt ?? row.timestamp;
  if (raw === undefined || raw === null) return { ...result, usable: false, reason: "Primary source clock absent" };
  if (!timestamp(raw) || !Number.isFinite(now) || Date.parse(raw) > now) return { ...result, usable: false, reason: "Invalid or future source clock" };
  if (policy.basis !== "retrieval") result.observedAt = raw;
  result.observationAgeMs = now - Date.parse(raw);
  if (row.validUntil !== undefined) {
    if (!timestamp(row.validUntil) || Date.parse(row.validUntil) < Date.parse(raw)) return { ...result, usable: false, reason: "Invalid source validity window" };
    result.validUntil = row.validUntil;
  }
  const fresh = result.observationAgeMs <= policy.maxAgeMs && (!result.validUntil || now <= Date.parse(result.validUntil));
  result.observationFreshness = fresh ? "fresh" : "stale";
  return { ...result, usable: fresh, ...(fresh ? {} : { reason: "Source observation/product expired" }) };
}

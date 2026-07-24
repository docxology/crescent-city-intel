import { mkdir, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { SourceHealth, SourceHealthStatus, SourceHealthSummary } from "../types.js";

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const SOURCE_FETCH_TIMEOUT_MS = positiveEnvNumber("SOURCE_FETCH_TIMEOUT_MS", 10000);
export const DEFAULT_FRESHNESS_WINDOW_MS = positiveEnvNumber("SOURCE_FRESHNESS_WINDOW_MS", 24 * 60 * 60 * 1000);

export function sourceHealth(
  source: string,
  status: SourceHealthStatus,
  checkedAt: string,
  details: Omit<Partial<SourceHealth>, "source" | "status" | "checkedAt"> = {},
): SourceHealth {
  const health: SourceHealth = {
    source,
    status,
    checkedAt,
    itemCount: details.itemCount ?? 0,
    ...details,
  };
  if (health.fetchedAt) {
    const ageMs = Date.parse(health.fetchedAt);
    if (Number.isFinite(ageMs)) {
      health.ageMs = Math.max(0, Date.now() - ageMs);
      health.freshness = health.ageMs <= (health.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS) ? "fresh" : "stale";
    } else {
      health.freshness = "unknown";
    }
  } else {
    health.freshness = "unknown";
  }
  return health;
}

/** Aggregate source states without hiding unavailable or stale feeds. */
export function summarizeSourceHealth(
  sources: SourceHealth[],
  checkedAt = new Date().toISOString(),
): SourceHealthSummary {
  const counts = { ok: 0, empty: 0, unavailable: 0, stale: 0 };
  for (const source of sources) {
    if (source.status in counts) counts[source.status] += 1;
  }
  return {
    checkedAt,
    total: sources.length,
    ...counts,
    degraded: counts.unavailable + counts.stale,
    sources: sources.map(source => source.source).sort(),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write a JSON artifact atomically so concurrent runs cannot truncate it. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(temporary, path);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf-8");
  await rename(temporary, path);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

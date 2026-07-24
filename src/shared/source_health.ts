import { mkdir, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { SourceHealth, SourceHealthStatus } from "../types.js";

export const SOURCE_FETCH_TIMEOUT_MS = Number(process.env.SOURCE_FETCH_TIMEOUT_MS ?? "10000");

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
    if (Number.isFinite(ageMs)) health.ageMs = Math.max(0, Date.now() - ageMs);
  }
  return health;
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

// Structured local-establishments directory for Crescent City & Del Norte County.
//
// The seed data lives in pages-data/directory.json (hand-curated, source-cited
// entries). This module validates it into the crescent-city-directory/v1
// artifact emitted to data/directory.json in the public Pages snapshot.
//
// Each entry carries a source citation. Recorded editorial consultation/review
// dates stay unknown unless supplied; artifact generation and HTTP reachability
// do not establish that every cited field was verified. No LLM is used here.
import { isIP } from "node:net";
import { isPublicAddress, redactUrl } from "./shared/transport.js";

export const PAGES_DIRECTORY_ARTIFACT = "data/directory.json";
export const DIRECTORY_SCHEMA = "crescent-city-directory/v1";

/** Pull-down menu categories, in canonical order. */
export const DIRECTORY_CATEGORIES = [
  "Government",
  "Schools",
  "Healthcare",
  "Restaurants",
  "Churches",
  "Retail",
  "Services",
  "Finance",
  "Media",
  "Lodging",
  "Attractions",
] as const;

export type DirectoryCategory = (typeof DIRECTORY_CATEGORIES)[number];

export interface DirectoryEntry {
  name: string;
  category: DirectoryCategory;
  address: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  /** Source attribution; verification requires separate recorded editorial evidence. */
  source: string;
  /** Editorial evidence dates, independent of artifact generation or URL reachability. */
  consultedAt?: string | null;
  reviewedAt?: string | null;
}

export interface DirectoryArtifact {
  schema: typeof DIRECTORY_SCHEMA;
  generatedAt: string;
  count: number;
  categories: Array<{ category: DirectoryCategory; count: number }>;
  entries: DirectoryEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeUrl(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !host.includes(".") && !isIP(host) || /^(?:localhost|.*\.(?:localhost|local|internal|lan))$/i.test(host) || isIP(host) && !isPublicAddress(host)) return null;
    if (redactUrl(url.href) !== url.href) return null;
    return url.href;
  } catch { return null; }
}

function validEvidenceDate(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(Date.parse(value.slice(0, 10))).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Validate one raw seed entry; returns a normalized entry or an error string. */
function normalizeEntry(raw: unknown, index: number): { entry?: DirectoryEntry; error?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: `entry ${index} is not an object` };
  }
  const record = raw as Record<string, unknown>;
  if (!isNonEmptyString(record.name)) return { error: `entry ${index} is missing a name` };
  if (!isNonEmptyString(record.category)) return { error: `entry ${index} is missing a category` };
  const category = record.category as DirectoryCategory;
  if (!DIRECTORY_CATEGORIES.includes(category)) {
    return { error: `entry ${index} (${String(record.name)}) has unknown category: ${String(record.category)}` };
  }
  if (!isNonEmptyString(record.source)) return { error: `entry ${index} (${String(record.name)}) is missing a source URL` };
  if (!normalizeUrl(record.source)) {
    return { error: `entry ${index} (${String(record.name)}) has a non-URL source` };
  }
  for (const field of ["address", "phone", "website", "description"]) if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") return { error: `entry ${index} has an invalid ${field} type` };
  for (const field of ["consultedAt", "reviewedAt"]) if (!validEvidenceDate(record[field])) return { error: `entry ${index} has an invalid ${field}` };
  if (typeof record.website === "string" && /^https?:/i.test(record.website) && !normalizeUrl(record.website)) return { error: `entry ${index} has an unsafe website` };
  return {
    entry: {
      name: (record.name as string).trim(),
      category,
      address: isNonEmptyString(record.address) ? (record.address as string).trim() : null,
      phone: isNonEmptyString(record.phone) ? (record.phone as string).trim() : null,
      website: normalizeUrl(record.website),
      description: isNonEmptyString(record.description) ? (record.description as string).trim() : null,
      source: normalizeUrl(record.source)!,
      consultedAt: (record.consultedAt as string | null | undefined) ?? null,
      reviewedAt: (record.reviewedAt as string | null | undefined) ?? null,
    },
  };
}

/** Validate + shape a raw seed payload into the public artifact. */
export function buildDirectoryArtifact(generatedAt: string, raw: unknown): DirectoryArtifact | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return null;
  if (!validEvidenceDate(generatedAt)) throw new Error("directory has invalid generatedAt");
  const errors: string[] = [];
  const entries: DirectoryEntry[] = [];
  for (const [index, item] of (record.entries as unknown[]).entries()) {
    const result = normalizeEntry(item, index);
    if (result.error) errors.push(result.error);
    else if (result.entry) entries.push(result.entry);
  }
  if (errors.length > 0) throw new Error(`directory seed has invalid entries: ${errors.join("; ")}`);
  if (entries.length === 0) return null;
  if (new Set(entries.map(entry => `${entry.category}:${entry.name.toLocaleLowerCase()}`)).size !== entries.length) throw new Error("directory seed has duplicate entry identities");
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const categories = DIRECTORY_CATEGORIES
    .map(category => ({ category, count: entries.filter(entry => entry.category === category).length }))
    .filter(group => group.count > 0);
  return {
    schema: DIRECTORY_SCHEMA,
    generatedAt,
    count: entries.length,
    categories,
    entries,
  };
}

export function summarizeDirectory(artifact: DirectoryArtifact | null): { available: boolean; count: number; categoryCount: number } {
  return {
    available: artifact !== null,
    count: artifact?.count ?? 0,
    categoryCount: artifact?.categories.length ?? 0,
  };
}

/** Parse a JSON directory artifact read from disk (export or seed). */
export function parseDirectoryArtifact(text: string): DirectoryArtifact | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).schema === DIRECTORY_SCHEMA
      && Array.isArray((parsed as Record<string, unknown>).entries)
      && ((parsed as Record<string, unknown>).entries as unknown[]).length > 0
    ) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.generatedAt !== "string" || !validEvidenceDate(record.generatedAt)) return null;
      const validated = buildDirectoryArtifact(record.generatedAt, record);
      if (!validated || record.count !== validated.count || !Array.isArray(record.categories)) return null;
      const categories = record.categories as Array<{ category: unknown; count: unknown }>;
      if (categories.length !== validated.categories.length || new Set(categories.map(row => row.category)).size !== categories.length || categories.some(row => !validated.categories.some(expected => expected.category === row.category && expected.count === row.count))) return null;
      return validated;
    }
    return null;
  } catch {
    return null;
  }
}

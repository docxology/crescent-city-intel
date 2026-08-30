// Structured local-establishments directory for Crescent City & Del Norte County.
//
// The seed data lives in pages-data/directory.json (hand-curated, source-cited
// entries). This module validates it into the crescent-city-directory/v1
// artifact emitted to data/directory.json in the public Pages snapshot.
//
// Provenance rules mirror the insights engine: every entry carries a source URL
// that was actually consulted; a field that was not verified is null, never
// guessed. Validation is deterministic — no LLM anywhere in this path.

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
  /** URL the entry facts were verified against; never guessed. */
  source: string;
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
  return /^https?:\/\//i.test(value) ? value : null;
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
  if (!/^https?:\/\//i.test(record.source)) {
    return { error: `entry ${index} (${String(record.name)}) has a non-URL source` };
  }
  return {
    entry: {
      name: (record.name as string).trim(),
      category,
      address: isNonEmptyString(record.address) ? (record.address as string).trim() : null,
      phone: isNonEmptyString(record.phone) ? (record.phone as string).trim() : null,
      website: normalizeUrl(record.website),
      description: isNonEmptyString(record.description) ? (record.description as string).trim() : null,
      source: (record.source as string).trim(),
    },
  };
}

/** Validate + shape a raw seed payload into the public artifact. */
export function buildDirectoryArtifact(generatedAt: string, raw: unknown): DirectoryArtifact | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return null;
  const errors: string[] = [];
  const entries: DirectoryEntry[] = [];
  for (const [index, item] of (record.entries as unknown[]).entries()) {
    const result = normalizeEntry(item, index);
    if (result.error) errors.push(result.error);
    else if (result.entry) entries.push(result.entry);
  }
  if (errors.length > 0) throw new Error(`directory seed has invalid entries: ${errors.join("; ")}`);
  if (entries.length === 0) return null;
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
      return parsed as DirectoryArtifact;
    }
    return null;
  } catch {
    return null;
  }
}

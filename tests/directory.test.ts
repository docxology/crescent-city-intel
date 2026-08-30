import { describe, expect, test } from "bun:test";
import { buildDirectoryArtifact, parseDirectoryArtifact, summarizeDirectory, DIRECTORY_CATEGORIES } from "../src/directory.js";
import { readFileSync } from "node:fs";
import { join } from "path";

const VALID_ENTRY = {
  name: "City of Crescent City",
  category: "Government",
  address: "377 J Street, Crescent City, CA 95531",
  phone: "707-464-7483",
  website: "https://www.crescentcity.org/",
  description: "City government for Crescent City.",
  source: "https://www.crescentcity.org/",
};

describe("directory artifact builder", () => {
  test("builds a valid artifact from a valid seed", () => {
    const artifact = buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [VALID_ENTRY, { ...VALID_ENTRY, name: "Zeta", category: "Retail" }] });
    expect(artifact).not.toBeNull();
    expect(artifact!.count).toBe(2);
    expect(artifact!.schema).toBe("crescent-city-directory/v1");
    expect(artifact!.categories.map(group => group.category)).toEqual(["Government", "Retail"]);
    // Sorted by category then name.
    expect(artifact!.entries[0]!.name).toBe("City of Crescent City");
  });

  test("category summary only lists non-empty categories", () => {
    const artifact = buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [VALID_ENTRY] });
    expect(artifact!.categories).toEqual([{ category: "Government", count: 1 }]);
  });
});

describe("directory seed guards", () => {
  test("null for missing or empty seeds", () => {
    expect(buildDirectoryArtifact("2026-08-30T00:00:00Z", null)).toBeNull();
    expect(buildDirectoryArtifact("2026-08-30T00:00:00Z", {})).toBeNull();
    expect(buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [] })).toBeNull();
    expect(parseDirectoryArtifact("not json")).toBeNull();
  });

  test("invalid entries fail loudly with the entry named", () => {
    expect(() => buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [{ name: "No category", source: "https://example.com" }] })).toThrow(/missing a category/);
    expect(() => buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [{ name: "X", category: "Bogus", source: "https://x.example" }] })).toThrow(/unknown category/);
    expect(() => buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [{ name: "X", category: "Retail" }] })).toThrow(/missing a source/);
    expect(() => buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [{ name: "X", category: "Retail", source: "not-a-url" }] })).toThrow(/non-URL source/);
  });

  test("unverified fields stay null and non-http websites are dropped", () => {
    const artifact = buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [{ name: "X", category: "Media", source: "https://example.com/a", website: "ftp://nope", phone: "" }] });
    expect(artifact!.entries[0]!.website).toBeNull();
    expect(artifact!.entries[0]!.phone).toBeNull();
  });
});

describe("shipped directory seed", () => {
  test("every seed entry passes the same validation the export uses", () => {
    const seedText = readFileSync(join(import.meta.dir, "../pages-data/directory.json"), "utf8");
    const artifact = buildDirectoryArtifact("2026-08-30T00:00:00Z", JSON.parse(seedText));
    expect(artifact).not.toBeNull();
    expect(artifact!.count).toBeGreaterThan(50);
    for (const entry of artifact!.entries) {
      expect(DIRECTORY_CATEGORIES).toContain(entry.category);
      expect(entry.source.startsWith("https://") || entry.source.startsWith("http://")).toBe(true);
    }
  });

  test("a built artifact round-trips through parseDirectoryArtifact", () => {
    const artifact = buildDirectoryArtifact("2026-08-30T00:00:00Z", { entries: [VALID_ENTRY] });
    const roundTripped = parseDirectoryArtifact(JSON.stringify(artifact));
    expect(roundTripped).not.toBeNull();
    expect(roundTripped!.entries.length).toBe(roundTripped!.count);
    expect(roundTripped!.schema).toBe("crescent-city-directory/v1");
  });
});

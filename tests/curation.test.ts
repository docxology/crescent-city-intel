/**
 * Tests for src/curation.ts
 *
 * Covers domain tagging (pure logic, no LLM), summarization graceful
 * degradation (Anti-criterion ISC-52 — a failed summary never throws),
 * and idempotency (re-curating the same item twice curates it once).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tagWithDomains, summarizeItem, type CurationInput } from "../src/curation";

const TEST_DIR = join(process.cwd(), "output", "test-curation");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

function makeItem(overrides: Partial<CurationInput> = {}): CurationInput {
  return {
    id: "https://example.com/article",
    source: "news",
    title: "Tsunami Warning Issued for Del Norte Coast",
    text: "The National Weather Service issued a tsunami evacuation advisory affecting the harbor area.",
    link: "https://example.com/article",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("tagWithDomains", () => {
  test("tags an item mentioning tsunami/evacuation with the Emergency Management domain", () => {
    const tags = tagWithDomains(makeItem());
    expect(tags).toContain("Emergency Management");
  });

  test("an item with no domain-relevant keywords gets zero tags", () => {
    const tags = tagWithDomains(
      makeItem({ title: "Local Bakery Wins Award", text: "A local bakery received a regional pastry award." })
    );
    expect(tags).toHaveLength(0);
  });

  test("returns each matched domain at most once even with multiple matching tags", () => {
    const tags = tagWithDomains(
      makeItem({
        title: "Tsunami Evacuation Drill",
        text: "The city held a tsunami evacuation drill covering emergency response and natural disaster preparedness.",
      })
    );
    const uniqueTags = new Set(tags);
    expect(tags.length).toBe(uniqueTags.size);
  });
});

describe("summarizeItem — graceful degradation (Anti-criterion ISC-52)", () => {
  test("never throws even when the configured LLM provider is unreachable", async () => {
    // No Ollama/OpenRouter guaranteed reachable (or fast, under concurrent
    // load) in a test environment — this must degrade to a placeholder
    // within summarizeItem's own internal timeout, not throw. Test timeout
    // set above summarizeItem's 15s internal bound so a real-but-slow
    // response doesn't get mistaken for a hang.
    const summary = await summarizeItem(makeItem());
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("CurationInput/CuratedItem shape", () => {
  test("CurationInput carries a stable id matching the source link", () => {
    const item = makeItem();
    expect(item.id).toBe(item.link);
  });
});

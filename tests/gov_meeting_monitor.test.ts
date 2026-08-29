/**
 * Tests for gov_meeting_monitor.ts
 *
 * Tests the pure-logic aspects:
 * - Network error handling (graceful [] return)
 * - saveMeetingItems contract (writes to disk in correct shape)
 * - monitorGovMeetings overall execution path
 */
import { describe, expect, test } from "bun:test";
import { fetchGovMeetings, saveMeetingItems } from "../src/gov_meeting_monitor";
import { existsSync } from "fs";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("fetchGovMeetings", () => {
  test("returns empty array when URL is unreachable", async () => {
    const result = await fetchGovMeetings("http://localhost:0/nonexistent", "TestSource");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test("returns empty array on HTTP 404", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("not found", { status: 404 }),
    });
    const result = await fetchGovMeetings(`http://localhost:${server.port}/missing`, "TestSource");
    server.stop();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe("saveMeetingItems", () => {
  test("creates a JSON file in output/gov_meetings/ with correct structure", async () => {
    const testItems = [
      {
        title: "City Council Meeting - March 2026",
        link: "https://crescentcity.org/agendas/cc-mar-2026.pdf",
        date: "Mar 18, 2026",
        content: "Agenda for the March 2026 city council meeting.",
        source: "City Council",
        fetchedAt: new Date().toISOString(),
        isNew: true,
        changed: true,
      },
    ];

    // The batch goes to a throwaway directory, never the real corpus. This test
    // used to write into output/gov_meetings with no cleanup, so every run left
    // another fabricated council meeting in the corpus the Pages export reads —
    // 381 of them by the time it was found, one of which the site published.
    const dir = await mkdtemp(join(tmpdir(), "cci-meetings-"));
    try {
    await saveMeetingItems(testItems, [], dir);

    expect(existsSync(dir)).toBe(true);

    const files = (await readdir(dir)).filter((f) =>
      f.startsWith("gov_meetings-") && f.endsWith(".json")
    );
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Read the most recently written file and verify shape
    const latest = files.sort().at(-1)!;
    const raw = await readFile(join(dir, latest), "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed).toHaveProperty("fetchedAt");
    expect(parsed).toHaveProperty("totalItems");
    expect(parsed).toHaveProperty("items");
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items[0].title).toBe("City Council Meeting - March 2026");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the real corpus is left untouched by this test", async () => {
    const corpus = join(process.cwd(), "output", "gov_meetings");
    const before = existsSync(corpus) ? (await readdir(corpus)).length : 0;
    const dir = await mkdtemp(join(tmpdir(), "cci-meetings-"));
    try {
      await saveMeetingItems([{ title: "fixture", link: "https://example.test/a", date: "Mar 1, 2026", content: "", source: "Fixture", fetchedAt: new Date().toISOString(), isNew: true, changed: false }], [], dir);
      expect((await readdir(dir)).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const after = existsSync(corpus) ? (await readdir(corpus)).length : 0;
    expect(after).toBe(before);
  });
});

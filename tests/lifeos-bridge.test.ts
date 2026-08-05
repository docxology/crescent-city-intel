/**
 * Tests for the LifeOS/Pulse bridge (scripts/lifeos-bridge.ts) — builds the
 * LocalIntelligence digest from repo-shaped outputs and writes both latest.json
 * paths the Pulse module reads. Zero-mock: real files in a temp fixture dir.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildDigest, writeDigest, loadLatestJson } from "../scripts/lifeos-bridge.ts";

const tmp = join(tmpdir(), `lifeos-bridge-test-${Date.now()}`);
const out = join(tmp, "output");
const custom = join(tmp, "custom");
const data = join(tmp, "data");

beforeAll(() => {
  mkdirSync(join(out, "news"), { recursive: true });
  mkdirSync(join(out, "gov_meetings"), { recursive: true });
  mkdirSync(join(out, "alerts", "composite"), { recursive: true });
  writeFileSync(
    join(out, "news", "news-2026-08-01T00-00-00-000Z.json"),
    JSON.stringify({
      fetchedAt: "2026-08-01T00:00:00.000Z",
      items: [
        { title: "Harbor grant approved", link: "https://example.com/harbor", pubDate: "Fri, 01 Aug 2026 08:00:00 -0700", content: "The city council approved the harbor grant.", source: "Test Paper" },
        { title: "", link: "https://example.com/empty-title", pubDate: "", source: "Test Paper" },
      ],
    }),
  );
  writeFileSync(
    join(out, "gov_meetings", "gov_meetings-2026-08-01T00-00-00-000Z.json"),
    JSON.stringify({
      items: [
        { title: "City Council Meeting", link: "https://crescentcity.org/events/1/", date: "2026-07-20", source: "City Council", content: "Agenda" },
        { title: "Planning Commission", link: "https://crescentcity.org/events/2/", date: "2026-07-21", source: "Planning Commission", content: "Agenda" },
      ],
    }),
  );
  writeFileSync(
    join(out, "alerts", "composite", "current.json"),
    JSON.stringify({ level: "WARNING", reason: "Tides high", assessedAt: "2026-08-01T00:00:00.000Z" }),
  );
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ sectionCount: 2194, articlePageCount: 245 }));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildDigest", () => {
  test("maps repo news/meetings into digest sections and skips invalid items", async () => {
    const digest = await buildDigest({ outputDir: out, generatedAt: "2026-08-01T00:00:00.000Z" });
    expect(digest.meta.city).toBe("Crescent City");
    expect(digest.meta.state).toBe("CA");
    expect(digest.meta.zip).toBe("95531");
    expect(digest.meta.region).toContain("North Coast");
    expect(digest.meta.region).toContain("Humboldt");
    expect(digest.news.items).toHaveLength(1); // empty-title item dropped
    expect(digest.news.items[0].source).toBe("Test Paper");
    expect(digest.officials.items).toHaveLength(1);
    expect(digest.officials.items[0].title).toBe("City Council Meeting");
    expect(digest.legislation.items).toHaveLength(1); // Planning Commission
    expect(digest.construction.source_status).toBe("empty");
    expect(digest.meta.overview).toContain("North Coast");
    expect(digest.meta.overview).toContain("Humboldt");
    expect(digest.meta.overview).toContain("composite alert: WARNING");
    expect(digest.meta.overview).toContain("2194 sections");
  });

  test("empty output dir yields empty sections, not a crash", async () => {
    const empty = join(tmp, "empty-out");
    mkdirSync(empty, { recursive: true });
    const digest = await buildDigest({ outputDir: empty, generatedAt: "2026-08-01T00:00:00.000Z" });
    expect(digest.news.source_status).toBe("empty");
    expect(digest.officials.items).toEqual([]);
  });
});

describe("writeDigest / loadLatestJson", () => {
  test("writes dated + both latest.json paths, and loadLatestJson reads the newest", async () => {
    const digest = await buildDigest({ outputDir: out, generatedAt: "2026-08-01T00:00:00.000Z" });
    const paths = await writeDigest(digest, custom, data);
    expect(paths.customLatest.endsWith("latest.json")).toBe(true);
    expect(paths.dataLatest.endsWith("latest.json")).toBe(true);
    expect(paths.datedPath).toContain("2026-08-01_crescent-city_ca_digest.json");

    const roundTrip = await loadLatestJson<{ meta: { city: string } }>(data, "2026-08-01_crescent-city");
    expect(roundTrip?.meta.city).toBe("Crescent City");
    const customLatest = await loadLatestJson<{ meta: { city: string } }>(custom, "latest");
    expect(customLatest?.meta.city).toBe("Crescent City");
  });

  test("loadLatestJson returns null for a missing dir", async () => {
    expect(await loadLatestJson(join(tmp, "nope"), "news-")).toBeNull();
  });
});

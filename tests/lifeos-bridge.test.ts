/**
 * Tests for the LifeOS/Pulse bridge (src/lifeos_bridge.ts) — builds the
 * LocalIntelligence digest from repo-shaped outputs and writes both latest.json
 * paths the Pulse module reads. Zero-mock: real files in a temp fixture dir.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildDigest, writeDigest, loadLatestJson } from "../src/lifeos_bridge.ts";
import { custodyHash } from "../src/corpus_editions.ts";
import { sourceHealth } from "../src/shared/source_health.ts";

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
  for (const [producer, names] of [["news", ["Test Paper"]], ["gov_meetings", ["City Council", "Planning Commission"]]] as const) writeFileSync(join(out, producer, "source-health.json"), JSON.stringify({ sources: names.map(name => sourceHealth(name, "ok", "2026-08-01T00:00:00.000Z", { fetchedAt: "2026-08-01T00:00:00.000Z", itemCount: 1 })) }));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildDigest", () => {
  test("credential-bearing item URLs are excluded from the bridge payload", async () => {
    const unsafe = join(tmp, "unsafe-urls"); mkdirSync(join(unsafe, "news"), { recursive: true });
    writeFileSync(join(unsafe, "news", "news-2026-09-30.json"), JSON.stringify({ items: [{ title: "Unsafe URL", source: "Fixture source", link: "https://example.test/#auth=private-fixture-token", pubDate: "2026-09-30T12:00:00Z" }] }));
    const digest = await buildDigest({ outputDir: unsafe, generatedAt: "2026-09-30T12:00:00Z" });
    expect(digest.news.items).toHaveLength(0); expect(JSON.stringify(digest)).not.toContain("private-fixture-token");
    expect(digest.meta.errors.some(error => error.includes("malformed or unsafe"))).toBe(true);
  });
  test("maps repo news/meetings into digest sections and skips invalid items", async () => {
    const digest = await buildDigest({ outputDir: out, generatedAt: "2026-08-01T00:00:00.000Z" });
    expect(digest.meta.city).toBe("Crescent City");
    expect(digest.meta.state).toBe("CA");
    expect(digest.meta.zip).toBe("95531");
    expect(digest.meta.region).toContain("North Coast");
    expect(digest.meta.region).toContain("Humboldt");
    expect(digest.news.items).toHaveLength(1); // empty-title item dropped
    expect(digest.news.items[0].source).toBe("Test Paper");
    expect(digest.news.source_status).toBe("ok"); expect(digest.meta.contract_version).toBe("2.0.0");
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
    expect(digest.news.source_status).toBe("unavailable");
    expect(digest.officials.items).toEqual([]);
  });
  test("missing, malformed and stale receipts remain unavailable; undated rows keep explicit unknown dates", async () => {
    const root = join(tmp, "health-evidence"); mkdirSync(join(root, "news"), { recursive: true });
    const batchPath = join(root, "news", "news-2026-09-30.json");
    writeFileSync(batchPath, JSON.stringify({ items: [{ title: "Undated notice", link: "https://example.org/notice", source: "Fixture" }] }));
    const unknown = await buildDigest({ outputDir: root, generatedAt: "2026-09-30T12:00:00Z" });
    expect(unknown.news.items[0]).toMatchObject({ date: "", dateEvidence: "unknown" }); expect(unknown.news.source_status).toBe("unavailable"); expect(unknown.meta.sources_failed).toContain("news");
    writeFileSync(join(root, "news", "source-health.json"), JSON.stringify({ sources: [sourceHealth("Fixture", "ok", "2026-09-01T12:00:00Z", { fetchedAt: "2026-09-01T12:00:00Z", itemCount: 1 })] }));
    const stale = await buildDigest({ outputDir: root, generatedAt: "2026-09-30T12:00:00Z" }); expect(stale.news.source_status).toBe("unavailable"); expect(stale.meta.sources_failed).toContain("Fixture");
    writeFileSync(batchPath, JSON.stringify({ items: "not an array" }));
    const malformed = await buildDigest({ outputDir: root, generatedAt: "2026-09-30T12:00:00Z" }); expect(malformed.news.items).toEqual([]); expect(malformed.news.source_status).toBe("unavailable");
    writeFileSync(batchPath, JSON.stringify({ items: [] }));
    writeFileSync(join(root, "news", "source-health.json"), JSON.stringify({ sources: [sourceHealth("Fixture", "unavailable", "2026-09-30T12:00:00Z", { itemCount: 0, error: "Fixture parser failure" })] }));
    const emptyFailure = await buildDigest({ outputDir: root, generatedAt: "2026-09-30T12:00:00Z" }); expect(emptyFailure.news.source_status).toBe("unavailable"); expect(emptyFailure.news.errors).toContain("Fixture: Fixture parser failure");
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
    for (const path of [paths.customLatest, paths.dataLatest, paths.datedPath]) expect(custodyHash(readFileSync(path))).toBe(paths.sha256);
    expect((await loadLatestJson<{ sha256: string }>(data, "digest-receipt"))?.sha256).toBe(paths.sha256);
  });
  test("real commit failure restores every previous copy and retains a recovery journal", async () => {
    const rollbackCustom = join(tmp, "rollback-custom"); const rollbackData = join(tmp, "rollback-data"); mkdirSync(rollbackCustom); mkdirSync(rollbackData);
    const dated = join(rollbackData, "2026-08-01_crescent-city_ca_digest.json");
    for (const path of [join(rollbackCustom, "latest.json"), join(rollbackData, "latest.json"), dated]) writeFileSync(path, "previous digest bytes");
    mkdirSync(join(rollbackData, "digest-receipt.json"));
    const digest = await buildDigest({ outputDir: out, generatedAt: "2026-08-01T00:00:00.000Z" });
    await expect(writeDigest(digest, rollbackCustom, rollbackData)).rejects.toThrow();
    for (const path of [join(rollbackCustom, "latest.json"), join(rollbackData, "latest.json"), dated]) expect(readFileSync(path, "utf8")).toBe("previous digest bytes");
    expect(JSON.parse(readFileSync(join(rollbackData, "digest-transfer-journal.json"), "utf8")).state).toBe("rolled-back");
  });

  test("a pending transfer is recovered before another digest can commit", async () => {
    const recoveryCustom = join(tmp, "recovery-custom"), recoveryData = join(tmp, "recovery-data"); mkdirSync(recoveryCustom); mkdirSync(recoveryData);
    const interruptedDate = "2026-07-31"; const dated = join(recoveryData, `${interruptedDate}_crescent-city_ca_digest.json`);
    writeFileSync(dated, "partially replaced bytes"); writeFileSync(join(recoveryCustom, "latest.json"), "partially replaced bytes"); writeFileSync(join(recoveryData, "latest.json"), "unexpected new copy");
    writeFileSync(join(recoveryData, "digest-transfer-journal.json"), JSON.stringify({ schemaVersion: "lifeos-transfer-journal/v1", state: "pending", destinationFingerprint: custodyHash(JSON.stringify([resolve(recoveryCustom), resolve(recoveryData)])), date: interruptedDate, sha256: custodyHash("partially replaced bytes"), before: ["previous dated copy", "previous custom copy", null] }));
    const digest = await buildDigest({ outputDir: out, generatedAt: "2026-08-01T00:00:00Z" }); const receipt = await writeDigest(digest, recoveryCustom, recoveryData);
    expect(readFileSync(dated, "utf8")).toBe("previous dated copy");
    for (const path of [receipt.datedPath, receipt.customLatest, receipt.dataLatest]) expect(custodyHash(readFileSync(path))).toBe(receipt.sha256);
    expect(readFileSync(join(recoveryData, "versions", custodyHash("previous custom copy"), "digest.json"), "utf8")).toBe("previous custom copy");
  });

  test("loadLatestJson returns null for a missing dir", async () => {
    expect(await loadLatestJson(join(tmp, "nope"), "news-")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  buildPagesSnapshot,
  exportPagesSnapshot,
  validatePagesSource,
} from "../src/pages_snapshot.ts";
import { EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health.ts";

async function put(root: string, relative: string, value: unknown): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), ".pages-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("public Pages snapshot", () => {
  test("preserves source health and publication boundaries", async () => {
    await withFixture(async root => {
      await put(root, "manifest.json", { articlePageCount: 2, sectionCount: 12 });
      await put(root, "crescent-city-code.json", { articles: [{ title: "General", sections: [{ number: "§ 1", title: "Purpose", text: "Crescent City" }] }] });
      await put(root, "news/news-2026-07-24T00.json", { items: [
        { title: "Harbor update", link: "https://example.test/harbor", source: "Fixture", pubDate: "2026-07-24T00:00:00Z" },
        { title: "Harbor update duplicate", link: "https://example.test/harbor", source: "Fixture", pubDate: "2026-07-23T00:00:00Z" },
      ] });
      await put(root, "gov_meetings/gov_meetings-2026-07-24T00.json", { items: [{ title: "Council", link: "https://example.test/agenda", source: "Council", date: "Jul 24, 2026" }] });
      await put(root, "triplicate/triplicate-2026-07-24T00.json", { items: [{ title: "Reference story", link: "https://triplicate.test/story", usagePolicy: "wrong input" }] });
      await put(root, "curated/2026-07-24.json", [{ title: "Brief", link: "https://example.test/harbor", source: "news", provider: "ollama", summary: "Grounded" }]);
      await put(root, "news/source-health.json", { sources: [{ source: "Fixture News", status: "unavailable", checkedAt: "2026-07-24T00:00:00Z", itemCount: 0, error: "fixture outage" }] });
      await put(root, "alerts/source-health.json", { sources: [{ source: "Fixture Alert", status: "empty", checkedAt: "2026-07-24T00:00:00Z", itemCount: 0 }] });
      await put(root, "alerts/composite/current.json", { level: "WARNING", assessedAt: "2026-07-24T00:00:00Z", reason: "Fixture" });

      const snapshot = await buildPagesSnapshot(root, "2026-07-24T01:00:00Z", join(root, "no-public-seed"));
      expect(snapshot.status).toBe("ok");
      expect(snapshot.healthSummary.present).toBe(1);
      expect(snapshot.healthSummary.missing).toBeGreaterThan(1);
      expect(snapshot.sourceHealth.map(source => source.status)).toContain("unavailable");
      expect(snapshot.healthSummary.missingSources).toContain("Times-Standard");
      expect(snapshot.sourceRegistry.length).toBeGreaterThan(30);
      expect(snapshot.sourceRegistryFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.sourceDiscovery?.sourceCount).toBe(snapshot.sourceRegistry.length);
      expect(snapshot.sourceDiscovery?.registryFingerprint).toBe(snapshot.sourceRegistryFingerprint);
      expect(snapshot.news).toHaveLength(1);
      expect(snapshot.triplicate[0].usagePolicy).toBe("reference-citation-only; NEVER AI-training input");
      expect(snapshot.publicationPolicy.curationInputs).not.toContain("triplicate");
      expect(snapshot.alerts.composite?.level).toBe("WARNING");
    });
  });

  test("writes a self-contained static artifact and validates it", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      await put(root, "news/source-health.json", { sources: [] });
      const destination = join(root, "pages");
      const result = await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-07-24T01:00:00Z" });
      expect(result.status).toBe("ok");
      expect(await readFile(join(destination, "index.html"), "utf8")).toContain("data/snapshot.json");
      expect(await readFile(join(destination, "data/snapshot.json"), "utf8")).toContain('"schemaVersion": "1.0.0"');
      expect(await readFile(join(destination, "data/source-registry.json"), "utf8")).toContain("municipal-code-ecode360");
      expect(await readFile(join(destination, "data/source-discovery.json"), "utf8")).toContain('"coverageGaps"');
      expect(validatePagesSource(await readFile(join(destination, "index.html"), "utf8"))).toEqual([]);
    });
  });

  test("does not manufacture availability when output is missing", async () => {
    await withFixture(async root => {
      const snapshot = await buildPagesSnapshot(root, "2026-07-24T01:00:00Z", join(root, "no-public-seed"));
      expect(snapshot.status).toBe("unavailable");
      expect(snapshot.municipalCode.available).toBe(false);
      expect(snapshot.sourceHealth.length).toBeGreaterThan(0);
      expect(snapshot.healthSummary.missing).toBe(snapshot.sourceHealth.length);
      expect(snapshot.files.code).toBeNull();
    });
  });

  test("keeps a genuine pipeline failure distinct from source coverage gaps", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      await put(root, "state/latest-pipeline-run.json", { status: "failed", runId: "fixture-run" });
      const snapshot = await buildPagesSnapshot(root, "2026-07-24T01:00:00Z", join(root, "no-public-seed"));
      expect(snapshot.status).toBe("degraded");
      expect(snapshot.healthSummary.missing).toBe(EXPECTED_SOURCE_HEALTH.length);
    });
  });
});

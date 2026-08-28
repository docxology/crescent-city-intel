import { describe, expect, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import {
  buildPagesCodeSearchIndex,
  exportPagesSnapshot,
  scoreCodeSearchEntry,
  searchPagesCodeIndex,
  PAGES_CODE_META_ARTIFACT,
} from "../src/pages_snapshot.ts";

const REALISTIC_CODE = {
  articles: [
    {
      title: "Chapter 8.18 — Noise",
      url: "https://ecode360.com/CR4918/detail?i=8118",
      sections: [
        { number: "§ 8.18.010", title: "Declaration of policy", text: "Excessive noise is a hazard to public health, welfare, and safety." },
        { number: "§ 8.18.040", title: "Specific noises prohibited", text: "No person shall create noise exceeding the limits in Table 1." },
      ],
    },
    {
      title: "Chapter 17.20 — C-1 zone",
      url: "https://ecode360.com/CR4918/detail?i=1720",
      sections: [
        { number: "§ 17.20.020", title: "Principally permitted uses", text: "Short-term rental of a dwelling unit is principally permitted in the C-1 zone, subject to a business license and zoning setback standards." },
      ],
    },
  ],
};

describe("lane D: search quality — scoring contract", () => {
  test("scoreCodeSearchEntry ranks identity above body and enforces multi-word AND", () => {
    const identity = "§ 8.18.030 general noise regulations chapter 8.18 — noise";
    const body = "the city prohibits excessive noise between the hours of";
    expect(scoreCodeSearchEntry(identity, body, ["noise"])).toBe(2);
    // every term in the body (but not identity) scores 1
    expect(scoreCodeSearchEntry("", "business license required", ["business", "license"])).toBe(1);
    // a term split across fields scores -1 (AND is per-field)
    expect(scoreCodeSearchEntry("business", "license paperwork", ["business", "license"])).toBe(-1);
    // missing a term anywhere scores -1
    expect(scoreCodeSearchEntry("noise", "unrelated", ["noise", "zoning"])).toBe(-1);
    expect(scoreCodeSearchEntry("noise", "noise", [])).toBe(-1);
  });

  test("title/number hits rank above body hits for realistic queries", () => {
    const index = buildPagesCodeSearchIndex(REALISTIC_CODE);
    const noiseHits = searchPagesCodeIndex(index, "noise", 30);
    expect(noiseHits.length).toBeGreaterThanOrEqual(2);
    expect(noiseHits[0].a).toBe("Chapter 8.18 — Noise");
    expect(searchPagesCodeIndex(index, "short-term rental", 30).some(hit => hit.n === "§ 17.20.020")).toBe(true);
    expect(searchPagesCodeIndex(index, "business license", 30).some(hit => hit.n === "§ 17.20.020")).toBe(true);
    expect(searchPagesCodeIndex(index, "zoning setback", 30).some(hit => hit.n === "§ 17.20.020")).toBe(true);
  });

  test("searchPagesCodeIndex dedupes, honors limit, and returns empty for junk queries", () => {
    const index = buildPagesCodeSearchIndex(REALISTIC_CODE);
    const hits = searchPagesCodeIndex(index, "noise", 30);
    const ids = hits.map(hit => hit.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hits.length).toBeLessThanOrEqual(30);
    expect(searchPagesCodeIndex(index, "   ", 30)).toEqual([]);
    expect(searchPagesCodeIndex(index, "zzzznonexistent", 30)).toEqual([]);
  });
});

describe("lane D: per-field shards + code-meta artifact", () => {
  test("export emits hashed title/body shards and a tiny code-meta artifact; code.html no longer needs the envelope", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pages-laned-"));
    try {
      await mkdir(join(root, "news"), { recursive: true });
      await writeFile(join(root, "news/source-health.json"), `${JSON.stringify({ sources: [] })}\n`);
      await writeFile(join(root, "crescent-city-code.json"), `${JSON.stringify(REALISTIC_CODE)}\n`);
      const destination = join(root, "pages");
      const result = await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-07-24T01:00:00Z" });
      const snapshot = JSON.parse(await readFile(join(destination, "data/snapshot.json"), "utf8"));

      const titlePath = snapshot.files.codeSearchTitleIndex;
      expect(titlePath).toMatch(/^data\/code-search-t\.[0-9a-f]{8}\.json$/);
      expect(result.files).toContain(titlePath);
      const titleShard = JSON.parse(await readFile(join(destination, titlePath), "utf8"));
      expect(titleShard.shard).toBe("t");
      expect(titleShard.entries.length).toBe(3);
      expect(Object.keys(titleShard.entries[0]).sort()).toEqual(["a", "id", "n", "t", "title", "u"]);

      const bodyPath = snapshot.files.codeSearchBodyIndex;
      expect(bodyPath).toMatch(/^data\/code-search-x\.[0-9a-f]{8}\.json$/);
      const bodyShard = JSON.parse(await readFile(join(destination, bodyPath), "utf8"));
      expect(bodyShard.shard).toBe("x");
      for (const entry of bodyShard.entries) {
        expect(Object.keys(entry).sort()).toEqual(["id", "x"]);
      }

      const titleBytes = (await readFile(join(destination, titlePath))).byteLength;
      expect(titleBytes).toBeLessThanOrEqual(700 * 1024);
      const bodyBytes = (await readFile(join(destination, bodyPath))).byteLength;
      expect(bodyBytes).toBeLessThanOrEqual(3 * 1024 * 1024);

      expect(snapshot.files.codeMeta).toBe(PAGES_CODE_META_ARTIFACT);
      const codeMeta = JSON.parse(await readFile(join(destination, PAGES_CODE_META_ARTIFACT), "utf8"));
      expect(codeMeta.schema).toBe("crescent-city-code-meta/v1");
      expect(codeMeta.available).toBe(true);
      expect(codeMeta.files.codeSearchIndex).toBe(snapshot.files.codeSearchIndex);
      expect(codeMeta.files.codeSearchTitleIndex).toBe(titlePath);
      expect(codeMeta.files.codeSearchBodyIndex).toBe(bodyPath);
      expect(codeMeta.files.code).toBe("data/code.json");
      expect((await readFile(join(destination, PAGES_CODE_META_ARTIFACT))).byteLength).toBeLessThan(1024);

      const codeHtml = await readFile(join(import.meta.dir, "../src/pages/static/code.html"), "utf8");
      expect(codeHtml).toContain('load("data/code-meta.json")');
      expect(codeHtml).not.toContain('load("data/snapshot.json")');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  test("client matcher (site.js) implements the same scoring contract as the exporter", async () => {
    const siteJs = await readFile(join(import.meta.dir, "../src/pages/static/assets/site.js"), "utf8");
    expect(siteJs).toContain("function scoreCodeSearchEntry");
    expect(siteJs).toContain("terms.every(term => identityText.includes(term)) ? 2");
    expect(siteJs).toContain("pages_snapshot.ts scoreCodeSearchEntry");
  });

  test("realistic exported code: recall/precision spot check on four queries", async () => {
    const code = JSON.parse(await readFile(join(import.meta.dir, "../pages-data/crescent-city-code.json"), "utf8"));
    const index = buildPagesCodeSearchIndex(code);
    const noise = searchPagesCodeIndex(index, "noise", 10);
    // identity matches include the dedicated noise chapter and "Noise." sections
    expect(noise.some(hit => hit.a.toLowerCase().includes("noise"))).toBe(true);
    expect(noise.some(hit => /noise/i.test(hit.title))).toBe(true);
    const license = searchPagesCodeIndex(index, "business license", 30);
    expect(license.some(hit => /business license/i.test(hit.title))).toBe(true);
    expect(searchPagesCodeIndex(index, "short-term rental", 30).length).toBeGreaterThan(0);
    expect(searchPagesCodeIndex(index, "zoning setback", 30).length).toBeGreaterThan(0);
  });
});

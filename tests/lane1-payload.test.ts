import { describe, expect, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import {
  PAGES_NEWS_ARTIFACT,
  PAGES_MEETINGS_ARTIFACT,
  PAGES_ALERTS_ARTIFACT,
  buildPagesCodeSearchIndex,
  exportPagesSnapshot,
  pagesContentHashName,
  searchPagesCodeIndex,
} from "../src/pages_snapshot.ts";

describe("lane1: payload split (Phase 1)", () => {
  test("buildPagesCodeSearchIndex shards fields without duplicating entries", () => {
    const code = {
      articles: [
        {
          title: "Chapter 1 — General",
          url: "https://ecode360.com/CR4919/detail?i=1",
          sections: [
            { number: "§ 1.01", title: "Purpose", text: "Crescent City harbor definitions apply." },
            { number: "§ 1.02", title: "Scope", text: "Applies within city limits." },
          ],
        },
      ],
    };
    const index = buildPagesCodeSearchIndex(code);
    expect(index.schema).toBe("crescent-city-code-search/v1");
    expect(index.articleCount).toBe(1);
    expect(index.sectionCount).toBe(2);
    expect(index.shards.t).toHaveLength(2);
    expect(index.shards.x).toHaveLength(2);
    for (const entry of index.shards.x) {
      expect(Object.keys(entry).sort()).toEqual(["id", "x"]);
    }
    expect(index.shards.t[0].t).toContain("purpose");
    expect(index.shards.t[0].u).toBe("https://ecode360.com/CR4919/detail?i=1");
  });

  test("searchPagesCodeIndex matches title shard and text shard, deduped by id", () => {
    const index = buildPagesCodeSearchIndex({
      articles: [{
        title: "Chapter 2 — Animals",
        url: null,
        sections: [
          { number: "§ 2.01", title: "Dogs at large", text: "No owner shall permit a dog to run at large." },
          { number: "§ 2.02", title: "Noise", text: "A dog barking habitually is a public nuisance." },
        ],
      }],
    });
    const titleHit = searchPagesCodeIndex(index, "dogs", 30);
    expect(titleHit.length).toBe(1);
    expect(titleHit[0].n).toBe("§ 2.01");
    expect(titleHit[0].x).toContain("at large");
    const textHit = searchPagesCodeIndex(index, "nuisance", 30);
    expect(textHit.length).toBe(1);
    expect(textHit[0].n).toBe("§ 2.02");
    expect(searchPagesCodeIndex(index, "   ", 30)).toEqual([]);
  });

  test("pagesContentHashName produces stable 8-hex hashed filenames (§1.6 helper)", () => {
    expect(pagesContentHashName("data/code-search.json", "abc")).toMatch(/^data\/code-search\.[0-9a-f]{8}\.json$/);
    expect(pagesContentHashName("data/code-search.json", "abc")).toBe(pagesContentHashName("data/code-search.json", "abc"));
    expect(pagesContentHashName("data/code-search.json", "abcd")).not.toBe(pagesContentHashName("data/code-search.json", "abc"));
    expect(pagesContentHashName("assets/site.css", "body{}")).toMatch(/^assets\/site\.[0-9a-f]{8}\.css$/);
  });

  test("exported artifact: envelope no longer inlines the four standalone artifacts and emits per-page + search-index files", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pages-lane1-"));
    try {
      await mkdir(join(root, "news"), { recursive: true });
      await writeFile(join(root, "news/source-health.json"), `${JSON.stringify({ sources: [] })}\n`);
      await writeFile(join(root, "crescent-city-code.json"), `${JSON.stringify({
        articles: [{ title: "Ch.1", url: "https://ecode360.com/x", sections: [{ number: "§ 1", title: "Purpose", text: "Crescent City" }] }],
      })}\n`);
      const destination = join(root, "pages");
      const result = await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-07-24T01:00:00Z" });
      const snapshot = JSON.parse(await readFile(join(destination, "data/snapshot.json"), "utf8"));
      const mc = snapshot.municipalCode;
      expect(mc.manifest).toBeUndefined();
      expect(mc.verification).toBeUndefined();
      expect(mc.coverage).toBeUndefined();
      expect(mc.readability).toBeUndefined();
      expect(mc.counts).toBeDefined();
      expect(mc.available).toBe(true);
      expect(result.files).toContain(PAGES_NEWS_ARTIFACT);
      expect(result.files).toContain(PAGES_MEETINGS_ARTIFACT);
      expect(result.files).toContain(PAGES_ALERTS_ARTIFACT);
      expect(snapshot.files.news).toBe("data/news.json");
      expect(snapshot.files.meetings).toBe("data/meetings.json");
      expect(snapshot.files.alerts).toBe("data/alerts.json");
      for (const artifact of [PAGES_NEWS_ARTIFACT, PAGES_MEETINGS_ARTIFACT, PAGES_ALERTS_ARTIFACT]) {
        const bytes = (await readFile(join(destination, artifact))).byteLength;
        expect(bytes).toBeLessThanOrEqual(150 * 1024);
      }
      const indexPath = snapshot.files.codeSearchIndex;
      expect(indexPath).toMatch(/^data\/code-search\.[0-9a-f]{8}\.json$/);
      expect(result.files).toContain(indexPath);
      const index = JSON.parse(await readFile(join(destination, indexPath), "utf8"));
      expect(index.schema).toBe("crescent-city-code-search/v1");
      expect(index.shards.x[0].x).toContain("crescent city");
      expect(index.shards.t[0].n).toBe("§ 1");
      expect(Object.keys(index.shards.x[0]).sort()).toEqual(["id", "x"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  test("no static page uses cache:\"no-store\" and code.html loads artifacts lazily", async () => {
    const files = ["index.html", "404.html", "gui.html", "news.html", "meetings.html", "events.html", "code.html", "sources.html"];
    for (const file of files) {
      const html = await readFile(join(import.meta.dir, `../src/pages/static/${file}`), "utf8");
      expect(html).not.toContain('cache:"no-store"');
      expect(html).not.toContain('cache: "no-store"');
    }
    const code = await readFile(join(import.meta.dir, "../src/pages/static/code.html"), "utf8");
    expect(code).not.toContain("load(snapshot.files.code)");
    expect(code).toContain("codeSearchIndex");
    // R3 P0.1: the search is still debounced and the index still loads lazily,
    // but through the shared debounce() and the deferred-index controller that
    // re-runs the pending query when the index arrives — the page no longer
    // owns its own setTimeout, so this asserts the behaviour, not the literal.
    expect(code).toContain("debounce(value => controller.search(");
    expect(code).toContain("createDeferredIndexSearch(");
  });
});

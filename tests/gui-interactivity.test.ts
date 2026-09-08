import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

describe("GUI interactivity contracts", () => {
  test("local GUI exposes cancellable chat and metadata-aware diagnostics", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    const chat = await readFile("src/gui/static/assets/modules/50-chat.js", "utf8");
    const feeds = await readFile("src/gui/static/assets/modules/110-feeds.js", "utf8");
    // v2.7.0: markup strings stay in index.html; JS code strings moved
    // verbatim into assets/modules/*.js.
    expect(html).toContain('id="chat-cancel"');
    expect(chat).toContain("new AbortController()");
    expect(feeds).toContain("/api/metadata");
    expect(html.includes("thinkDiv.remove()")).toBe(false);
    expect(chat.includes("thinkDiv.remove()")).toBe(false);
  });

  test("public Pages UI provides refresh and source-state filtering", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    expect(html).toContain('id="refresh"');
    expect(html).toContain('id="health-filter"');
    expect(html).toContain("snapshot.healthSummary");
    expect(html).toContain("snapshot.report.pipelineRun");
    expect(html).toContain('id="source-registry"');
    expect(html).toContain('id="automation-filter"');
    expect(html).toContain("coverageGaps");
    expect(html).toContain('id="download-registry-csv"');
    expect(html).toContain('id="source-detail"');
    expect(html).toContain("copy-fingerprint");
    expect(html).toContain('id="welcome"');
    expect(html).toContain("Find the local signal");
    expect(html).toContain("Structured public data");
    expect(html).toContain('id="geo"');
    expect(html).toContain('id="geo-map"');
    expect(html).toContain("data-pages-geo-view");
    expect(html).toContain("renderGeoIntel");
    expect(html).toContain("data/geo-intel.json");
  });

  test("local GUI exposes source coverage drill-down and structured output", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    const sources = await readFile("src/gui/static/assets/modules/80-sources.js", "utf8");
    expect(html).toContain('id="sources-toggle"');
    expect(html).toContain('id="sources-overlay"');
    expect(sources).toContain("/api/sources");
    expect(html).toContain('id="source-status-filter"');
    expect(html).toContain("source-json-download");
    expect(sources).toContain("filteredSourceCoverageRecords");
    expect(html).toContain('id="welcome-content"');
    expect(html).toContain("Local news &amp; summaries");
    expect(html).toContain("data-welcome-target=\"sources-toggle\"");
    expect(html).toContain("Official and local source hubs");
  });
});

describe("GUI nav layer and virtual scroll (v2.7.0)", () => {
  test("the nav module is wired: referenced first from index.html with hashchange and aria-current", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    const nav = await readFile("src/gui/static/assets/modules/00-nav.js", "utf8");
    expect(html).toContain('<script src="assets/modules/00-nav.js"></script>');
    expect(html.indexOf("assets/modules/00-nav.js")).toBeLessThan(html.indexOf("assets/modules/10-core.js"));
    expect(nav).toContain('addEventListener("hashchange"');
    expect(nav).toContain('aria-current');
    expect(nav).toContain('getElementById("nav-jump")');
    expect(nav).toContain('location.hash');
    expect(html).toContain('id="nav-jump"');
  });

  test("the virtual list module is applied to the search results and glossary lists", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    const virtualList = await readFile("src/gui/static/assets/virtual-list.js", "utf8");
    const search = await readFile("src/gui/static/assets/modules/30-search.js", "utf8");
    const feeds = await readFile("src/gui/static/assets/modules/110-feeds.js", "utf8");
    expect(html).toContain('<script src="assets/virtual-list.js"></script>');
    expect(virtualList).toContain("function createVirtualList(");
    expect(virtualList).toContain("ResizeObserver");
    expect(search).toContain("createVirtualList(");
    expect(search).toContain("SEARCH_VIRTUAL_THRESHOLD");
    expect(search).toContain('class="search-result" data-guid=');
    expect(feeds).toContain("createVirtualList(");
    expect(feeds).toContain("GLOSSARY_VIRTUAL_THRESHOLD");
  });
});
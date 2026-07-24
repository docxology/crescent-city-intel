import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

describe("GUI interactivity contracts", () => {
  test("local GUI exposes cancellable chat and metadata-aware diagnostics", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    expect(html).toContain('id="chat-cancel"');
    expect(html).toContain("new AbortController()");
    expect(html).toContain("/api/metadata");
    expect(html).not.toContain("thinkDiv.remove()");
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
  });

  test("local GUI exposes source coverage drill-down and structured output", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    expect(html).toContain('id="sources-toggle"');
    expect(html).toContain('id="sources-overlay"');
    expect(html).toContain("/api/sources");
    expect(html).toContain('id="source-status-filter"');
    expect(html).toContain("source-json-download");
    expect(html).toContain("filteredSourceCoverageRecords");
    expect(html).toContain('id="welcome-content"');
    expect(html).toContain("Local news &amp; summaries");
    expect(html).toContain("data-welcome-target=\"sources-toggle\"");
    expect(html).toContain("Official and local source hubs");
  });
});

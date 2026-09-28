/**
 * Phase 14 GUI surfaces: the docs/modules dashboard and the dedicated
 * structured-query pages.
 *
 * Two kinds of contract are locked here, per the TODO's acceptance criterion
 * ("each surface ships with an explicit empty state and a string-contract (or
 * browser-smoke) test"):
 *
 *  1. String contracts on the pages themselves — the empty-state markup must
 *     exist verbatim, so a surface cannot ship without saying what "nothing
 *     here" looks like.
 *  2. Real behavior of the derivation behind the dashboard endpoint
 *     (src/gui/docs_dashboard.ts): positive (real repo) and empty (no
 *     backing tree) paths, offline.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildDocsModuleIndex } from "../src/gui/docs_dashboard.ts";

const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf-8");

const dashboard = read("src", "gui", "static", "docs-dashboard.html");
const queries = read("src", "gui", "static", "structured-queries.html");
const routes = read("src", "gui", "routes.ts");
const server = read("src", "gui", "server.ts");
const spec = read("openapi.yaml");

describe("docs/modules dashboard page", () => {
  test("the page exists and renders an explicit empty state for absent backing data", () => {
    const page = read("src", "gui", "static", "docs-dashboard.html");
    expect(page).toContain('id="dashboard-empty-state"');
    expect(page).toContain("No modules found.");
    expect(page).toContain("no roster to show");
  });

  test("the page fetches the derived endpoint and renders both rosters", () => {
    const page = read("src", "gui", "static", "docs-dashboard.html");
    expect(page).toContain('"/api/docs/modules"');
    expect(page).toContain('id="modules-body"');
    expect(page).toContain('id="surfaces-body"');
    expect(page).toContain("not documented");
  });

  test("the endpoint is implemented, served, and specced", () => {
    expect(routes).toContain('path === "/api/docs/modules"');
    expect(spec).toMatch(/^ {2}\/api\/docs\/modules:$/m);
  });
});

describe("the docs derivation (src/gui/docs_dashboard.ts)", () => {
  test("against this repository: roster derived from the tree, docs surfaces cross-checked", () => {
    const report = buildDocsModuleIndex(ROOT);
    expect(report.empty).toBe(false);
    expect(report.counts.modules).toBeGreaterThan(0);
    expect(report.counts.modules).toBe(report.counts.documented + report.counts.undocumented);

    const engine = report.modules.find(m => m.file.endsWith("docs_dashboard.ts"));
    expect(engine).toBeDefined();
    const v2 = report.docsSurfaces.find(s => s.file.endsWith("v2-intelligence.md"));
    expect(v2).toBeDefined();
    expect(v2!.namesModules).toBeGreaterThan(0);

    const stale = report.docsSurfaces.flatMap(s => s.missingFiles.map(f => `${s.file}: ${f}`));
    expect(`stale docs references: ${stale.join(", ")}`).toBe("stale docs references: ");
  });

  test("empty state: a root with no src/ yields an explicit empty report, never fabricated rows", () => {
    const bare = mkdtempSync(join(tmpdir(), "docs-dash-"));
    mkdirSync(join(bare, "docs", "modules"), { recursive: true });
    const report = buildDocsModuleIndex(bare);
    expect(report.empty).toBe(true);
    expect(report.counts.modules).toBe(0);
    expect(report.counts.docsSurfaces).toBe(0);
    expect(report.modules).toEqual([]);
    expect(report.docsSurfaces).toEqual([]);
  });
});

describe("structured-query pages (Phase 14)", () => {
  test("the page exists with all three engine surfaces", () => {
    expect(queries).toContain("Legislative history");
    expect(queries).toContain("Compare sections");
    expect(queries).toContain("Similar sections");
  });

  test("each surface carries an explicit empty state, on load and on empty result", () => {
    expect(queries).toContain('id="history-empty"');
    expect(queries).toContain("No history loaded yet");
    expect(queries).toContain('id="history-empty-result"');
    expect(queries).toContain('id="compare-empty"');
    expect(queries).toContain('id="similar-empty"');
    expect(queries).toContain('id="similar-empty-result"');
    expect(queries).toContain('id="history-error"');
    expect(queries).toContain('id="compare-error"');
    expect(queries).toContain('id="similar-error"');
  });

  test("the page calls the existing structured-query endpoints", () => {
    expect(queries).toContain("/api/history/");
    expect(queries).toContain("/api/compare?guid1=");
    expect(queries).toContain("/api/similar/");
  });

  test("the server serves the page with the same loopback key injection as index.html", () => {
    expect(server).toContain('"/structured-queries.html"');
    expect(server).toContain('"/docs-dashboard.html"');
    expect(server).toContain('serveStaticHtmlWithKey("structured-queries.html", socketIp)');
    expect(server).toContain('serveStaticHtmlWithKey("docs-dashboard.html", socketIp)');
  });
});

describe("no existing contract regressed", () => {
  test("route-spec parity still holds for the new endpoint", () => {
    expect(routes).toContain('"/api/docs/modules"');
    expect(spec).toContain("  /api/docs/modules:");
  });

  test("existing route extraction is untouched", () => {
    expect(routes).toContain('path === "/api/compare"');
  });
});

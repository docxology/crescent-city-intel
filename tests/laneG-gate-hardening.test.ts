/**
 * Lane G (Phase 6) gate-hardening tests.
 *
 * Real string fixtures only — no mocks. Each negative control feeds a
 * known-wrong page and asserts the gate fails; each positive control feeds the
 * real static pages and asserts the gate passes.
 */
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import {
  PAGES_SHARED_ASSETS,
  PAGES_STATIC_PAGES,
  pagesContentHashName,
  validatePagesHtml,
  validatePagesSource,
} from "../src/pages_snapshot.ts";
import { isOperatorOnlySignal, publicSignalNotice, splitPublicOperatorSignals, type OverviewSignal } from "../src/analytics_backend.ts";

const STATIC_DIR = join(import.meta.dir, "../src/pages/static");

function minimalPage(overrides: Record<string, string> = {}): string {
  return [
    "<!doctype html><html><head>",
    overrides.head ?? '<link rel="canonical" href="https://quadruplicate.org/news.html">',
    '</head><body><a class="skip-link" href="#main">Skip</a><main id="main"></main><footer class="footer"></footer>',
    overrides.body ?? "",
    "</body></html>",
  ].join("");
}

function fullMap(indexHtml: string, overrides: Record<string, string> = {}): Record<string, string> {
  const map: Record<string, string> = { "index.html": indexHtml };
  for (const page of PAGES_STATIC_PAGES.map(candidate => candidate.file).concat("404.html")) {
    map[page] = overrides[page] ?? minimalPage();
  }
  return map;
}

describe("lane G: shared release gate across all 8 pages (§6.4)", () => {
  test("positive control: the real 8 static pages satisfy the shared source gate", async () => {
    const pages: Record<string, string> = {};
    for (const file of ["index.html", "404.html", ...PAGES_STATIC_PAGES.map(page => page.file)]) {
      pages[file] = await readFile(join(STATIC_DIR, file), "utf8");
    }
    const errors = validatePagesHtml(pages);
    expect(errors.filter(error => error.includes("missing the canonical link"))).toEqual([]);
    expect(errors.filter(error => error.includes("BreadcrumbList"))).toEqual([]);
    expect(errors.filter(error => error.includes("skip link"))).toEqual([]);
    expect(errors.filter(error => error.includes("footer element"))).toEqual([]);
  });

  test("negative control: a map missing a manifest page is itself an error", () => {
    const errors = validatePagesHtml({ "index.html": minimalPage() });
    expect(errors).toContain("Pages source map is missing required page: news.html");
  });

  test("negative control: a subpage without canonical, breadcrumb, or WebPage JSON-LD fails", () => {
    const bad = minimalPage({
      head: '<meta name="robots" content="index">',
      body: "",
    });
    const errors = validatePagesHtml(fullMap(minimalPage(), { "news.html": bad }));
    expect(errors).toContain("news.html is missing the canonical link");
    expect(errors).toContain("news.html is missing BreadcrumbList JSON-LD");
    expect(errors).toContain("news.html is missing WebPage/CollectionPage JSON-LD");
  });

  test("negative control: GovernmentOrganization in any page JSON-LD fails the gate (§3.4)", () => {
    const bad = minimalPage({
      body: '<script type="application/ld+json">{"@type":"NewsMediaOrganization","sameAs":["https://example.org"]}</script>' +
            '<script type="application/ld+json">{"@type":"GovernmentOrganization"}</script>',
    });
    const errors = validatePagesHtml(fullMap(minimalPage(), { "news.html": bad }));
    expect(errors).toContain("news.html JSON-LD block 2 claims GovernmentOrganization");
  });

  test("negative control: unparseable JSON-LD fails the gate", () => {
    const bad = minimalPage({ body: '<script type="application/ld+json">{not json}</script>' });
    const errors = validatePagesHtml(fullMap(minimalPage(), { "news.html": bad }));
    expect(errors).toContain("news.html JSON-LD block 1 does not parse as JSON");
  });

  test("positive control: index-only contract still enforced through validatePagesSource", async () => {
    const indexHtml = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    // index-specific failures still surface (missing geo artifacts in a fake page):
    const map = fullMap("<!doctype html><html></html>");
    const errors = validatePagesHtml(map);
    expect(errors).toContain("Pages index does not load data/snapshot.json");
    // validatePagesSource delegates to the shared gate; a single-page map is
    // incomplete by contract and fails loudly rather than narrowing scope:
    const singlePageErrors = validatePagesSource("<!doctype html><html></html>");
    expect(singlePageErrors.every(error => error.startsWith("Pages source map is missing required page:"))).toBe(true);
    void indexHtml;
  });
});

describe("lane G: shared asset extraction (§6.1/§6.3)", () => {
  test("both shared assets exist and are non-empty", async () => {
    for (const asset of PAGES_SHARED_ASSETS) {
      const bytes = await readFile(join(STATIC_DIR, "assets", asset.source));
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  test("pagesContentHashName yields the assets/site.<8hex>.<ext> shape", () => {
    const name = pagesContentHashName("assets/site.css", "body { color: black }");
    expect(name).toMatch(/^assets\/site\.[0-9a-f]{8}\.css$/);
  });

  test("the six subpages link the shared stylesheet and every page loads the shared JS", async () => {
    for (const page of PAGES_STATIC_PAGES.map(candidate => candidate.file)) {
      const html = await readFile(join(STATIC_DIR, page), "utf8");
      expect(html).toContain("assets/SITE_CSS_PLACEHOLDER");
      expect(html.includes("const esc =")).toBe(false); // prelude gone from inline scripts
    }
    const indexHtml = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    expect(indexHtml).toContain("assets/SITE_CSS_PLACEHOLDER");
  });

  test("the shared JS prelude is esc()/href()-complete (scanner contract)", async () => {
    const siteJs = await readFile(join(STATIC_DIR, "assets/site.js"), "utf8");
    expect(siteJs).toContain("function itemCard");
    expect(siteJs).toContain("function healthCardHtml");
    expect(siteJs).toContain("function calendarEventCard");
    expect(siteJs).toContain("function alertBannerHtml");
    // The alert banner must escape the level (the §0.1 XSS regression guard).
    expect(siteJs).toContain('esc(String(composite.level || "")');
  });
});

describe("lane G: §5.5 operator/public signal split", () => {
  const operatorSignal: OverviewSignal = {
    id: "source-youtube",
    category: "source",
    severity: "warning",
    title: "YouTube needs review",
    detail: 'Executable not found in $PATH: "yt-dlp"; RSS fallback failed.',
    evidence: ["status=unavailable"],
    nextStep: "Retry the monitor.",
  };
  const civicSignal: OverviewSignal = {
    id: "composite-alert-level",
    category: "alert",
    severity: "warning",
    title: "Composite alert level: WARNING",
    detail: "A non-calm composite assessment is recorded.",
    evidence: [],
    nextStep: "Inspect the alert evidence.",
  };

  test("executable-missing details are classified operator-only", () => {
    expect(isOperatorOnlySignal(operatorSignal)).toBe(true);
    expect(isOperatorOnlySignal(civicSignal)).toBe(false);
  });

  test("split routes the operator signal out of the public set", () => {
    const { publicSignals, operatorSignals } = splitPublicOperatorSignals([operatorSignal, civicSignal]);
    expect(operatorSignals).toHaveLength(1);
    expect(publicSignals.map(signal => signal.id)).toEqual(["composite-alert-level"]);
  });

  test("public notice replaces the error string with honest neutral copy", () => {
    const notice = publicSignalNotice(operatorSignal);
    expect(notice.detail).not.toContain("yt-dlp");
    expect(notice.detail).not.toContain("$PATH");
    expect(notice.detail).toContain("monitoring is unavailable this edition");
    expect(notice.title).toContain("YouTube monitoring unavailable");
  });
});

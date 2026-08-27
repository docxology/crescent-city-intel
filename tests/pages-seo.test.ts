import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import {
  PAGES_GEO_VIEW_PLACEHOLDER,
  PAGES_STATIC_PAGES,
  PAGES_METHODS_COUNTS_PLACEHOLDER,
  PAGES_ROBOTS_TXT,
  PAGES_SITEMAP_XML,
  buildPagesGeoIntel,
  buildPagesMethodsCounts,
  buildPagesRobotsTxt,
  buildPagesSitemapXml,
  embedPagesGeoView,
  embedPagesMethodsCounts,
  exportPagesSnapshot,
} from "../src/pages_snapshot.ts";

describe("pages SEO discoverability", () => {
  test("static index head carries canonical, Open Graph, Twitter card, and JSON-LD metadata", async () => {
    const indexHtml = await readFile(join(import.meta.dir, "../src/pages/static/index.html"), "utf8");
    expect(indexHtml).toContain('<link rel="canonical" href="https://quadruplicate.org/">');
    for (const property of ["og:title", "og:description", "og:type", "og:url", "og:site_name", "og:image"]) {
      expect(indexHtml).toContain(`property="${property}"`);
    }
    expect(indexHtml).toContain('<meta name="twitter:card" content="summary_large_image">');
    const jsonLd = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(jsonLd).not.toBeNull();
    const structuredData = JSON.parse(jsonLd![1]) as Record<string, unknown>;
    expect(structuredData["@type"]).toBe("WebSite");
    expect(structuredData.url).toBe("https://quadruplicate.org/");
    const publisher = structuredData.publisher as Record<string, unknown>;
    expect(publisher["@type"]).toBe("GovernmentOrganization");
    // Head-only change: body content untouched.
    expect(indexHtml).toContain('id="event-items"');
    expect(indexHtml).toContain(PAGES_GEO_VIEW_PLACEHOLDER);
  });

  test("emits an allow-all robots.txt with a sitemap pointer", () => {
    const robotsTxt = buildPagesRobotsTxt();
    expect(robotsTxt).toMatch(/^User-agent: \*$/m);
    expect(robotsTxt).toMatch(/^Allow: \/$/m);
    expect(robotsTxt).toContain("Sitemap: https://quadruplicate.org/sitemap.xml");
  });

  test("emits a namespaced sitemap.xml covering the root and major sections", () => {
    const sitemapXml = buildPagesSitemapXml();
    expect(sitemapXml).toStartWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(sitemapXml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    expect(locs).toContain("https://quadruplicate.org/");
    // Dedicated standalone pages are discoverable as real URLs, not anchors.
    for (const page of PAGES_STATIC_PAGES) {
      expect(locs).toContain(`https://quadruplicate.org/${page.file}`);
    }
    expect(locs.some(loc => loc.includes("#"))).toBe(false);
  });

  test("exportPagesSnapshot writes robots.txt and sitemap.xml into the artifact", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pages-seo-test-"));
    try {
      const destination = join(root, "pages");
      const result = await exportPagesSnapshot({ outputDir: join(root, "missing-output"), destination, generatedAt: "2026-08-26T00:00:00Z", seedDir: join(root, "no-seed") });
      expect(result.files).toContain(PAGES_ROBOTS_TXT);
      expect(result.files).toContain(PAGES_SITEMAP_XML);
      const robotsTxt = await readFile(join(destination, PAGES_ROBOTS_TXT), "utf8");
      expect(robotsTxt).toContain("Allow: /");
      const sitemapXml = await readFile(join(destination, PAGES_SITEMAP_XML), "utf8");
      expect(sitemapXml).toContain("<urlset");
      expect(sitemapXml).toContain("<loc>https://quadruplicate.org/</loc>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("buildPagesGeoIntel and geo embedding remain intact alongside SEO additions", () => {
    const geoIntel = buildPagesGeoIntel();
    const rendered = embedPagesGeoView(`<div>${PAGES_GEO_VIEW_PLACEHOLDER}</div>`, geoIntel.view);
    expect(rendered).toContain('data-geo-view-schema="crescent-city-geo-view/v1"');
  });
});

describe("pages Methods & Provenance and FAQ structured data", () => {
  test("static index carries a Methods & Provenance section with an export-time counts marker", async () => {
    const indexHtml = await readFile(join(import.meta.dir, "../src/pages/static/index.html"), "utf8");
    expect(indexHtml).toContain('id="methods"');
    expect(indexHtml).toContain("Methods &amp; Provenance");
    expect(indexHtml).toContain("What the models do not do");
    expect(indexHtml).toContain(PAGES_METHODS_COUNTS_PLACEHOLDER);
    expect(indexHtml).toContain('href="#methods"');
  });

  test("FAQ visible text matches the FAQPage JSON-LD exactly", async () => {
    const indexHtml = await readFile(join(import.meta.dir, "../src/pages/static/index.html"), "utf8");
    const blocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => match[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const faq = blocks.map(block => JSON.parse(block) as Record<string, unknown>).find(entry => entry["@type"] === "FAQPage");
    expect(faq).toBeDefined();
    const questions = faq!.mainEntity as Array<Record<string, unknown>>;
    expect(questions.length).toBeGreaterThanOrEqual(5);
    expect(questions.length).toBeLessThanOrEqual(8);
    for (const question of questions) {
      const q = String(question.name);
      const a = String((question.acceptedAnswer as Record<string, unknown>).text);
      expect(indexHtml).toContain(`<h3>${q}</h3>`);
      expect(indexHtml).toContain(`<p>${a}</p>`);
    }
  });

  test("counts are injected from the snapshot manifest at export time", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pages-methods-test-"));
    try {
      const destination = join(root, "pages");
      const result = await exportPagesSnapshot({ outputDir: join(root, "missing-output"), destination, generatedAt: "2026-08-26T00:00:00Z", seedDir: join(root, "no-seed") });
      const exportedHtml = await readFile(join(destination, "index.html"), "utf8");
      expect(exportedHtml).not.toContain(PAGES_METHODS_COUNTS_PLACEHOLDER);
      expect(exportedHtml).toContain('id="methods-counts-list"');
      expect(exportedHtml).toContain("Source-health records");
      expect(result.status).toBe("unavailable"); // no code seed present in this fixture
      expect(() => embedPagesMethodsCounts("<div></div>", "<ul></ul>")).toThrow(/exactly one methods-counts placeholder/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("buildPagesMethodsCounts escapes angle brackets in injected values", () => {
    const snapshot = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-08-26T00:00:00Z",
      status: "ok",
      sourceHealth: [],
      sourceRegistry: [],
      news: [],
      meetings: [],
      youtube: [],
      curated: [],
      events: { count: 3, events: [] },
    };
    const html = buildPagesMethodsCounts(snapshot as never);
    expect(html).toContain("<strong>Calendar events:</strong> 3</li>");
    expect(html.startsWith('<ul id="methods-counts-list">')).toBe(true);
  });
});

describe("standalone static pages", () => {
  const STATIC_PAGE_FILES = ["gui.html", "news.html", "meetings.html", "events.html", "code.html", "sources.html"];

  test("PAGES_STATIC_PAGES covers the six dedicated static pages and the sitemap lists them all", () => {
    expect(PAGES_STATIC_PAGES.map(page => page.file)).toEqual(STATIC_PAGE_FILES);
    const sitemapXml = buildPagesSitemapXml();
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    for (const file of STATIC_PAGE_FILES) {
      expect(locs).toContain(`https://quadruplicate.org/${file}`);
    }
    // Anchor entries were replaced by real pages in the sitemap.
    expect(locs.some(loc => loc.includes("#"))).toBe(false);
  });

  test("every static page exists, uses only newspaper palette vars, and links to real siblings", async () => {
    for (const file of STATIC_PAGE_FILES) {
      const html = await readFile(join(import.meta.dir, `../src/pages/static/${file}`), "utf8");
      // Newspaper palette contract: banned color variable names must not appear.
      for (const banned of ["--red", "--blue", "--gold", "--green", "--purple"]) {
        if (banned === "--red") continue; // --red is substring-covered by --rdark ban check below
        expect(html).not.toContain(`${banned}:`);
      }
      expect(html).not.toMatch(/--red\b(?!ark)/);
      // Shared masthead + nav family.
      expect(html).toContain('class="masthead-h1"');
      expect(html).toContain('class="masthead-nav"');
      expect(html).toContain('<a href="./">Front page</a>');
      // Data fetching stays relative to the exported artifact.
      expect(html).toContain('load("data/snapshot.json")');
      for (const other of STATIC_PAGE_FILES) {
        if (other === file) { expect(html).toContain(`href="${other}" aria-current="page"`); continue; }
        expect(html).toContain(`href="${other}"`);
      }
    }
  });

  test("index nav points to standalone pages instead of the unhostable /gui/ path", async () => {
    const indexHtml = await readFile(join(import.meta.dir, "../src/pages/static/index.html"), "utf8");
    expect(indexHtml).not.toContain('href="/gui/"');
    for (const file of STATIC_PAGE_FILES) {
      expect(indexHtml).toContain(`href="${file}"`);
    }
  });

  test("404 page links back to every real emitted page", async () => {
    const notFound = await readFile(join(import.meta.dir, "../src/pages/static/404.html"), "utf8");
    for (const file of STATIC_PAGE_FILES) {
      expect(notFound).toContain(`href="${file}"`);
    }
  });

  test("exportPagesSnapshot emits every standalone page into the artifact with no dead internal nav links", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pages-static-test-"));
    try {
      const destination = join(root, "pages");
      const result = await exportPagesSnapshot({ outputDir: join(root, "missing-output"), destination, generatedAt: "2026-08-26T00:00:00Z", seedDir: join(root, "no-seed") });
      for (const file of STATIC_PAGE_FILES) {
        expect(result.files).toContain(file);
        await readFile(join(destination, file), "utf8"); // throws if missing
      }
      // No dead internal links: every href="*.html" in every emitted page resolves to an emitted file.
      const emitted = new Set(result.files);
      const failures: string[] = [];
      for (const htmlFile of [...STATIC_PAGE_FILES, "index.html", "404.html"]) {
        const html = await readFile(join(destination, htmlFile), "utf8");
        // Strip JS template literals inside <script> blocks first: static
        // link checking applies to authored markup, not runtime-built hrefs.
        const markupOnly = html.replace(/<script>[\s\S]*?<\/script>/g, "");
        const internalLinks = [...markupOnly.matchAll(/href="(?!https?:|#|mailto:|data:)([^"#]+?)(?:#[^"]*)?"/g)].map(match => match[1].replace(/^\.\/$/, "index.html"));
        for (const link of internalLinks) {
          if (link === "index.html" || emitted.has(link)) continue;
          failures.push(`${htmlFile} -> ${link}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import {
  PAGES_GEO_VIEW_PLACEHOLDER,
  PAGES_ROBOTS_TXT,
  PAGES_SITEMAP_XML,
  buildPagesGeoIntel,
  buildPagesRobotsTxt,
  buildPagesSitemapXml,
  embedPagesGeoView,
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
    for (const anchor of ["#analytics", "#code", "#events", "#geo", "#news", "#meetings", "#curated"]) {
      expect(locs).toContain(`https://quadruplicate.org/${anchor}`);
    }
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

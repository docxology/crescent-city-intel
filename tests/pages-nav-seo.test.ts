import { describe, expect, test } from "bun:test";
import {
  PAGES_STATIC_PAGES,
  buildPagesBreadcrumbHtml,
  buildPagesFooterHtml,
  buildPagesNavHtml,
  buildPagesOgImagePng,
  buildPagesWebManifest,
  buildPagesSitemapXml,
  embedPagesBreadcrumb,
  embedPagesFooter,
  embedPagesNav,
} from "../src/pages_snapshot.ts";

describe("lane2: generated nav / breadcrumb / footer", () => {
  test("nav carries every manifest page, the front page, and section anchors with aria-current", () => {
    const nav = buildPagesNavHtml("news.html");
    expect(nav).toContain('href="./">Front page</a>');
    expect(nav).toContain('href="news.html" aria-current="page">News</a>');
    for (const page of PAGES_STATIC_PAGES) {
      const expected = page.file === "news.html" ? `href="${page.file}" aria-current="page">${page.navLabel}</a>` : `href="${page.file}">${page.navLabel}</a>`;
      expect(nav).toContain(expected);
    }
    expect(nav).toContain('href="./#geo">Geo-intel</a>');
    expect(nav).toContain('href="./#alerts">Alerts</a>');
    expect(nav).toContain('href="./#methods">Methods</a>');
    expect(nav).toContain('href="./#faq">FAQ</a>');
    expect(nav).not.toContain('aria-current="page">GUI console');
  });

  test("rootAbsolute nav emits root-absolute hrefs (404 requirement)", () => {
    const nav = buildPagesNavHtml(null, { rootAbsolute: true });
    expect(nav).toContain('href="/" aria-current="page">Front page</a>');
    expect(nav).toContain('href="/gui.html"');
    expect(nav).toContain('href="/#geo"');
    expect(nav).not.toContain('href="./');
  });

  test("breadcrumb marks the current page and links home", () => {
    expect(buildPagesBreadcrumbHtml("code.html")).toContain('<li><a href="./">Front page</a></li><li aria-current="page">Municipal code</li>');
    expect(buildPagesBreadcrumbHtml(null)).toContain('<li aria-current="page">Front page</li>');
    const abs = buildPagesBreadcrumbHtml(null, { rootAbsolute: true, label: "Page not found" });
    expect(buildPagesBreadcrumbHtml('code.html', { rootAbsolute: true })).toContain('href="/"');
    expect(abs).toContain("Page not found");
  });

  test("footer exposes the contact email and tagline (errata variant stays honest about the snapshot)", () => {
    const footer = buildPagesFooterHtml();
    expect(footer).toContain('<footer class="footer">');
    expect(footer).toContain("CrescentCity@tuta.com");
    expect(footer).toContain("Sea Something");
    const errata = buildPagesFooterHtml("errata");
    expect(errata).toContain("no live service");
    expect(errata).not.toContain("contact-line");
  });

  test("embed helpers replace exactly one authored marker and throw on drift", () => {
    const nav = '<nav class="masthead-nav" aria-label="Site pages"><a href="./">old</a></nav>';
    expect(embedPagesNav(nav, null)).toContain("Front page");
    expect(() => embedPagesNav(`${nav}${nav}`, null)).toThrow(/exactly one masthead nav/);
    const bc = '<nav class="breadcrumb" aria-label="Breadcrumb"><div class="inner"><ol><li>old</li></ol></div></nav>';
    expect(embedPagesBreadcrumb(bc, null)).toContain("Front page");
    expect(() => embedPagesBreadcrumb("", null)).toThrow(/exactly one breadcrumb/);
    const ft = '<footer class="footer"><div>old</div></footer>';
    expect(embedPagesFooter(ft)).toContain("docxology/crescent-city-intel");
    expect(() => embedPagesFooter("", "snapshot")).toThrow(/exactly one footer/);
  });
});

describe("lane2: honest sitemap lastmod (§3.7)", () => {
  test("omits lastmod entirely when no mtime mapping is supplied (never the build date)", () => {
    const sitemap = buildPagesSitemapXml();
    expect(sitemap).not.toContain("<lastmod>");
    expect(sitemap).toContain("<loc>https://quadruplicate.org/</loc>");
    for (const page of PAGES_STATIC_PAGES) {
      expect(sitemap).toContain(`<loc>https://quadruplicate.org/${page.file}</loc>`);
    }
  });

  test("emits only date-shaped lastmod values taken from the mapping", () => {
    const sitemap = buildPagesSitemapXml({ "": "2026-08-01", "news.html": "2026-08-02" });
    expect(sitemap).toContain("<loc>https://quadruplicate.org/</loc><lastmod>2026-08-01</lastmod>");
    expect(sitemap).toContain("<loc>https://quadruplicate.org/news.html</loc><lastmod>2026-08-02</lastmod>");
    expect(sitemap).toContain("<loc>https://quadruplicate.org/gui.html</loc></url>");
    // a non-date value is treated as absent rather than published
    expect(buildPagesSitemapXml({ "": "not-a-date" })).not.toContain("<lastmod>");
  });
});

describe("lane2: build-time SEO artifacts", () => {
  test("OG image is a deterministic 1200x630 PNG", () => {
    const snapshot = {
      generatedAt: "2026-08-27T00:00:00Z",
      news: Array.from({ length: 3 }, () => ({})),
      meetings: Array.from({ length: 2 }, () => ({})),
      events: { count: 5, events: [] },
      sourceHealth: Array.from({ length: 7 }, () => ({})),
    };
    const png = buildPagesOgImagePng(snapshot as never);
    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50); // 'P'
    expect(png[2]).toBe(0x4e); // 'N'
    expect(png[3]).toBe(0x47); // 'G'
    const width = png[16]! * 0x1000000 + png[17]! * 0x10000 + png[18]! * 0x100 + png[19]!;
    const height = png[20]! * 0x1000000 + png[21]! * 0x10000 + png[22]! * 0x100 + png[23]!;
    expect(width).toBe(1200);
    expect(height).toBe(630);
    // deterministic: same input, same bytes
    expect(buildPagesOgImagePng(snapshot as never)).toEqual(png);
  });

  test("web manifest carries the brand theme color", () => {
    const manifest = JSON.parse(buildPagesWebManifest()) as Record<string, unknown>;
    expect(manifest.theme_color).toBe("#c41e1e");
    expect(manifest.name).toBe("The Quadruplicate");
    expect(Array.isArray(manifest.icons)).toBe(true);
  });
});

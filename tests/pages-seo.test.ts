import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "node:os";
import {
  PAGES_GEO_VIEW_PLACEHOLDER,
  PAGES_STATIC_PAGES,
  PAGES_METHODS_COUNTS_PLACEHOLDER,
  PAGES_ROBOTS_TXT,
  PAGES_SITEMAP_XML,
  buildPagesGeoIntel,
  buildPagesSnapshot,
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
    expect(publisher["@type"]).toBe("NewsMediaOrganization");
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

  test("exportPagesSnapshot writes robots.txt and sitemap.xml into the artifact", async () => { // 120s: external-drive mkdtemp IO
    const root = await mkdtemp(join(tmpdir(), "cci-pages-seo-test-"));
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
  }, 120000);

  test("buildPagesGeoIntel and geo embedding remain intact alongside SEO additions", () => {
    const geoIntel = buildPagesGeoIntel();
    const rendered = embedPagesGeoView(`<div>${PAGES_GEO_VIEW_PLACEHOLDER}</div>`, geoIntel.view);
    expect(rendered).toContain('data-geo-view-schema="crescent-city-geo-view/v1"');
  });
});

describe("every published page carries a complete SEO surface", () => {
  // The homepage had canonical, Open Graph, Twitter and JSON-LD; the other
  // seven content pages had only a title and a description. For a public civic
  // site that is not a cosmetic gap: without a canonical URL a search engine may
  // treat near-duplicate pages as duplicates and index the wrong one, and
  // without Open Graph a shared link renders as bare text with no title,
  // description or image.
  const ORIGIN = "https://quadruplicate.org";
  const SITE = "The Quadruplicate";

  const staticPage = (name: string): string =>
    readFileSync(join(import.meta.dir, `../src/pages/static/${name}.html`), "utf8");
  // `PAGES_STATIC_PAGES` is the export list; the sitemap and the artifact must
  // agree, so derive the page set from it rather than restating seven names.

  const allPages = ["index", ...PAGES_STATIC_PAGES.map(p => p.file.replace(/\.html$/, ""))];

  for (const name of allPages) {
    test(`${name}.html declares a self-referencing canonical URL`, () => {
      const html = staticPage(name);
      const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
      expect(canonical).toBeDefined();
      // Self-referencing is the whole point: a canonical pointing somewhere
      // other than the page's own address de-indexes the page it names.
      const expected = name === "index" ? `${ORIGIN}/` : `${ORIGIN}/${name}.html`;
      expect(canonical).toBe(expected);
      expect(html).toContain(`property="og:url" content="${expected}"`);
    });

    test(`${name}.html carries the Open Graph and Twitter properties`, () => {
      const html = staticPage(name);
      for (const property of ["og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "og:image:alt"]) {
        expect(`${name} ${property}`).toBe(`${name} ${property}`);
        expect(html).toContain(`property="${property}"`);
      }
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      for (const property of ["twitter:title", "twitter:description", "twitter:image"]) {
        expect(`${name} ${property}`).toBe(`${name} ${property}`);
        expect(html).toContain(`name="${property}"`);
      }
      expect(html).toContain(`property="og:site_name" content="${SITE}"`);
    });

    test(`${name}.html has parseable JSON-LD naming the page and its publisher`, () => {
      const html = staticPage(name);
      const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(block).not.toBeNull();
      // Must be valid JSON: a malformed block is silently ignored by every
      // consumer, so the page looks fine and ranks as if it had no structured
      // data at all.
      const parsed = JSON.parse(block![1] as string) as Record<string, unknown>;
      expect(parsed["@context"]).toBe("https://schema.org");
      expect(typeof parsed["@type"]).toBe("string");
      expect(parsed.url).toContain(ORIGIN);
      const publisher = parsed.publisher as Record<string, unknown>;
      expect(publisher["@type"]).toBe("NewsMediaOrganization");
      expect(publisher.name).toBe(SITE);
    });

    test(`${name}.html's social description matches its own meta description`, () => {
      // A social card that describes something other than the page is a lie in
      // the one place a reader is deciding whether to click.
      const html = staticPage(name);
      const description = html.match(/<meta name="description" content="([^"]*)"\s*>/)?.[1];
      expect(description).toBeDefined();
      const og = html.match(/property="og:description" content="([^"]*)"/)?.[1];
      const tw = html.match(/name="twitter:description" content="([^"]*)"/)?.[1];
      expect(og).toBe(description);
      expect(tw).toBe(description);
    });

    test(`${name}.html's social title matches its own <title>`, () => {
      const html = staticPage(name);
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim();
      expect(title).toBeDefined();
      const og = html.match(/property="og:title" content="([^"]*)"/)?.[1];
      const tw = html.match(/name="twitter:title" content="([^"]*)"/)?.[1];
      const alt = html.match(/property="og:image:alt" content="([^"]*)"/)?.[1];
      expect(og).toBe(title);
      expect(tw).toBe(title);
      expect(alt).toBe(title);
    });
  }

  test("the canonical URLs are unique across pages, so none shadows another", () => {
    const canonicals = allPages.map(name => staticPage(name).match(/<link rel="canonical" href="([^"]+)">/)?.[1]);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  test("the code page advertises a SearchAction matching its own query parameter", () => {
    // A SearchAction whose template names a parameter the page does not read
    // sends searchers to a page that ignores their query.
    const html = staticPage("code");
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(block![1] as string) as Record<string, unknown>;
    const action = parsed.potentialAction as Record<string, unknown> | undefined;
    expect(action?.["@type"]).toBe("SearchAction");
    const target = action?.target as Record<string, unknown>;
    expect(String(target.urlTemplate)).toContain("q={search_term_string}");
    // And the page must actually read `q`.
    const source = readFileSync(join(import.meta.dir, "../src/pages/static/code.html"), "utf8");
    expect(source).toMatch(/searchParams\.get\("q"\)|[?&]q=/);
  });
});

describe("pages Methods & Provenance and FAQ structured data", () => {
  test("static index carries a Methods & Provenance section with an export-time counts marker", async () => {
    const indexHtml = await readFile(join(import.meta.dir, "../src/pages/static/index.html"), "utf8");
    expect(indexHtml).toContain('id="methods"');
    expect(indexHtml).toContain("Methods &amp; Provenance");
    expect(indexHtml).toContain("What the models do not do");
    expect(indexHtml).toContain(PAGES_METHODS_COUNTS_PLACEHOLDER);
    expect(indexHtml).toContain('href="./#methods"');
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

  test("counts are injected from the snapshot manifest at export time", async () => { // 120s: external-drive temp IO
    const root = await mkdtemp(join(tmpdir(), "cci-pages-methods-test-"));
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
  }, 120000);

  test("buildPagesMethodsCounts escapes angle brackets in injected values", async () => {
    const root = await mkdtemp(join(tmpdir(), "cci-pages-methods-values-"));
    try {
      const snapshot = await buildPagesSnapshot(root, "2026-08-26T00:00:00Z", join(root, "no-seed"));
      snapshot.generatedAt = "<img src=x onerror=alert(1)>";
      snapshot.events.count = 3;
      const html = buildPagesMethodsCounts(snapshot);
      expect(html).toContain("<strong>Calendar events:</strong> 3</li>");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).not.toContain("<img");
      expect(html.startsWith('<ul id="methods-counts-list">')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("standalone static pages", () => {
  const STATIC_PAGE_FILES = ["gui.html", "news.html", "meetings.html", "events.html", "directory.html", "code.html", "sources.html"];

  test("PAGES_STATIC_PAGES covers the seven dedicated static pages and the sitemap lists them all", () => {
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
      // Data fetching stays relative to the exported artifact (per-page artifacts
      // since §1.2). Assert the property, not one call shape: the page must name
      // at least one relative data/ artifact and must not fetch an absolute URL.
      // (gui.html loads its three artifacts from an array, which the old literal
      // pattern could not see even though every path in it is relative.)
      const artifactPaths = [...html.matchAll(/"(data\/[A-Za-z0-9._-]+)"/g)].map(match => match[1]);
      expect(`${file}: ${artifactPaths.length > 0}`).toBe(`${file}: true`);
      expect(html).not.toMatch(/\b(?:load|fetch)\(\s*[`'"]https?:\/\//);
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

  test("404 page links back to every real emitted page with root-absolute hrefs", async () => {
    const notFound = await readFile(join(import.meta.dir, "../src/pages/static/404.html"), "utf8");
    for (const file of STATIC_PAGE_FILES) {
      expect(notFound).toContain(`href="/${file}"`);
    }
    // §2.2: no relative internal hrefs — GitHub Pages serves 404.html at nested paths.
    const markupOnly = notFound.replace(/<script[\s\S]*?<\/script>/g, "");
    for (const href of [...markupOnly.matchAll(/href="([^"]*)"/g)].map(match => match[1])) {
      if (href.startsWith("/") || href.startsWith("#") || /^(https?:|mailto:|data:)/i.test(href)) continue;
      if (/^assets\/(?:SITE|404)_CSS_PLACEHOLDER$/.test(href)) continue; // export resolves these root-absolute (validated in scripts/validate-pages.ts)
      throw new Error(`404.html contains a relative href: ${href}`);
    }
  });

  test("exportPagesSnapshot emits every standalone page into the artifact with no dead internal nav links", async () => { // 120s: external-drive temp IO
    const root = await mkdtemp(join(tmpdir(), "cci-pages-static-test-"));
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
        const internalLinks = [...markupOnly.matchAll(/href="(?!https?:|#|mailto:|data:)([^"#]+?)(?:#[^"]*)?"/g)]
          .map(match => match[1])
          .map(link => link.startsWith("/") ? link.slice(1) : link)
          .map(link => link.replace(/^\/$/, "index.html").replace(/^\.\/$/, "index.html"))
          .map(link => link === "" ? "index.html" : link);
        for (const link of internalLinks) {
          if (link === "index.html" || emitted.has(link)) continue;
          failures.push(`${htmlFile} -> ${link}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});

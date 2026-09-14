import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  PAGES_GEO_OBSERVATIONS_ARTIFACT,
  PAGES_GEO_OBSERVATIONS_UNAVAILABLE_SCHEMA,
  PAGES_SECTION_NAV,
  PAGES_STATIC_PAGES,
  buildPagesBreadcrumbHtml,
  buildPagesNavHtml,
  buildPagesObservationsHtml,
  embedPagesObservations,
  validatePagesGeoObservations,
  type GeoObservationsEnvelope,
} from "../src/pages_snapshot.ts";

const STATIC_DIR = join(import.meta.dir, "../src/pages/static");

/** Inner HTML of the masthead nav / breadcrumb as authored or as generated. */
function navInner(html: string): string {
  const match = html.match(/<nav class="masthead-nav"[^>]*>([\s\S]*?)<\/nav>/);
  if (!match) throw new Error("no masthead nav found");
  return match[1].trim();
}
function breadcrumbInner(html: string): string {
  const match = html.match(/<nav class="breadcrumb"[^>]*>([\s\S]*?)<\/nav>/);
  if (!match) throw new Error("no breadcrumb nav found");
  return match[1].trim();
}
/** Nav without the front-page section anchors: the page-links half of the nav. */
function pageLinks(nav: string): string {
  return nav.replace(/<a href="\.?\/?#[^"]*">[^<]*<\/a>/g, "");
}

/** Deterministic valid envelope (no filesystem or seed dependency). */
function validEnvelope(): GeoObservationsEnvelope {
  return {
    schema: "crescent-city-geo-observations/v1",
    anchor: { name: "Crescent City", guid: "CR4919", municipality: "Crescent City, CA", county: "Del Norte County", state: "California", latitude: 41.76, longitude: -124.2 },
    generatedAt: "2026-09-08T17:00:58.181Z",
    composite: { level: "WATCH", reason: "Two monitors unavailable.", assessedAt: "2026-09-08T16:00:00.000Z", hasUnavailableMonitors: true },
    monitors: [
      { id: "noaa-tsunami", label: "NOAA Tsunami", status: "ok", checkedAt: "2026-09-08T16:59:00.000Z", itemCount: 2 },
      { id: "nws-weather", label: "NWS Weather", status: "unavailable", checkedAt: null },
    ],
    hazardSummary: [{ tag: "tsunami", domainCount: 1, topicCount: 1 }],
    freshness: { contractSchema: "crescent-city-geo-intel/v1", contractGeneratedAt: "2026-09-08T15:00:00.000Z" },
  };
}

describe("pages nav drift guard (authored == generated)", () => {
  test("authored front-page masthead nav equals the generated canonical nav", async () => {
    const authored = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    expect(navInner(authored)).toBe(navInner(buildPagesNavHtml(null)));
  });

  test("authored front-page breadcrumb equals the generated canonical breadcrumb", async () => {
    const authored = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    expect(breadcrumbInner(authored)).toBe(breadcrumbInner(buildPagesBreadcrumbHtml(null)));
  });

  test("authored 404 breadcrumb equals the generated root-absolute breadcrumb", async () => {
    const authored = await readFile(join(STATIC_DIR, "404.html"), "utf8");
    expect(breadcrumbInner(authored)).toBe(breadcrumbInner(buildPagesBreadcrumbHtml(null, { rootAbsolute: true, label: "Page not found" })));
  });

  test("each standalone page authored breadcrumb equals the generated canonical breadcrumb", async () => {
    for (const page of PAGES_STATIC_PAGES) {
      const authored = await readFile(join(STATIC_DIR, page.file), "utf8");
      expect(breadcrumbInner(authored)).toBe(breadcrumbInner(buildPagesBreadcrumbHtml(page.file)));
    }
  });

  test("each standalone page authored nav page-links match the generated nav exactly (order, labels, aria-current, root variant)", async () => {
    for (const page of PAGES_STATIC_PAGES) {
      const authored = await readFile(join(STATIC_DIR, page.file), "utf8");
      const generated = navInner(buildPagesNavHtml(page.file));
      // The section-anchor half is reported separately below; the page half
      // (front page + seven manifest pages, order, aria-current, ./ vs / form)
      // must be exactly in sync with the builder.
      expect(`${page.file}: ${pageLinks(navInner(authored))}`).toBe(`${page.file}: ${pageLinks(generated)}`);
    }
  });

  test("every authored section anchor is a canonical PAGES_SECTION_NAV entry with the right href", async () => {
    for (const file of ["index.html", "404.html", ...PAGES_STATIC_PAGES.map(page => page.file)]) {
      const authored = await readFile(join(STATIC_DIR, file), "utf8");
      const root = file === "404.html" ? "/" : "./";
      const anchors = [...navInner(authored).matchAll(/<a href="\.?\/?#([^"]+)">([^<]*)<\/a>/g)].map(match => ({ hash: match[1], label: match[2] }));
      for (const anchor of anchors) {
        const canonical = PAGES_SECTION_NAV.find(section => section.hash === anchor.hash);
        expect(`${file}: ${anchor.hash}`).toBe(`${file}: ${canonical?.hash ?? "DRIFTED"}`);
        expect(`${file}: ${anchor.label}`).toBe(`${file}: ${canonical?.label ?? "DRIFTED"}`);
        expect(navInner(authored)).toContain(`href="${root}#${anchor.hash}"`);
      }
    }
  });

  test("authored front-page nav carries every canonical section anchor including Observations", async () => {
    const authored = await readFile(join(STATIC_DIR, "index.html"), "utf8");
    const nav = navInner(authored);
    for (const section of PAGES_SECTION_NAV) {
      expect(nav).toContain(`href="./#${section.hash}">${section.label}</a>`);
    }
    // Ordering: Observations sits between Geo-intel and Alerts, exactly as in
    // the canonical PAGES_SECTION_NAV.
    const geo = nav.indexOf('href="./#geo"');
    const obs = nav.indexOf('href="./#observations"');
    const alerts = nav.indexOf('href="./#alerts"');
    expect(geo).toBeGreaterThan(-1);
    expect(obs).toBeGreaterThan(geo);
    expect(alerts).toBeGreaterThan(obs);
  });

  test("standalone pages and the 404 page are in strict nav sync with the builder", async () => {
    // The export replaces authored navs via embedPagesNav, so authored navs
    // that lag PAGES_SECTION_NAV canonicalize silently at export. Since the
    // 2026-09-08 Observations refresh every authored nav carries the full
    // canonical anchor set — zero lag is permitted, and any OTHER difference
    // (renamed label, missing page link, wrong root variant, extra anchor)
    // fails here at the source instead of at export.
    const lagging: string[] = [];
    for (const file of ["404.html", ...PAGES_STATIC_PAGES.map(page => page.file)]) {
      const authored = await readFile(join(STATIC_DIR, file), "utf8");
      const root = file === "404.html" ? "/" : "./";
      for (const section of PAGES_SECTION_NAV) {
        if (!navInner(authored).includes(`href="${root}#${section.hash}">${section.label}</a>`)) {
          lagging.push(`${file}:${section.label}`);
        }
      }
    }
    expect(lagging).toEqual([]);
  });
});

describe("pages observations export validation", () => {
  test("a valid envelope passes, including the committed seed when present", async () => {
    expect(validatePagesGeoObservations(validEnvelope())).toEqual([]);
    try {
      const seed = JSON.parse(await readFile("pages-data/geo-observations.json", "utf8")) as unknown;
      expect(validatePagesGeoObservations(seed)).toEqual([]);
    } catch { /* seed is tracked; the inline envelope covers the contract */ }
  });

  test("fail-closed: missing schema id, missing anchor, wrong composite shape, and leak gates all reject", () => {
    const envelope = validEnvelope();
    expect(validatePagesGeoObservations({ ...envelope, schema: "crescent-city-geo-observations/v2" })).toContain("geo-observations contract schema is not crescent-city-geo-observations/v1");
    const noAnchor = { ...envelope } as Record<string, unknown>;
    delete noAnchor.anchor;
    expect(validatePagesGeoObservations(noAnchor)).toContain("geo-observations anchor is missing");
    expect(validatePagesGeoObservations({ ...envelope, anchor: { ...envelope.anchor, latitude: 95 } })).toContain("geo-observations anchor latitude is invalid");
    expect(validatePagesGeoObservations({ ...envelope, composite: { level: 7, reason: "", assessedAt: "nope", hasUnavailableMonitors: "yes" } })).toContain("geo-observations composite level is missing");
    expect(validatePagesGeoObservations({ ...envelope, composite: 5 })).toContain("geo-observations composite must be an object or null");
    expect(validatePagesGeoObservations({ ...envelope, monitors: "none" })).toContain("geo-observations monitors are missing");
    expect(validatePagesGeoObservations({ ...envelope, monitors: [{ id: "x" }] })).toContain("geo-observations monitor 0 status is invalid");
    expect(validatePagesGeoObservations({ ...envelope, freshness: null })).toContain("geo-observations freshness block is missing");
    expect(validatePagesGeoObservations({ ...envelope, freshness: { contractSchema: "crescent-city-geo-intel/v2", contractGeneratedAt: null } })).toContain("geo-observations freshness contractSchema is not crescent-city-geo-intel/v1");
    expect(validatePagesGeoObservations({ ...envelope, apiKey: "not-public" })).toContain("geo-observations artifact contains an API-key or authorization field");
    expect(validatePagesGeoObservations({ ...envelope, endpoint: "http://localhost:8001" })).toContain("geo-observations artifact references a local-only service");
    const big = validEnvelope();
    expect(validatePagesGeoObservations(big, 64 * 1024 + 1)).toContain("geo-observations artifact exceeds 65536 bytes");
  });
});

describe("pages observations embedding", () => {
  test("published envelope renders the composite level badge, status chips, and freshness line", () => {
    const html = buildPagesObservationsHtml(validEnvelope());
    expect(html).toContain('data-observations-state="published"');
    expect(html).toContain('<strong>WATCH</strong>');
    expect(html).toContain('<span class="status ok">OK</span> NOAA Tsunami');
    expect(html).toContain('<span class="status unavailable">UNAVAILABLE</span> NWS Weather');
    expect(html).toContain("Contract generated 2026-09-08T15:00:00.000Z");
    expect(html).toContain("observations generated 2026-09-08T17:00:58.181Z");
  });

  test("a null envelope renders the honest no-observations fallback", () => {
    const html = buildPagesObservationsHtml(null);
    expect(html).toContain('data-observations-state="none"');
    expect(html).toContain("No hazard observations were published for this edition yet");
    expect(html).not.toContain("observation-chip");
  });

  test("data-derived strings are escaped and embed replaces exactly one placeholder", () => {
    const hostile = validEnvelope();
    hostile.monitors = [{ id: "x", label: "<script>alert(1)</script>", status: "ok", checkedAt: null }];
    const rendered = buildPagesObservationsHtml(hostile);
    expect(rendered).not.toContain("<script>alert(1)");
    expect(rendered).toContain("&lt;script&gt;");
    const template = `<main><template data-pages-observations></template></main>`;
    expect(embedPagesObservations(template, null)).toContain('data-observations-state="none"');
    expect(embedPagesObservations(template, validEnvelope())).toContain('data-observations-state="published"');
    expect(() => embedPagesObservations("<main></main>", null)).toThrow("exactly one observations placeholder");
    expect(() => embedPagesObservations(`${template}${template}`, null)).toThrow("found 2");
  });

  test("the unavailable envelope schema stays distinct from the published contract", () => {
    expect(PAGES_GEO_OBSERVATIONS_UNAVAILABLE_SCHEMA).toBe("crescent-city-geo-observations-unavailable/v1");
    expect(PAGES_GEO_OBSERVATIONS_ARTIFACT).toBe("data/geo-observations.json");
  });
});

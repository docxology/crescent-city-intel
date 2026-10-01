/**
 * Tests for the five 2026-09-28 expansion monitors — permits (MyGov public
 * portal), dredging (harbor sitemap), fuel (EIA weekly CA retail gasoline),
 * pacfin (PacFIN public report catalog) and ais (open-AIS FeatureCollection
 * feed). Parsers run against real captured sources in tests/fixtures/
 * (permits/, dredging/, fuel/, pacfin/, ais/ — captured live 2026-09-28),
 * plus negative controls: an empty, a garbage and a wrong-format body must
 * THROW, so extraction drift surfaces as a loud unavailable error instead of
 * a silent "nothing new". No network, no mocks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildPermitsReport,
  catalogHash,
  parsePermitCatalog,
  MYGOV_PERMITS_URL,
} from "../src/alerts/permits";
import {
  buildDredgingReport,
  matchDredgingKeywords,
  parseHarborSitemap,
  slugToTitle,
  CCHARBOR_SITEMAP_URL,
} from "../src/alerts/dredging";
import {
  buildFuelReport,
  parseEiaWeeklyPrices,
  EIA_CA_RETAIL_GAS_URL,
} from "../src/alerts/fuel";
import {
  buildPacfinReport,
  parsePacfinReportTree,
  PACFIN_DASHBOARD_URL,
} from "../src/alerts/pacfin";
import {
  buildAisReport,
  isInWatchBox,
  parseAisLocations,
  AIS_WATCH_BOX,
} from "../src/alerts/ais";
import { EXTENDED_MONITOR_SPECS, MONITOR_KEYS } from "../src/alerts/composite";
import { EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures");
const NOW = "2026-09-28T12:00:00.000Z";

describe("permits — MyGov public permit catalog", () => {
  const html = readFileSync(join(FIXTURE_DIR, "permits/mygov-permits-module-pi.html"), "utf-8");

  test("parses the real catalog with departments and login-gated apply links", () => {
    const entries = parsePermitCatalog(html);
    expect(entries.length).toBe(5);
    const overTheCounter = entries.find(entry => entry.id === "2108")!;
    expect(overTheCounter.name).toBe("Over the Counter Permit");
    expect(overTheCounter.department).toBe("Building Department");
    expect(overTheCounter.description).toContain("Minor Electrical");
    // The real page links a login popup (href="javascript;"), not a URL.
    expect(overTheCounter.applyRequiresLogin).toBe(true);
    expect(overTheCounter.applyUrl).toBe("");
  });

  test("the catalog hash is stable and order-insensitive", async () => {
    const entries = parsePermitCatalog(html);
    expect(await catalogHash(entries)).toBe(await catalogHash([...entries].reverse()));
  });

  test("an unchanged catalog is CALM; changed entries raise ADVISORY", async () => {
    const entries = parsePermitCatalog(html);
    const calm = await buildPermitsReport(entries, [], NOW);
    expect(calm.worstLevel).toBe("CALM");
    expect(calm.summary).toContain("unchanged");
    const advisory = await buildPermitsReport(entries, [{ id: "2108", name: "Over the Counter Permit", change: "edited" }], NOW);
    expect(advisory.worstLevel).toBe("ADVISORY");
    expect(advisory.summary).toContain("Over the Counter Permit (edited)");
  });

  test("NEGATIVE CONTROL: empty, garbage and wrong-module pages throw", () => {
    expect(() => parsePermitCatalog("")).toThrow("no template-element markup");
    expect(() => parsePermitCatalog("<html><body>not the permit portal</body></html>")).toThrow();
    // A page that has the string but zero entries is still drift.
    expect(() => parsePermitCatalog("template-element but nothing else")).toThrow("zero permit entries");
  });
});

describe("dredging — harbor sitemap marine-work filter", () => {
  const xml = readFileSync(join(FIXTURE_DIR, "dredging/ccharbor-sitemap.xml"), "utf-8");

  test("parses the real sitemap with urls and lastmods", () => {
    const rows = parseHarborSitemap(xml);
    expect(rows.length).toBeGreaterThan(400);
    expect(rows.every(row => row.url.startsWith("https://www.ccharbor.com/"))).toBe(true);
    expect(rows.every(row => row.lastmod === "" || /^\d{4}-\d{2}-\d{2}/.test(row.lastmod))).toBe(true);
  });

  test("the real sitemap's marine-construction posts surface in-window", () => {
    const report = buildDredgingReport(parseHarborSitemap(xml), NOW);
    expect(report.totalUrls).toBeGreaterThan(400);
    expect(report.items.length).toBeGreaterThanOrEqual(1);
    expect(report.worstLevel).toBe("ADVISORY");
    expect(report.items[0]!.url).toContain("seawall-and-citizens-dock-pier");
    expect(report.items[0]!.title).toContain("Seawall");
  });

  test("outside the window the same sitemap is an explicit empty, not an outage", () => {
    const report = buildDredgingReport(parseHarborSitemap(xml), "2020-01-01T00:00:00.000Z");
    expect(report.items).toEqual([]);
    expect(report.worstLevel).toBe("CALM");
    expect(report.summary).toContain("No harbor dredging");
  });

  test("slugToTitle strips date prefixes and title-cases", () => {
    expect(slugToTitle("https://www.ccharbor.com/2026-05-25-memorial-day")).toBe("Memorial Day");
    expect(slugToTitle("https://www.ccharbor.com/dockwa")).toBe("Dockwa");
  });

  test("dredge keywords outrank adjacent construction words", () => {
    expect(matchDredgingKeywords("https://www.ccharbor.com/2026-dredging-update").isDredging).toBe(true);
    expect(matchDredgingKeywords("https://www.ccharbor.com/new-seawall-design").isDredging).toBe(false);
    expect(matchDredgingKeywords("https://www.ccharbor.com/new-seawall-design").matchedKeywords).toContain("seawall");
  });

  test("NEGATIVE CONTROL: empty, garbage and non-sitemap bodies throw", () => {
    expect(() => parseHarborSitemap("")).toThrow("no <urlset>");
    expect(() => parseHarborSitemap("<html><body>maintenance</body></html>")).toThrow();
    expect(() => parseHarborSitemap('<?xml version="1.0"?><urlset></urlset>')).toThrow("zero URLs");
  });
});

describe("fuel — EIA weekly California retail gasoline", () => {
  const html = readFileSync(join(FIXTURE_DIR, "fuel/eia-weekly-ca-retail-gasoline.html"), "utf-8");

  test("parses the real multi-year weekly series", () => {
    const prices = parseEiaWeeklyPrices(html);
    expect(prices.length).toBeGreaterThan(1000);
    // Every row is a finite dollars-per-gallon price in a sane band.
    for (const week of prices) {
      expect(week.pricePerGallon).toBeGreaterThan(0);
      expect(week.pricePerGallon).toBeLessThan(10);
      expect(Number.isFinite(Date.parse(week.weekOf))).toBe(true);
    }
    expect(new Set(prices.map(week => week.weekOf)).size).toBe(prices.length);
    expect(prices.find(week => week.weekOf === '2026-09-21')?.pricePerGallon).toBe(6.112);
    expect(prices.filter(week => week.weekOf.startsWith('2026-09-')).map(week => week.weekOf)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });

  test("reports the latest OBSERVED week and an 8-week median", () => {
    const report = buildFuelReport(parseEiaWeeklyPrices(html), NOW);
    expect(report.latest).not.toBeNull();
    expect(report.previousWeeks.length).toBe(8);
    expect(report.medianPrice).not.toBeNull();
    expect(report.deltaVsMedian).not.toBeNull();
    // The scope note says what this is: statewide observed average.
    expect(report.scopeNote).toContain("Statewide");
    expect(report.scopeNote).toContain("not a station-level");
  });

  test("a price spike raises ADVISORY against the trailing median", () => {
    const prices = Array.from({ length: 10 }, (_, i) => ({
      weekOf: new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString(),
      pricePerGallon: 4.0,
    }));
    const calm = buildFuelReport(prices, NOW);
    expect(calm.worstLevel).toBe("CALM");
    const spike = buildFuelReport([...prices, { weekOf: new Date(Date.UTC(2026, 2, 16)).toISOString(), pricePerGallon: 6.0 }], NOW);
    expect(spike.worstLevel).toBe("ADVISORY");
    expect(spike.latest!.pricePerGallon).toBe(6.0);
  });

  test("NEGATIVE CONTROL: empty, garbage and table-less pages throw", () => {
    expect(() => parseEiaWeeklyPrices("")).toThrow("no data grid");
    expect(() => parseEiaWeeklyPrices("<html><body>error page</body></html>")).toThrow();
    expect(() => parseEiaWeeklyPrices("<html><body><td class='B6'></td></body></html>")).toThrow("zero price rows");
  });
});

describe("pacfin — public report catalog", () => {
  const html = readFileSync(join(FIXTURE_DIR, "pacfin/reports-dashboard.html"), "utf-8");

  test("parses the real embedded report tree (76 public reports)", () => {
    const reports = parsePacfinReportTree(html);
    expect(reports.length).toBe(76);
    const all001 = reports.find(report => report.label.startsWith("ALL001"))!;
    expect(all001.categoryPath).toBe("All Species Reports (ALL)");
    expect(all001.tooltip.length).toBeGreaterThan(20);
  });

  test("landing figures stay credential-gated: never a fabricated catch total", () => {
    const reports = parsePacfinReportTree(html);
    const report = buildPacfinReport(reports, [], NOW);
    expect(report.landingDataAvailable).toBe(false);
    expect(report.limitation).toContain("credentials");
    expect(report.summary).toContain("NOT read");
    expect(report.worstLevel).toBe("CALM");
    // No landing-number field exists anywhere on the report shape.
    expect(Object.keys(report).filter(key => /pounds|catch|landed/i.test(key))).toEqual([]);
  });

  test("catalog changes raise ADVISORY with the honest limitation", () => {
    const reports = parsePacfinReportTree(html);
    const report = buildPacfinReport(reports, [{ id: "9999", label: "NEW001 - New Report", change: "new" }], NOW);
    expect(report.worstLevel).toBe("ADVISORY");
    expect(report.summary).toContain("NEW001 - New Report (new)");
    expect(report.summary).toContain("NOT read");
  });

  test("NEGATIVE CONTROL: empty, garbage and tree-less dashboards throw", () => {
    expect(() => parsePacfinReportTree("")).toThrow("no report-tree JSON");
    expect(() => parsePacfinReportTree("<html><body>login required</body></html>")).toThrow();
    expect(() => parsePacfinReportTree('var gTree123Data = {"data":{"id":"root","children":[]}};')).toThrow("zero reports");
    expect(() => parsePacfinReportTree("var gTree123Data = { truncated")).toThrow("truncated");
  });
});

describe("ais — open-AIS vessel positions", () => {
  const json = readFileSync(join(FIXTURE_DIR, "ais/digitraffic-ais-locations.json"), "utf-8");

  test("parses the real captured FeatureCollection", () => {
    const positions = parseAisLocations(json);
    expect(positions.length).toBe(50);
    for (const position of positions) {
      expect(Number.isInteger(position.mmsi)).toBe(true);
      expect(position.lat).toBeGreaterThanOrEqual(-90);
      expect(position.lat).toBeLessThanOrEqual(90);
      expect(position.positionAt).not.toBeNull();
      expect(position.positionAt!.length).toBeGreaterThan(0);
    }
  });

  test("the captured foreign feed cannot establish local traffic coverage", () => {
    const positions = parseAisLocations(json);
    const report = buildAisReport(positions, NOW);
    expect(report.vesselsObserved).toBe(50);
    expect(report.vesselsInWatchArea).toEqual([]);
    expect(report.worstLevel).toBe("CALM");
    expect(report.summary).toContain("Local vessel coverage is not established");
    // The report is honest about the feed's coverage scope.
    expect(report.coversDelNorteWaters).toBe(false);
  });

  test("a vessel inside the Del Norte watch box raises ADVISORY", () => {
    const report = buildAisReport(
      [{ mmsi: 367123456, lon: -124.2, lat: 41.75, sog: 8.5, cog: 45, heading: 45, positionAt: NOW }],
      NOW,
      "configured AIS feed",
    );
    expect(report.worstLevel).toBe("ADVISORY");
    expect(report.vesselsInWatchArea.length).toBe(1);
    expect(report.coversDelNorteWaters).toBe(true);
  });

  test("watch-box bounds cover Crescent City harbor and exclude far field", () => {
    expect(isInWatchBox(-124.2026, 41.7456)).toBe(true);   // Crescent City harbor
    expect(isInWatchBox(-124.44, 41.9)).toBe(true);        // coastal approach
    expect(isInWatchBox(-124.5, 41.75)).toBe(false);       // too far west
    expect(isInWatchBox(-124.2, 42.2)).toBe(false);        // Oregon border north
    expect(isInWatchBox(21.57, 63.08)).toBe(false);        // the captured feed's waters
  });

  test("NEGATIVE CONTROL: empty, garbage, and non-FeatureCollection bodies throw", () => {
    expect(() => parseAisLocations("")).toThrow("empty body");
    expect(() => parseAisLocations("not json at all")).toThrow("not JSON");
    expect(() => parseAisLocations('{"type":"FeatureCollection","features":"nope"}')).toThrow("features array");
    expect(() => parseAisLocations('{"type":"FeatureCollection"}')).toThrow("features array");
    expect(() => parseAisLocations('{"features":[]}')).toThrow("FeatureCollection");
    expect(() => parseAisLocations('{"type":"FeatureCollection","features":[{"geometry":{"coordinates":[1,2]}}]}')).not.toThrow();
  });
});

describe("the five expansion monitors are wired into the derived rosters", () => {
  test("EXTENDED_MONITOR_SPECS carries all five with bounded-fetch provenance", () => {
    const keys = ["permits", "dredging", "fuel", "pacfin", "ais"];
    for (const key of keys) expect(MONITOR_KEYS.map(String)).toContain(key);
    const specs = EXTENDED_MONITOR_SPECS.filter(([, specKey]) => keys.includes(specKey));
    expect(specs.length).toBe(5);
    for (const [, , , url, provenance] of specs) {
      expect(url.startsWith("https://")).toBe(true);
      // Each provenance states what the connector does and does NOT read.
      expect(provenance.length).toBeGreaterThan(40);
    }
  });

  test("the coverage contract names the five new sources", () => {
    const contracted = EXPECTED_SOURCE_HEALTH
      .filter(entry => entry.monitor === "alerts")
      .map(entry => entry.source);
    for (const name of ["Crescent City Permits Portal", "Crescent City Harbor District", "EIA California Fuel", "PacFIN Reports Dashboard", "AIS Vessel Traffic"]) {
      expect(contracted).toContain(name);
    }
  });

  test("the spec URLs match the endpoints the monitors actually fetch", () => {
    const byKey = Object.fromEntries(EXTENDED_MONITOR_SPECS.map(spec => [spec[1], spec[3]]));
    expect(byKey.permits).toBe(MYGOV_PERMITS_URL);
    expect(byKey.dredging).toBe(CCHARBOR_SITEMAP_URL);
    expect(byKey.fuel).toBe(EIA_CA_RETAIL_GAS_URL);
    expect(byKey.pacfin).toBe(PACFIN_DASHBOARD_URL);
    expect(byKey.ais).toContain("digitraffic");
  });
});

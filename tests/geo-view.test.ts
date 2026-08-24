import { describe, expect, test } from "bun:test";
import { CRESCENT_CITY_ANCHOR, buildGeoIntel } from "../src/geo";
import { domains } from "../src/domains";
import { buildGeoIntelSurface, buildGeoView, type GeoPointFeature } from "../src/geo_view";

/** Build a real contract from the in-repo 12-domain surface, cast to the raw shape. */
function realContract(): Record<string, unknown> {
  return buildGeoIntel(domains) as Record<string, unknown>;
}

describe("Crescent City geospatial view-assembler", () => {
  test("buildGeoView emits the v1 schema with EPSG:4326 CRS", () => {
    const view = buildGeoView(realContract());
    expect(view.schema).toBe("crescent-city-geo-view/v1");
    expect(view.crs.type).toBe("name");
    expect(view.crs.properties.name).toBe("EPSG:4326");
  });

  test("buildGeoIntelSurface preserves the contract and adds the canonical view", () => {
    const contract = realContract();
    const surface = buildGeoIntelSurface(contract);
    expect(surface).not.toBe(contract);
    expect(contract.view).toBeUndefined();
    expect(surface.schema).toBe("crescent-city-geo-intel/v1");
    expect(surface.domainCount).toBe(contract.domainCount);
    expect(surface.view.schema).toBe("crescent-city-geo-view/v1");
    expect(surface.view.generatedAt).toBe(contract.generatedAt);
  });

  test("view carries the Crescent City / Del Norte anchor", () => {
    const view = buildGeoView(realContract());
    expect(view.anchor.name).toBe(CRESCENT_CITY_ANCHOR.name);
    expect(view.anchor.latitude).toBeCloseTo(41.76, 2);
    expect(view.anchor.longitude).toBeCloseTo(-124.2, 2);
    expect(view.anchor.bounds.west).toBeLessThan(-124);
    expect(view.anchor.bounds.east).toBeGreaterThan(-124);
  });

  test("features include a closed Del Norte bounds polygon, anchor, and hazard points", () => {
    const view = buildGeoView(realContract());
    const kinds = view.features.map((f) => f.properties.kind);
    expect(kinds).toContain("bounds");
    expect(kinds).toContain("anchor");
    expect(kinds).toContain("hazard-domain");

    const bounds = view.features.find((f) => f.properties.kind === "bounds");
    expect(bounds).toBeDefined();
    const ring = (bounds as { geometry: { coordinates: number[][][] } }).geometry.coordinates[0];
    // A GeoJSON rectangle ring must be closed: first position == last, 5 vertices.
    expect(ring.length).toBe(5);
    expect(ring[0][0]).toBe(ring[ring.length - 1][0]);
    expect(ring[0][1]).toBe(ring[ring.length - 1][1]);
  });

  test("hazard-domain points sit within bounds and are marked nominal", () => {
    const view = buildGeoView(realContract());
    const b = view.anchor.bounds;
    const hazardPoints = (view.features
      .filter((f) => f.properties.kind === "hazard-domain") as GeoPointFeature[]);
    expect(hazardPoints.length).toBeGreaterThan(0);
    for (const f of hazardPoints) {
      const [lon, lat] = f.geometry.coordinates;
      expect(lon).toBeGreaterThan(b.west);
      expect(lon).toBeLessThan(b.east);
      expect(lat).toBeGreaterThan(b.south);
      expect(lat).toBeLessThan(b.north);
      expect(f.properties.nominal).toBe(true);
      expect(f.properties.hazardTags.length).toBeGreaterThan(0);
    }
  });

  test("hazard summary reflects the contract's relevant domain count", () => {
    const view = buildGeoView(realContract());
    const contract = buildGeoIntel(domains) as { hazard: { relevantDomainCount: number } };
    expect(view.hazard.domainCount).toBe(contract.hazard.relevantDomainCount);
    // The flagship tsunami/seismic domain must surface a tsunami tag.
    expect(view.hazard.topHazardTags).toContain("tsunami");
    expect(view.hazard.hazardTags.length).toBeGreaterThan(0);
  });

  test("sections aggregate hazard-specific municipal-code refs (unique, with domains)", () => {
    const view = buildGeoView(realContract());
    expect(view.sections.length).toBeGreaterThan(0);
    const numbers = view.sections.map((s) => s.sectionNumber);
    expect(new Set(numbers).size).toBe(numbers.length); // deduplicated
    for (const s of view.sections) {
      expect(s.sectionNumber).toMatch(/§/);
      expect(s.domains.length).toBeGreaterThan(0);
      expect(s.relevance.length).toBeGreaterThan(0);
    }
  });

  test("a minimal injected hazard-domain surface builds a valid view", () => {
    const contract = buildGeoIntel([
      {
        id: "test-hazard",
        name: "Test Hazard",
        icon: "⚠️",
        description: "Test",
        updatedAt: "2026-01-01",
        topics: [
          {
            name: "Tsunami Policy",
            description: "Test topic",
            tags: ["tsunami", "evacuation"],
            sources: [{ sectionNumber: "§ 8.04", relevance: "test" }],
          },
        ],
      },
    ]) as Record<string, unknown>;
    const view = buildGeoView(contract);
    expect(view.hazard.domainCount).toBe(1);
    expect(view.hazard.hazardTags).toEqual(["tsunami"]);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].sectionNumber).toBe("§ 8.04");
    expect(view.sections[0].domains).toEqual(["Test Hazard"]);
  });

  test("view output is deterministic (modulo generatedAt) and JSON-safe", () => {
    const first = buildGeoView(realContract());
    const second = buildGeoView(realContract());
    const { generatedAt: _g1, ...firstRest } = first;
    const { generatedAt: _g2, ...secondRest } = second;
    expect(firstRest).toEqual(secondRest);
    expect(typeof JSON.stringify(first)).toBe("string");
  });
});

import { describe, expect, test } from "bun:test";
import {
  CRESCENT_CITY_ANCHOR,
  buildGeoIntel,
  buildMunicipalityContract,
  geoPaths,
  getDefaultCrescentSpec,
  hazardRelevantDomains,
} from "../src/geo";
import { domains } from "../src/domains";

describe("Crescent City geo-intel contract", () => {
  test("anchor is Crescent City / Del Norte with WGS84 coordinates", () => {
    expect(CRESCENT_CITY_ANCHOR.name).toBe("Crescent City");
    expect(CRESCENT_CITY_ANCHOR.guid).toBe("CR4919");
    expect(CRESCENT_CITY_ANCHOR.county).toBe("Del Norte County");
    // Crescent City sits at ~41.76 N, ~124.2 W.
    expect(CRESCENT_CITY_ANCHOR.latitude).toBeCloseTo(41.76, 2);
    expect(CRESCENT_CITY_ANCHOR.longitude).toBeCloseTo(-124.2, 2);
  });

  test("anchor bounds are a real county extent", () => {
    const b = CRESCENT_CITY_ANCHOR.bounds;
    expect(b.west).toBeLessThan(b.east);
    expect(b.south).toBeLessThan(b.north);
    expect(b.west).toBeLessThan(-124);
    expect(b.east).toBeGreaterThan(-124);
  });

  test("default Crescent spec returns current anchor + 12 domains as data", () => {
    const spec = getDefaultCrescentSpec();
    expect(spec.id).toBe("crescent-city-geo-intel/v1");
    expect(spec.anchor).toBe(CRESCENT_CITY_ANCHOR);
    expect(spec.domains).toHaveLength(12);
    expect(spec.domains).toBe(domains);
  });

  test("buildGeoIntel emits v1 schema + 12 domains by default", () => {
    const payload = buildGeoIntel(domains);
    expect(payload.schema).toBe("crescent-city-geo-intel/v1");
    expect(payload.domainCount).toBe(12);
    expect(payload.domains).toHaveLength(12);
  });

  test("each emitted domain carries code-section cross-refs", () => {
    const payload = buildGeoIntel(domains);
    for (const domain of payload.domains as Array<{ id: string; sections: unknown[] }>) {
      expect(domain.sections.length).toBeGreaterThan(0);
    }
  });

  test("hazard-relevant domains surface and carry hazard tags", () => {
    const relevant = hazardRelevantDomains();
    // Emergency-management is the flagship tsunami domain and must be counted.
    const ids = relevant.map((d) => d.id);
    expect(ids).toContain("emergency-management");
    for (const domain of relevant) {
      expect(domain.hazardTags.length).toBeGreaterThan(0);
      expect(domain.topics.length).toBeGreaterThan(0);
      for (const topic of domain.topics) {
        expect(topic.tags.length).toBeGreaterThan(0);
        for (const section of topic.sections) {
          expect(section.sectionNumber).toBeTruthy();
        }
      }
    }
  });

  test("geo-path contract points at pages-data seed (committed, no live output)", () => {
    expect(geoPaths.pagesSeed).toBe("pages-data/geo-intel.json");
    expect(geoPaths.liveExport).toBe("output/geo-intel.json");
  });

  test("a minimal injected domain surface builds a valid contract", () => {
    const payload = buildGeoIntel([
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
    ]);
    expect(payload.domainCount).toBe(1);
    expect(payload.domains).toHaveLength(1);
  });
});

describe("transferable municipality contract", () => {
  // A second municipality — Crescent City must not be the only city this
  // builder can serve. Any city can hand exact domains + anchor data.
  const EurekaSpec = {
    id: "eureka-geo-intel/v1",
    anchor: {
      name: "Eureka",
      guid: "EU1234",
      municipality: "Eureka, CA",
      county: "Humboldt County",
      state: "California",
      latitude: 40.802,
      longitude: -124.163,
      bounds: { west: -124.3, south: 40.6, east: -123.9, north: 41.0 },
    },
    domains: [
      {
        id: "emergency-management",
        name: "Emergency Management",
        icon: "🌊",
        description: "Tsunami + seismic policy for Eureka.",
        updatedAt: "2026-04-01",
        topics: [
          {
            name: "Tsunami Policy",
            description: "Coastal evacuation policy",
            tags: ["tsunami", "seismic"],
            sources: [{ sectionNumber: "§ 8.04", relevance: "test" }],
          },
        ],
      },
    ],
  };

  test("buildMunicipalityContract projects a second city's own anchor + domains", () => {
    const payload = buildMunicipalityContract(EurekaSpec);
    expect(payload.schema).toBe("eureka-geo-intel/v1");
    expect(payload.anchor).toBe(EurekaSpec.anchor);
    expect(payload.anchor.name).toBe("Eureka");
    expect(payload.anchor.guid).toBe("EU1234");
    expect(payload.anchor.county).toBe("Humboldt County");
    expect(payload.domainCount).toBe(1);
    expect((payload.domains as Array<{ id: string }>)[0].id).toBe("emergency-management");
    // hazard subset is derived from the spec's own domains, not the 12 default.
    const hazard = payload.hazard as { relevantDomainCount: number; relevantDomains: Array<{ id: string }> };
    expect(hazard.relevantDomainCount).toBe(1);
    expect(hazard.relevantDomains[0].id).toBe("emergency-management");
  });

  test("Crescent City default still satisfies GEO-INFER's frozen schema", () => {
    const viaSpec = buildMunicipalityContract(getDefaultCrescentSpec());
    const viaLegacy = buildGeoIntel(domains);
    expect(viaSpec.schema).toBe("crescent-city-geo-intel/v1");
    expect(viaSpec.anchor.name).toBe("Crescent City");
    expect(viaSpec.domainCount).toBe(12);
    // The legacy wrapper resolves to the same transferable builder output shape.
    expect(viaSpec.domains).toHaveLength(12);
    expect((viaLegacy.domains as Array<unknown>)).toHaveLength(12);
  });

  test("word-boundary hazard matching surfaces composite tags (flood zone, sea level rise)", () => {
    const spec = {
      id: "test/v1",
      anchor: CRESCENT_CITY_ANCHOR,
      domains: [
        {
          id: "climate-environment",
          name: "Climate",
          icon: "🌍",
          description: "Coastal climate policy",
          updatedAt: "2026-01-01",
          topics: [
            {
              name: "Sea Level Rise",
              description: "Coastal adaptation",
              tags: ["sea level rise", "flood zone", "climate adaptation"],
              sources: [{ sectionNumber: "§ 13.04", relevance: "test" }],
            },
          ],
        },
      ] as typeof domains,
    };
    const payload = buildMunicipalityContract(spec);
    const hazard = payload.hazard as { relevantDomains: Array<{ hazardTags: string[] }> };
    // Composite tags must match their hazard keyword (not substring-only).
    expect(hazard.relevantDomains).toHaveLength(1);
    const tags = hazard.relevantDomains[0].hazardTags;
    expect(tags).toContain("sea level rise");
    expect(tags).toContain("flood zone");
    expect(tags).toContain("climate adaptation");
  });

  test("word-boundary matching does not over-match on substrings (stormwater ≠ storm)", () => {
    const spec = {
      id: "test/v1",
      anchor: CRESCENT_CITY_ANCHOR,
      domains: [
        {
          id: "infrastructure",
          name: "Infrastructure",
          icon: "🏗️",
          description: "Drainage",
          updatedAt: "2026-01-01",
          topics: [
            {
              name: "Stormwater Management",
              description: "Drainage systems",
              tags: ["stormwater", "drainage"],
              sources: [{ sectionNumber: "§ 13.12", relevance: "test" }],
            },
          ],
        },
      ] as typeof domains,
    };
    const payload = buildMunicipalityContract(spec);
    const hazard = payload.hazard as { relevantDomainCount: number };
    // "stormwater" is not a storm hazard — should not surface as hazard-relevant.
    expect(hazard.relevantDomainCount).toBe(0);
  });

  test("Crescent default hazard surface now covers flood + sea level across 4 domains", () => {
    const spec = getDefaultCrescentSpec();
    const hazard = hazardRelevantDomains(spec.domains);
    expect(hazard.length).toBeGreaterThanOrEqual(4);
    const allTags = hazard.flatMap((d) => d.hazardTags);
    // The cross-cutting gap the GEO-INFER consumers flagged: flood + sea-level
    // policy must actually reach the hazard subset.
    expect(allTags.some((t) => t.includes("flood"))).toBe(true);
    expect(allTags.some((t) => t.includes("sea level"))).toBe(true);
  });
});
import { describe, expect, test } from "bun:test";
import {
  CRESCENT_CITY_ANCHOR,
  buildGeoIntel,
  geoPaths,
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

  test("anchor bounds are a real Del Norte County extent", () => {
    const b = CRESCENT_CITY_ANCHOR.bounds;
    expect(b.west).toBeLessThan(b.east);
    expect(b.south).toBeLessThan(b.north);
    expect(b.west).toBeLessThan(-124);
    expect(b.east).toBeGreaterThan(-124);
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
    // Emergency-management is the flagship pandemic/tsunami domain and must be
    // counted as hazard-relevant.
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
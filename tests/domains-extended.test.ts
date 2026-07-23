import { describe, test, expect } from "bun:test";
import { domains, getDomainById, getDomainSummaries, searchDomains } from "../src/domains.js";

describe("domains data integrity", () => {
  test("has 12 domains (9 original + 3 new)", () => {
    expect(domains.length).toBe(12);
  });

  test("all domains have required fields", () => {
    for (const d of domains) {
      expect(d.id).toBeTruthy();
      expect(d.name).toBeTruthy();
      expect(d.icon).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.topics.length).toBeGreaterThan(0);
      expect(d.updatedAt).toBeTruthy();
    }
  });

  test("all domain IDs are unique", () => {
    const ids = domains.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all topics have sources and tags", () => {
    for (const d of domains) {
      for (const t of d.topics) {
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.sources.length).toBeGreaterThan(0);
        expect(t.tags.length).toBeGreaterThan(0);
        for (const s of t.sources) {
          expect(s.sectionNumber).toBeTruthy();
          expect(s.relevance).toBeTruthy();
        }
      }
    }
  });
});

describe("new domains present", () => {
  test("climate-environment domain exists", () => {
    const d = getDomainById("climate-environment");
    expect(d).toBeDefined();
    expect(d!.name).toBe("Climate & Environment");
    expect(d!.topics.length).toBeGreaterThanOrEqual(3);
  });

  test("demographics-social domain exists", () => {
    const d = getDomainById("demographics-social");
    expect(d).toBeDefined();
    expect(d!.name).toBe("Demographics & Social Indicators");
    expect(d!.topics.length).toBeGreaterThanOrEqual(3);
  });

  test("public-health-safety domain exists", () => {
    const d = getDomainById("public-health-safety");
    expect(d).toBeDefined();
    expect(d!.name).toBe("Public Health & Safety");
    expect(d!.topics.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getDomainSummaries", () => {
  test("returns all 12 domain summaries", () => {
    const summaries = getDomainSummaries();
    expect(summaries.length).toBe(12);
    for (const s of summaries) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.topicCount).toBeGreaterThan(0);
    }
  });
});

describe("searchDomains", () => {
  test("finds domains by name keyword", () => {
    const results = searchDomains("climate");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(d => d.id === "climate-environment")).toBe(true);
  });

  test("finds domains by topic tag", () => {
    const results = searchDomains("drought");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(d => d.id === "climate-environment")).toBe(true);
  });

  test("finds health-related domains", () => {
    const results = searchDomains("mental health");
    expect(results.some(d => d.id === "public-health-safety")).toBe(true);
  });

  test("finds demographics domains by tag", () => {
    const results = searchDomains("poverty");
    expect(results.some(d => d.id === "demographics-social")).toBe(true);
  });

  test("returns empty for no match", () => {
    expect(searchDomains("xyznonexistent").length).toBe(0);
  });
});

/**
 * Recorded-fixture deterministic tests for curation enrichment (R2 lane).
 *
 * The recorded fixture below is the exact shape `queryStructured` returns
 * after parsing a real gemma3:4b structured-output response (JSON-path, one
 * repair retry available). These tests pin the enrichment contract and the
 * additive-record behavior without any live provider call.
 */
import { describe, expect, test } from "bun:test";
import {
  CURATION_PROMPT_VERSION,
  isCurationEnrichment,
  type CurationEnrichment,
} from "../src/curation";

// ── Recorded fixture: real model output shape, captured verbatim from a
//    gemma3:4b /api/chat structured run against a tsunami-advisory item. ──
const RECORDED_GEMMA3_ENRICHMENT = {
  entityTags: ["National Weather Service", "Del Norte County", "Crescent City harbor"],
  topicTags: ["tsunami", "evacuation", "emergency management"],
  salience: 0.8,
  salienceRationale:
    "An active tsunami advisory affecting the harbor directly concerns public safety in Crescent City.",
  neutralSummary:
    "The National Weather Service issued a tsunami evacuation advisory for the Crescent City harbor area.",
};

const makeItem = () => ({
  id: "https://example.com/article",
  source: "news" as const,
  title: "Tsunami Warning Issued for Del Norte Coast",
  text: "The National Weather Service issued a tsunami evacuation advisory affecting the harbor area.",
  link: "https://example.com/article",
  fetchedAt: new Date().toISOString(),
});

describe("enrichment contract (recorded fixture)", () => {
  test("prompt version moved to enriched-v3", () => {
    expect(CURATION_PROMPT_VERSION).toBe("2026-08-26-enriched-v3");
  });

  test("the recorded real-model payload validates as CurationEnrichment", () => {
    expect(isCurationEnrichment(RECORDED_GEMMA3_ENRICHMENT)).toBe(true);
  });

  test("salience bounds are enforced", () => {
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, salience: 1 })).toBe(true);
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, salience: 0 })).toBe(true);
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, salience: -0.1 })).toBe(false);
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, salience: 1.01 })).toBe(false);
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, salience: Number.NaN })).toBe(false);
  });

  test("non-string tag arrays are rejected", () => {
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, entityTags: [1, 2] })).toBe(false);
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, topicTags: "tsunami" })).toBe(false);
  });

  test("empty neutral summary or non-object payloads are rejected", () => {
    expect(isCurationEnrichment({ ...RECORDED_GEMMA3_ENRICHMENT, neutralSummary: "" })).toBe(false);
    expect(isCurationEnrichment(null)).toBe(false);
    expect(isCurationEnrichment("summary")).toBe(false);
  });

  test("fixture fields stay within the CuratedItem additive field types", () => {
    const e = RECORDED_GEMMA3_ENRICHMENT as CurationEnrichment;
    const curatedLike = {
      ...makeItem(),
      ...e,
    };
    // Additive fields land with the right runtime types on a curated record.
    expect(typeof curatedLike.salience).toBe("number");
    expect(Array.isArray(curatedLike.entityTags)).toBe(true);
    expect(curatedLike.neutralSummary.length).toBeGreaterThan(0);
  });
});

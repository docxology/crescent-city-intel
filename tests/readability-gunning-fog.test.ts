import { describe, test, expect } from "bun:test";
import { computeReadability } from "../src/shared/readability.js";

describe("computeReadability — Gunning Fog", () => {
  test("returns Gunning Fog score", () => {
    const text = "The city council shall have the authority to enact ordinances for the governance of the municipality. All ordinances shall be published in a newspaper of general circulation.";
    const score = computeReadability(text);
    expect(score).not.toBeNull();
    expect(score!.gunningFog).toBeGreaterThan(0);
    expect(score!.gunningFog).toBeLessThan(50);
  });

  test("Gunning Fog is higher for complex legal text", () => {
    const simple = "The cat sat on the mat. The dog ran fast. It was a good day for all.";
    const complex = "Notwithstanding the provisions of Section 17.04.010, the Planning Commission may authorize conditional use permits for structures within the coastal overlay district pursuant to the California Coastal Act.";
    const simpleScore = computeReadability(simple);
    const complexScore = computeReadability(complex);
    expect(simpleScore).not.toBeNull();
    expect(complexScore).not.toBeNull();
    expect(complexScore!.gunningFog).toBeGreaterThan(simpleScore!.gunningFog);
  });

  test("complexWordPct is computed", () => {
    const text = "The municipality shall provide administrative services. Notwithstanding aforementioned provisions, the commission shall adjudicate.";
    const score = computeReadability(text);
    expect(score).not.toBeNull();
    expect(score!.complexWordPct).toBeGreaterThanOrEqual(0);
  });

  test("returns null for very short text", () => {
    expect(computeReadability("Too short.")).toBeNull();
  });

  test("all score fields present", () => {
    const text = "The city council shall have the authority to enact ordinances for the governance of the municipality. All ordinances shall be published in a newspaper of general circulation within ten days of adoption.";
    const score = computeReadability(text);
    expect(score).not.toBeNull();
    expect(score).toHaveProperty("gradeLevel");
    expect(score).toHaveProperty("readingEase");
    expect(score).toHaveProperty("gunningFog");
    expect(score).toHaveProperty("complexWordPct");
    expect(score).toHaveProperty("avgSyllablesPerWord");
    expect(score).toHaveProperty("avgWordsPerSentence");
    expect(score).toHaveProperty("wordCount");
    expect(score).toHaveProperty("sentenceCount");
    expect(score).toHaveProperty("difficulty");
  });

  test("difficulty classification works", () => {
    const plain = "The cat sat. The dog ran. It was fun. Everyone was happy that day.";
    const score = computeReadability(plain);
    expect(score).not.toBeNull();
    expect(["plain", "standard", "complex", "legal"]).toContain(score!.difficulty);
  });
});

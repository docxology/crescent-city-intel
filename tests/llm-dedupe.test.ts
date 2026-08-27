/**
 * Tests for src/llm/dedupe.ts — near-duplicate detection via cosine
 * similarity. All vector math here is real arithmetic over tiny synthetic
 * vectors; no embedding provider is involved.
 */
import { describe, expect, test } from "bun:test";
import {
  cosineSimilarity,
  findNearDuplicates,
  NEAR_DUPLICATE_COSINE_THRESHOLD,
  nearDuplicateClusters,
} from "../src/llm/dedupe";

// 3-D toy vectors (direction carries the signal, magnitude scaled per case)
const EAST = [1, 0, 0];
const WEST = [-1, 0, 0];
const NORTH = [0, 1, 0];
const EAST_LONG = [10, 0, 0];

describe("cosineSimilarity", () => {
  test("identical direction → 1", () => {
    expect(cosineSimilarity(EAST, EAST)).toBeCloseTo(1);
    expect(cosineSimilarity(EAST, EAST_LONG)).toBeCloseTo(1); // magnitude-invariant
  });

  test("orthogonal → 0; opposite → -1", () => {
    expect(cosineSimilarity(EAST, NORTH)).toBeCloseTo(0);
    expect(cosineSimilarity(EAST, WEST)).toBeCloseTo(-1);
  });

  test("zero-magnitude vectors yield 0 instead of NaN", () => {
    expect(cosineSimilarity([0, 0, 0], EAST)).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  test("length mismatch throws", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/length mismatch/);
  });
});

describe("findNearDuplicates", () => {
  const existing = [
    { id: "a", vector: EAST },
    { id: "b", vector: NORTH },
    { id: "c", vector: EAST_LONG },
  ];

  test("flags same-direction items at or above the threshold", () => {
    const matches = findNearDuplicates({ id: "new", vector: EAST }, existing);
    expect(matches.map(m => m.existingId).sort()).toEqual(["a", "c"]);
    expect(matches[0].similarity).toBeGreaterThanOrEqual(NEAR_DUPLICATE_COSINE_THRESHOLD);
  });

  test("below-threshold candidates produce no matches", () => {
    expect(findNearDuplicates({ id: "new", vector: WEST }, existing)).toHaveLength(0);
  });

  test("a stricter threshold narrows results deterministically", () => {
    // EAST vs NORTH has similarity 0; only the exact-match b survives 0.99.
    const strict = findNearDuplicates({ id: "new", vector: NORTH }, existing, 0.99);
    expect(strict.map(m => m.existingId)).toEqual(["b"]);
    // A tilted vector matching nothing exactly drops out entirely.
    expect(findNearDuplicates({ id: "new2", vector: [1, 1, 0] }, existing, 0.99)).toHaveLength(0);
  });
});

describe("nearDuplicateClusters", () => {
  test("groups same-direction items and keeps first-seen canonical id", () => {
    const items = [
      { id: "first", vector: EAST },
      { id: "other-topic", vector: NORTH },
      { id: "dup-of-first", vector: EAST_LONG },
    ];
    const clusters = nearDuplicateClusters(items);
    expect(clusters).toHaveLength(2);
    const eastCluster = clusters.find(c => c.canonicalId === "first")!;
    expect(eastCluster.memberIds.sort()).toEqual(["dup-of-first", "first"]);
  });

  test("deterministic across runs on identical input order", () => {
    const items = [
      { id: "x", vector: [1, 1] },
      { id: "y", vector: [2, 2] },
      { id: "z", vector: [1, 0] },
    ];
    expect(nearDuplicateClusters(items)).toEqual(nearDuplicateClusters([...items]));
  });
});

/**
 * Tests for the readability run history (src/readability_history.ts):
 * bounded append + tail read, malformed-line skip, and the pure trend
 * builder's math with a fixed `now` (deterministic, no clock reads).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  appendReadabilityHistory,
  buildReadabilityHistoryEntry,
  buildReadabilityTrend,
  readReadabilityHistory,
  HISTORY_FILENAME,
  type ReadabilityHistoryEntry,
  type ScoredSection,
} from "../src/readability_history.ts";
import { paths } from "../src/shared/paths.ts";

const dir = join(process.cwd(), "output", "state", "readability-history-test");

function entry(over: Partial<ReadabilityHistoryEntry> = {}): ReadabilityHistoryEntry {
  return {
    runAt: "2026-09-01T00:00:00.000Z",
    asOf: null,
    fleschKincaidEase: 50,
    fleschKincaidGrade: 12,
    gunningFog: 14,
    sentenceCount: 100,
    wordCount: 2000,
    complexWordCount: 300,
    sectionCount: 40,
    ...over,
  };
}

function score(over: Partial<ScoredSection["score"]> = {}): ScoredSection["score"] {
  return {
    gradeLevel: 12,
    readingEase: 50,
    gunningFog: 14,
    complexWordPct: 15,
    avgSyllablesPerWord: 1.6,
    avgWordsPerSentence: 20,
    wordCount: 1000,
    sentenceCount: 50,
    difficulty: "complex",
    ...over,
  };
}

const DAY = 86_400_000;

beforeAll(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("appendReadabilityHistory + readReadabilityHistory", () => {
  test("append then read returns entries in chronological order", async () => {
    const file = join(dir, "history.jsonl");
    await appendReadabilityHistory(entry({ runAt: "2026-09-01T00:00:00.000Z" }), file);
    await appendReadabilityHistory(entry({ runAt: "2026-09-02T00:00:00.000Z" }), file);
    await appendReadabilityHistory(entry({ runAt: "2026-09-03T00:00:00.000Z" }), file);
    const all = readReadabilityHistory(undefined, file);
    expect(all.map((e) => e.runAt)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
    // limit returns the most-recent tail, oldest-first
    expect(readReadabilityHistory(2, file).map((e) => e.runAt)).toEqual([
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
  });

  test("append honors the bounded cap, retaining the most-recent tail", async () => {
    const file = join(dir, "capped.jsonl");
    for (let i = 0; i < 8; i++) {
      await appendReadabilityHistory(entry({ runAt: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`, wordCount: i }), file, 3);
    }
    expect(readFileSync(file, "utf-8").split("\n").filter(Boolean).length).toBe(3);
    const tail = readReadabilityHistory(undefined, file);
    expect(tail.length).toBe(3);
    expect(tail[0].wordCount).toBe(5);
    expect(tail[2].wordCount).toBe(7);
  });

  test("read skips malformed and wrong-shaped lines", () => {
    const file = join(dir, "malformed.jsonl");
    writeFileSync(file, [
      JSON.stringify(entry({ runAt: "2026-09-01T00:00:00.000Z" })),
      "not json at all",
      JSON.stringify({ runAt: "2026-09-02T00:00:00.000Z" }), // missing numeric fields
      JSON.stringify(entry({ runAt: "not-a-date" })), // invalid runAt
      JSON.stringify(entry({ runAt: "2026-09-03T00:00:00.000Z" })),
      "",
    ].join("\n"));
    const entries = readReadabilityHistory(undefined, file);
    expect(entries.map((e) => e.runAt)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
  });

  test("missing file reads as an empty history", () => {
    expect(readReadabilityHistory(undefined, join(dir, "absent.jsonl"))).toEqual([]);
  });

  test("HISTORY_FILENAME resolves through the centralized output-root seam", () => {
    expect(paths.readabilityHistory.endsWith(HISTORY_FILENAME)).toBe(true);
  });
});

describe("buildReadabilityHistoryEntry", () => {
  test("aggregates per-section scores into one run entry", () => {
    const entry = buildReadabilityHistoryEntry(
      [
        { number: "1.1", title: "A", score: score({ readingEase: 40, gradeLevel: 14, gunningFog: 16, wordCount: 1000, sentenceCount: 50, complexWordPct: 20 }) },
        { number: "1.2", title: "B", score: score({ readingEase: 60, gradeLevel: 10, gunningFog: 12, wordCount: 2000, sentenceCount: 150, complexWordPct: 10 }) },
      ],
      "2026-09-01T12:00:00.000Z",
    );
    expect(entry.runAt).toBe("2026-09-01T12:00:00.000Z");
    expect(entry.asOf).toBeNull();
    expect(entry.fleschKincaidEase).toBe(50);
    expect(entry.fleschKincaidGrade).toBe(12);
    expect(entry.gunningFog).toBe(14);
    expect(entry.wordCount).toBe(3000);
    expect(entry.sentenceCount).toBe(200);
    expect(entry.complexWordCount).toBe(400); // 1000*0.20 + 2000*0.10
    expect(entry.sectionCount).toBe(2);
  });

  test("empty scored list yields an honest zero run", () => {
    const e = buildReadabilityHistoryEntry([], "2026-09-01T00:00:00.000Z");
    expect(e.fleschKincaidEase).toBe(0);
    expect(e.sectionCount).toBe(0);
    expect(e.wordCount).toBe(0);
  });
});

describe("buildReadabilityTrend", () => {
  const now = "2026-09-08T00:00:00.000Z";

  test("empty input yields the honest empty state", () => {
    expect(buildReadabilityTrend([])).toEqual({
      count: 0,
      latest: null,
      previous: null,
      delta: null,
      buckets: [],
      earliestRunAt: null,
      latestRunAt: null,
    });
  });

  test("single entry: delta is null and one bucket holds the run", () => {
    const t = buildReadabilityTrend([entry()], { now, windowDays: 30 });
    expect(t.count).toBe(1);
    expect(t.latest).not.toBeNull();
    expect(t.previous).toBeNull();
    expect(t.delta).toBeNull();
    expect(t.earliestRunAt).toBe(t.latestRunAt);
    expect(t.buckets.length).toBe(1);
    expect(t.buckets[0].runs).toBe(1);
    expect(t.buckets[0].avgEase).toBe(50);
  });

  test("multiple entries: delta signs and bucket averages with a fixed now", () => {
    const t = buildReadabilityTrend(
      [
        entry({ runAt: new Date(Date.parse(now) - 40 * DAY).toISOString(), fleschKincaidEase: 50, fleschKincaidGrade: 14, gunningFog: 16 }),
        entry({ runAt: new Date(Date.parse(now) - 35 * DAY).toISOString(), fleschKincaidEase: 54, fleschKincaidGrade: 13, gunningFog: 15 }),
        entry({ runAt: new Date(Date.parse(now) - 10 * DAY).toISOString(), fleschKincaidEase: 60, fleschKincaidGrade: 12, gunningFog: 14 }),
      ],
      { now, windowDays: 30 },
    );
    expect(t.count).toBe(3);
    expect(t.delta).toEqual({ ease: 6, grade: -1, fog: -1 });
    // Newest 30-day window holds only the 10-day-old run
    expect(t.buckets.length).toBe(2);
    const [older, newest] = t.buckets;
    expect(newest.runs).toBe(1);
    expect(newest.avgEase).toBe(60);
    expect(older.runs).toBe(2);
    expect(older.avgEase).toBe(52); // (50 + 54) / 2
    expect(t.buckets[0].windowStart < t.buckets[1].windowStart).toBe(true);
    expect(t.earliestRunAt).toBe(new Date(Date.parse(now) - 40 * DAY).toISOString());
    expect(t.latestRunAt).toBe(new Date(Date.parse(now) - 10 * DAY).toISOString());
  });

  test("input order does not matter: latest is the newest runAt", () => {
    const a = entry({ runAt: "2026-09-01T00:00:00.000Z", fleschKincaidEase: 40 });
    const b = entry({ runAt: "2026-09-05T00:00:00.000Z", fleschKincaidEase: 55 });
    const t = buildReadabilityTrend([b, a], { windowDays: 30 });
    expect(t.latest?.runAt).toBe("2026-09-05T00:00:00.000Z");
    expect(t.previous?.runAt).toBe("2026-09-01T00:00:00.000Z");
    expect(t.delta?.ease).toBe(15);
  });
});

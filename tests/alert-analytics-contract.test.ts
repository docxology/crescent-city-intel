/**
 * Cross-module contract test: the alert monitors must persist history to the
 * exact JSONL paths the analytics layer (src/alert_analytics.ts) reads.
 *
 * Regression: noaa_tides.ts wrote `tide-history.jsonl` (a filename nothing
 * read) while alert_analytics reads `output/tides/history.jsonl`, and
 * cdfw_fishing.ts wrote no history file at all — so the unified alert
 * timeline silently omitted tides AND fishing events. This test locks both
 * the path constants and that buildAlertAnalytics() actually ingests lines
 * written to those paths.
 */
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { buildAlertAnalytics } from "../src/alert_analytics.ts";
import { tidesHistoryPath } from "../src/alerts/noaa_tides.ts";
import { fishingHistoryPath } from "../src/alerts/cdfw_fishing.ts";
import { outputRoot } from "../src/shared/paths.ts";
import { tmpdir } from "os";
import { beginCorpusCopy, endCorpusCopy } from "./helpers/output-root.ts";

// The fixtures land in a throwaway copy of the corpus, not in the real one.
beforeAll(async () => { await beginCorpusCopy(); }, 120000);
afterAll(async () => { await endCorpusCopy(); }, 60000);

const cwd = process.cwd();
// Resolved through the seam at call time, so beginCorpusCopy() below sends both
// the fixture writes and buildAlertAnalytics()'s reads into a throwaway copy.
// The exported *_HISTORY_PATH constants freeze the root at import time, which is
// why the assertion below compares them rather than writing through them.
const tidesPath = (): string => join(outputRoot(), "tides", "history.jsonl");
const fishingPath = (): string => join(outputRoot(), "fishing", "history.jsonl");


describe("alert-analytics path contract", () => {
  test("monitors write to the exact history.jsonl filenames alert_analytics reads", () => {
    // The contract that matters is that the writer's path and the reader's path
    // are the same file, and that both follow the artifact-root seam — not that
    // either is spelled as an absolute string. (They used to be absolute
    // literals, which pinned monitors to the real corpus even under a test that
    // redirected the root.)
    expect(tidesHistoryPath()).toBe(join(outputRoot(), "tides", "history.jsonl"));
    expect(fishingHistoryPath()).toBe(join(outputRoot(), "fishing", "history.jsonl"));
    const redirected = join(tmpdir(), "cci-seam-check");
    // Restore the PREVIOUS value, not the unset state: this file runs inside a
    // corpus copy, and deleting the variable pointed every later test in the
    // file back at the real corpus (which the output fence duly caught).
    const previous = process.env.CC_OUTPUT_DIR;
    process.env.CC_OUTPUT_DIR = redirected;
    try {
      expect(outputRoot()).toBe(redirected);
    } finally {
      if (previous === undefined) delete process.env.CC_OUTPUT_DIR;
      else process.env.CC_OUTPUT_DIR = previous;
    }
  });

  test("tides and fishing history lines reach the unified alert timeline", () => {
    mkdirSync(join(outputRoot(), "tides"), { recursive: true });
    mkdirSync(join(outputRoot(), "fishing"), { recursive: true });
    writeFileSync(tidesPath(), `${JSON.stringify({ fetchedAt: "2026-01-01T12:00:00.000Z", maxPredictedLevel: 7.2, highTideAlert: true, level: "WARNING", summary: "test tide line" })}\n`);
    writeFileSync(fishingPath(), `${JSON.stringify({ fetchedAt: "2026-01-01T13:00:00.000Z", level: "WATCH", summary: "test fishing line" })}\n`);

    const report = buildAlertAnalytics();
    const tides = report.timeline.filter((e) => e.type === "tides" && e.description.includes("test tide line"));
    const fishing = report.timeline.filter((e) => e.type === "fishing" && e.description.includes("test fishing line"));
    expect(tides.length).toBeGreaterThan(0);
    expect(fishing.length).toBeGreaterThan(0);
  });
});

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
import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { buildAlertAnalytics } from "../src/alert_analytics.ts";
import { TIDES_HISTORY_PATH } from "../src/alerts/noaa_tides.ts";
import { FISHING_HISTORY_PATH } from "../src/alerts/cdfw_fishing.ts";

const cwd = process.cwd();
const tidesPath = join(cwd, "output", "tides", "history.jsonl");
const fishingPath = join(cwd, "output", "fishing", "history.jsonl");

function snapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}
function restore(path: string, prev: string | null): void {
  if (prev !== null) writeFileSync(path, prev);
  else if (existsSync(path)) rmSync(path);
}
const tidesPrev = snapshot(tidesPath);
const fishingPrev = snapshot(fishingPath);

describe("alert-analytics path contract", () => {
  test("monitors write to the exact history.jsonl filenames alert_analytics reads", () => {
    expect(TIDES_HISTORY_PATH).toBe(join(cwd, "output", "tides", "history.jsonl"));
    expect(FISHING_HISTORY_PATH).toBe(join(cwd, "output", "fishing", "history.jsonl"));
  });

  test("tides and fishing history lines reach the unified alert timeline", () => {
    mkdirSync(join(cwd, "output", "tides"), { recursive: true });
    mkdirSync(join(cwd, "output", "fishing"), { recursive: true });
    writeFileSync(tidesPath, (tidesPrev ?? "") + `\n${JSON.stringify({ fetchedAt: "2026-01-01T12:00:00.000Z", maxPredictedLevel: 7.2, highTideAlert: true, level: "WARNING", summary: "test tide line" })}\n`);
    writeFileSync(fishingPath, (fishingPrev ?? "") + `\n${JSON.stringify({ fetchedAt: "2026-01-01T13:00:00.000Z", level: "WATCH", summary: "test fishing line" })}\n`);

    const report = buildAlertAnalytics();
    const tides = report.timeline.filter((e) => e.type === "tides" && e.description.includes("test tide line"));
    const fishing = report.timeline.filter((e) => e.type === "fishing" && e.description.includes("test fishing line"));
    expect(tides.length).toBeGreaterThan(0);
    expect(fishing.length).toBeGreaterThan(0);
  });
});

afterAll(() => {
  restore(tidesPath, tidesPrev);
  restore(fishingPath, fishingPrev);
});

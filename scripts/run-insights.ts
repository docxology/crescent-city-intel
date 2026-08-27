#!/usr/bin/env bun
/**
 * Round-2 civic insights CLI — computes cross-artifact intelligence trends,
 * coverage gaps, and (with `--llm`) LLM-phrased narratives for the top 3.
 * Writes output/state/civic-insights.json and prints a compact summary.
 */
import { buildInsightReport, writeCivicInsights } from "../src/insights.ts";

const polish = Bun.argv.includes("--llm");
const windowFlag = Bun.argv.indexOf("--window-days");
const windowDays = windowFlag !== -1 ? Number(Bun.argv[windowFlag + 1]) : undefined;

if (!Number.isNaN(windowDays) && windowDays !== undefined && (windowDays < 1 || !Number.isInteger(windowDays))) {
  console.error("--window-days must be a positive integer");
  process.exit(1);
}

const report = await buildInsightReport({
  polish,
  ...(windowDays !== undefined && !Number.isNaN(windowDays) ? { windowDays } : {}),
});
await writeCivicInsights(report);

console.log(JSON.stringify({
  schemaVersion: report.schemaVersion,
  generatedAt: report.generatedAt,
  windowDays: report.windowDays,
  narrative: report.narrative,
  topCount: report.top.length,
  coverageGapCount: report.coverageGaps.length,
  top: report.top.map(entry => ({ rank: entry.rank, domainId: entry.domainId, direction: entry.direction, deltaTotal: entry.deltaTotal })),
}, null, 2));

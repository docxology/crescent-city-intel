#!/usr/bin/env bun
/** Repair known malformed generated history records and migrate runtime envelopes. */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { buildPipelineRun, createRunId } from "../src/shared/orchestration.ts";
import { paths } from "../src/shared/paths.ts";
import { writeJsonAtomic, writeTextAtomic } from "../src/shared/source_health.js";
import type { SourceHealth } from "../src/types.ts";

const marineHistory = join(process.cwd(), "output", "alerts", "marine", "history.jsonl");

if (existsSync(marineHistory)) {
  const repaired: string[] = [];
  const quarantined: string[] = [];
  for (const line of readFileSync(marineHistory, "utf-8").split(/\r?\n/).filter(Boolean)) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
      const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : "";
      const year = Number(timestamp.slice(0, 4));
      const fetchedYear = Number(fetchedAt.slice(0, 4));
      if (year > 2100 && fetchedYear >= 2000 && fetchedYear <= 2100) {
        const corrected = `${fetchedYear}${timestamp.slice(4)}`;
        record.timestamp = corrected;
        if (typeof record.id === "string") record.id = record.id.replace(timestamp, corrected);
      }
      const correctedYear = Number(String(record.timestamp ?? "").slice(0, 4));
      if (correctedYear < 2000 || correctedYear > 2100) {
        quarantined.push(line);
        continue;
      }
      repaired.push(JSON.stringify(record));
    } catch {
      quarantined.push(line);
    }
  }

  await writeTextAtomic(marineHistory, `${repaired.join("\n")}\n`);
  if (quarantined.length > 0) {
    await writeTextAtomic(`${marineHistory}.quarantine`, `${quarantined.join("\n")}\n`);
  }
  console.log(`Marine history repaired: ${repaired.length} retained, ${quarantined.length} quarantined.`);
} else {
  console.log("No marine history found; continuing with runtime-artifact migrations.");
}

function validTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

async function readHealth(path: string): Promise<SourceHealth[]> {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { sources?: SourceHealth[] };
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

async function migrateLegacyWeeklySummary(): Promise<void> {
  if (!existsSync(paths.weeklyCheckSummary)) return;
  const legacy = JSON.parse(readFileSync(paths.weeklyCheckSummary, "utf-8")) as Record<string, unknown>;
  if (legacy.schemaVersion === "1.0.0" && typeof legacy.runId === "string" && Array.isArray(legacy.steps)) return;

  const migratedAt = new Date().toISOString();
  const startedAt = validTimestamp(legacy.startedAt, migratedAt);
  const completedAt = validTimestamp(legacy.completedAt, migratedAt);
  const exitCode = typeof legacy.exitCode === "number" ? legacy.exitCode : 1;
  // Legacy source-gap counters describe coverage, not a failed pipeline.
  const status = exitCode >= 2 ? "failed" : "ok";
  const stepStatus = status === "failed" ? "failed" : status === "degraded" ? "degraded" : "ok";
  const runId = createRunId("weekly-check-legacy", startedAt);
  const sources = (await Promise.all([
    paths.alertsHealth,
    paths.newsHealth,
    paths.govMeetingsHealth,
    paths.youtubeHealth,
    paths.triplicateHealth,
  ].map(readHealth))).flat();
  const pipelineRun = buildPipelineRun(
    "weekly-check",
    runId,
    startedAt,
    [{
      name: "legacy-weekly-check",
      status: stepStatus,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      metadata: { migratedFrom: "pre-1.0.0-weekly-check-summary" },
    }],
    sources,
    exitCode,
    completedAt,
  );
  const quarantinePath = join(paths.state, "quarantine", `weekly-check-summary-${Date.now()}.legacy.json`);
  await writeJsonAtomic(quarantinePath, legacy);
  await writeJsonAtomic(paths.pipelineRun, pipelineRun);
  await writeJsonAtomic(paths.weeklyCheckSummary, {
    ...legacy,
    schemaVersion: "1.0.0",
    runId,
    pipeline: "weekly-check",
    status,
    steps: pipelineRun.steps,
    sourceHealth: pipelineRun.sourceHealth,
    metadata: pipelineRun.metadata,
    legacyMigratedAt: migratedAt,
    legacyQuarantinePath: quarantinePath,
  });
  console.log(`Migrated legacy weekly summary to ${paths.weeklyCheckSummary}; original quarantined at ${quarantinePath}.`);
}

await migrateLegacyWeeklySummary();

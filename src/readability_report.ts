/** Corpus readability snapshot and history through the shared output root. */
import { scoreCorpusReadability } from "./shared/readability.js";
import { appendReadabilityHistory, buildReadabilityHistoryEntry } from "./readability_history.js";
import { loadAllSections } from "./shared/data.js";
import { createLogger } from "./logger.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { outputRoot } from "./shared/paths.js";
import { join } from "node:path";
export async function writeReadabilityReport(options: { args?: string[] } = {}) {
const logger = createLogger("run-readability");

const args = options.args ?? [];
if (args.some(arg => !["--hardest", "--easiest"].includes(arg) && !/^--limit=[1-9]\d*$/.test(arg))) throw new Error("Supported readability arguments: --hardest --easiest --limit=N (positive integer)");
const limitArg = args.find(a => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.replace("--limit=", ""), 10) : undefined;
if (limit !== undefined && (!Number.isSafeInteger(limit) || limit > 10000)) throw new Error("Readability limit must be 1..10000");
const hardest = args.includes("--hardest");
const easiest = args.includes("--easiest");

logger.info("=== Municipal Code Readability Scoring ===");

const sections = await loadAllSections();
logger.info(`Scoring ${sections.length} sections...`);

const scored = scoreCorpusReadability(sections); // sorted hardest → easiest

const computedAt = new Date().toISOString();
await writeJsonAtomic(join(outputRoot(), "readability.json"), {
  computedAt,
  totalSections: sections.length,
  scored: scored.length,
  averageGradeLevel: scored.length > 0
    ? Math.round(scored.reduce((s, r) => s + r.score.gradeLevel, 0) / scored.length * 10) / 10
    : 0,
  hardestSections: scored.slice(0, 10),
  easiestSections: scored.slice(-10).reverse(),
  allScores: scored,
});

// One history entry per run — every run is recorded (no corpus-unchanged
// skip); the shared bounded appender keeps the file at the 10k-line cap.
try {
  await appendReadabilityHistory(buildReadabilityHistoryEntry(scored, computedAt));
} catch (err) {
  logger.warn("Failed to append readability history", { error: String(err) });
}

// Console summary
if (scored.length > 0) {
  const n = limit ?? 5;
  if (!easiest) {
    logger.info(`Top ${n} hardest sections:`);
    for (const row of scored.slice(0, n)) {
      logger.info(`  § ${row.number} (${row.score.difficulty}) — Grade ${row.score.gradeLevel}`);
    }
  }
  if (easiest || !hardest) {
    logger.info(`Top ${n} easiest sections:`);
    for (const row of scored.slice(-n).reverse()) {
      logger.info(`  § ${row.number} (${row.score.difficulty}) — Grade ${row.score.gradeLevel}`);
    }
  }
}

logger.info(`Readability report saved to output/readability.json`);

return { computedAt, totalSections: sections.length, scored: scored.length };
}

#!/usr/bin/env bun
/** Repair known malformed generated history records without touching source data. */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeTextAtomic } from "../src/shared/source_health.js";

const marineHistory = join(process.cwd(), "output", "alerts", "marine", "history.jsonl");

if (!existsSync(marineHistory)) {
  console.log("No marine history found; nothing to repair.");
  process.exit(0);
}

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

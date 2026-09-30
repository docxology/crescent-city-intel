import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairGeneratedOutput } from "../src/output_migrations.ts";
test("migration preserves bytes and quarantines unproven times without inventing successful runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "output-migration-")); await mkdir(join(root, "alerts", "marine"), { recursive: true });
  const valid = JSON.stringify({ timestamp: "2026-09-29T12:00:00Z", waveHeightFt: 4 });
  const invented = JSON.stringify({ timestamp: "4026-09-29T12:00:00Z", fetchedAt: "2026-09-29T12:00:00Z" });
  const future = JSON.stringify({ timestamp: "2027-01-01T00:00:00Z" }); const original = `${valid}\n${invented}\n${future}\n{broken}\n`;
  try {
    await writeFile(join(root, "alerts", "marine", "history.jsonl"), original); await writeFile(join(root, "weekly-check-summary.json"), JSON.stringify({ exitCode: 0, itemCount: 4 }));
    const receipt = await repairGeneratedOutput(root, "2026-09-30T00:00:00Z"); expect(receipt.quarantinedMarineRows).toBe(3); expect(receipt.retainedMarineRows).toBe(1);
    expect(await readFile(join(root, "state", "migrations", receipt.migrationId, "alerts", "marine", "history.jsonl.original"), "utf8")).toBe(original);
    expect(await readFile(join(root, "alerts", "marine", "history.jsonl"), "utf8")).toBe(`${valid}\n`);
    const weekly = JSON.parse(await readFile(join(root, "weekly-check-summary.json"), "utf8")); expect(weekly.evidence).toBe("legacy-unverified"); expect(weekly.original.exitCode).toBe(0); expect(weekly.startedAt).toBeUndefined();
    expect(await Bun.file(join(root, "state", "latest-pipeline-run.json")).exists()).toBe(false);
    const repeat = await repairGeneratedOutput(root, "2026-09-30T01:00:00Z"); expect(repeat.files.every(file => file.beforeSha256 === file.afterSha256)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

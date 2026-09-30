/** Reviewed output migration: preserve bytes and never guess missing observation times. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { outputRoot } from "./shared/paths.js";
import { withFileLease } from "./shared/storage.js";
import { writeJsonAtomic, writeTextAtomic } from "./shared/source_health.js";
import { custodyHash } from "./corpus_editions.js";
export interface OutputMigrationReceipt { schemaVersion: "output-migration/v2"; migrationId: string; migratedAt: string; status: "running" | "complete" | "failed"; error?: string; files: Array<{ path: string; beforeSha256: string; afterSha256: string; action: string }>; retainedMarineRows: number; quarantinedMarineRows: number; limitations: string[] }
function recordedTimestamp(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const date = new Date(value); const year = date.getUTCFullYear();
  return Number.isFinite(date.getTime()) && year >= 2000 && year <= 2100 && date.getTime() <= now && date.toISOString().slice(0, 10) === value.slice(0, 10);
}
export async function repairGeneratedOutput(root = outputRoot(), migratedAt = new Date().toISOString()): Promise<OutputMigrationReceipt> {
  const now = Date.parse(migratedAt); if (!Number.isFinite(now)) throw new Error("Invalid migration receipt time");
  return withFileLease(join(root, "state", "output-migration.lock"), async () => {
    const migrationId = `v2-${crypto.randomUUID()}`; const directory = join(root, "state", "migrations", migrationId);
    const receipt: OutputMigrationReceipt = { schemaVersion: "output-migration/v2", migrationId, migratedAt, status: "running", files: [], retainedMarineRows: 0, quarantinedMarineRows: 0,
      limitations: ["No observation year/date is inferred from acquisition or migration time", "Historical pipeline summaries remain unverified and cannot become current successful run receipts", "Backups identify bytes; migration does not establish upstream correctness"] };
    const receiptPath = join(directory, "receipt.json");
    await writeJsonAtomic(receiptPath, receipt);
    async function preserve(relative: string): Promise<Buffer | null> {
      let bytes: Buffer; try { bytes = await readFile(join(root, relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      await mkdir(join(directory, relative, ".."), { recursive: true });
      await writeFile(join(directory, `${relative}.original`), bytes, { flag: "wx", mode: 0o600 });
      receipt.files.push({ path: relative, beforeSha256: custodyHash(bytes), afterSha256: custodyHash(bytes), action: "backup-created" });
      await writeJsonAtomic(receiptPath, receipt); return bytes;
    }
    try {
    const marinePath = "alerts/marine/history.jsonl";
    await withFileLease(`${join(root, marinePath)}.lock`, async () => {
    const marine = await preserve(marinePath);
    if (marine) {
      const retained: string[] = [], quarantined: string[] = [];
      for (const line of marine.toString("utf8").split(/\r?\n/).filter(line => line.trim())) {
        try { const record: unknown = JSON.parse(line); if (!record || typeof record !== "object" || Array.isArray(record) || !recordedTimestamp((record as Record<string, unknown>).timestamp, now)) quarantined.push(line); else retained.push(line); } catch { quarantined.push(line); }
      }
      receipt.retainedMarineRows = retained.length; receipt.quarantinedMarineRows = quarantined.length;
      const after = quarantined.length ? retained.length ? `${retained.join("\n")}\n` : "" : marine.toString("utf8");
      if (quarantined.length) { await writeTextAtomic(join(directory, "marine-quarantine.jsonl"), `${quarantined.join("\n")}\n`); await writeTextAtomic(join(root, marinePath), after); }
      Object.assign(receipt.files.find(file => file.path === marinePath)!, { afterSha256: custodyHash(after), action: quarantined.length ? "quarantine-unproven-times" : "retained-byte-identical" });
      await writeJsonAtomic(receiptPath, receipt);
    }
    });
    await withFileLease(join(root, "state", "weekly-check.lock"), async () => {
    const weeklyPath = "weekly-check-summary.json"; const weekly = await preserve(weeklyPath);
    if (weekly) {
      let original: unknown; try { original = JSON.parse(weekly.toString("utf8")); } catch { original = { encoding: "base64", bytes: weekly.toString("base64") }; }
      const current = original && typeof original === "object" ? original as Record<string, unknown> : null;
      if (!(current?.schemaVersion === "1.0.0" && typeof current.runId === "string" && Array.isArray(current.steps)) && current?.schemaVersion !== "legacy-weekly-summary/v1") await writeJsonAtomic(join(root, weeklyPath), { schemaVersion: "legacy-weekly-summary/v1", evidence: "legacy-unverified", migratedAt, original });
      const after = await readFile(join(root, weeklyPath)); Object.assign(receipt.files.find(file => file.path === weeklyPath)!, { afterSha256: custodyHash(after), action: custodyHash(after) === custodyHash(weekly) ? "retained-byte-identical" : "legacy-unverified-wrapper" });
      await writeJsonAtomic(receiptPath, receipt);
    }
    });
    receipt.status = "complete"; await writeJsonAtomic(receiptPath, receipt); return receipt;
    } catch (error) {
      receipt.status = "failed"; receipt.error = error instanceof Error ? error.message : String(error);
      try { await writeJsonAtomic(receiptPath, receipt); } catch { /* Existing running receipt and immutable backups remain available. */ }
      throw error;
    }
  });
}

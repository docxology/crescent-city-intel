/** Reviewed output migration: preserve bytes and never guess missing observation times. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { outputRoot } from "./shared/paths.js";
import { withFileLease, assertSafeFilesystemPath } from "./shared/storage.js";
import { writeJsonAtomic, writeTextAtomic } from "./shared/source_health.js";
import { custodyHash } from "./corpus_editions.js";
import { replaceArtifacts, recoverArtifactTransactions, rollbackArtifactTransaction, readBoundedArtifact, type ArtifactReplacement } from "./shared/artifact_transaction.js";
export interface OutputMigrationReceipt { schemaVersion: "output-migration/v2"; migrationId: string; migratedAt: string; status: "running" | "complete" | "failed" | "rolled-back"; transactionId?: string; error?: string; files: Array<{ path: string; beforeSha256: string; afterSha256: string; action: string }>; retainedMarineRows: number; quarantinedMarineRows: number; limitations: string[] }
async function withMigrationOwnership<T>(root: string, task: () => Promise<T>): Promise<T> {
  return withFileLease(join(root, "state", "output-migration.lock"), () => withFileLease(join(root, "state", "weekly-check.lock"), () => withFileLease(`${join(root, "alerts/marine/history.jsonl")}.lock`, task, { staleMs: 0 }), { staleMs: 0 }), { staleMs: 0 });
}
function recordedTimestamp(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const date = new Date(value); const year = date.getUTCFullYear();
  return Number.isFinite(date.getTime()) && year >= 2000 && year <= 2100 && date.getTime() <= now && date.toISOString().slice(0, 10) === value.slice(0, 10);
}
export async function repairGeneratedOutput(root = outputRoot(), migratedAt = new Date().toISOString()): Promise<OutputMigrationReceipt> {
  const now = Date.parse(migratedAt); if (!Number.isFinite(now)) throw new Error("Invalid migration receipt time");
  return withMigrationOwnership(root, async () => {
    await recoverArtifactTransactions(root);
    const migrationId = `v2-${crypto.randomUUID()}`; const directory = join(root, "state", "migrations", migrationId);
    await assertSafeFilesystemPath(directory);
    const receipt: OutputMigrationReceipt = { schemaVersion: "output-migration/v2", migrationId, migratedAt, status: "running", files: [], retainedMarineRows: 0, quarantinedMarineRows: 0,
      limitations: ["No observation year/date is inferred from acquisition or migration time", "Historical pipeline summaries remain unverified and cannot become current successful run receipts", "Backups identify bytes; migration does not establish upstream correctness"] };
    const receiptPath = join(directory, "receipt.json");
    const replacements: ArtifactReplacement[] = [];
    await writeJsonAtomic(receiptPath, receipt);
    async function preserve(relative: string): Promise<Buffer | null> {
      const source = join(root, relative); await assertSafeFilesystemPath(source);
      const bytes = await readBoundedArtifact(source, 16_000_000); if (bytes === null) return null;
      await mkdir(join(directory, relative, ".."), { recursive: true });
      await writeFile(join(directory, `${relative}.original`), bytes, { flag: "wx", mode: 0o600 });
      receipt.files.push({ path: relative, beforeSha256: custodyHash(bytes), afterSha256: custodyHash(bytes), action: "backup-created" });
      await writeJsonAtomic(receiptPath, receipt); return bytes;
    }
    try {
    const marinePath = "alerts/marine/history.jsonl";
    const marine = await preserve(marinePath);
    if (marine) {
      const retained: string[] = [], quarantined: string[] = [];
      for (const line of marine.toString("utf8").split(/\r?\n/).filter(line => line.trim())) {
        try { const record: unknown = JSON.parse(line); if (!record || typeof record !== "object" || Array.isArray(record) || !recordedTimestamp((record as Record<string, unknown>).timestamp, now)) quarantined.push(line); else retained.push(line); } catch { quarantined.push(line); }
      }
      receipt.retainedMarineRows = retained.length; receipt.quarantinedMarineRows = quarantined.length;
      const after = quarantined.length ? retained.length ? `${retained.join("\n")}\n` : "" : marine.toString("utf8");
      if (quarantined.length) { await writeTextAtomic(join(directory, "marine-quarantine.jsonl"), `${quarantined.join("\n")}\n`); replacements.push({ path: marinePath, text: after }); }
      Object.assign(receipt.files.find(file => file.path === marinePath)!, { afterSha256: custodyHash(after), action: quarantined.length ? "quarantine-unproven-times" : "retained-byte-identical" });
      await writeJsonAtomic(receiptPath, receipt);
    }
    const weeklyPath = "weekly-check-summary.json"; const weekly = await preserve(weeklyPath);
    if (weekly) {
      let original: unknown; try { original = JSON.parse(weekly.toString("utf8")); } catch { original = { encoding: "base64", bytes: weekly.toString("base64") }; }
      const current = original && typeof original === "object" ? original as Record<string, unknown> : null;
      let after = weekly;
      if (!(current?.schemaVersion === "1.0.0" && typeof current.runId === "string" && Array.isArray(current.steps)) && current?.schemaVersion !== "legacy-weekly-summary/v1") {
        const text = JSON.stringify({ schemaVersion: "legacy-weekly-summary/v1", evidence: "legacy-unverified", migratedAt, original }, null, 2); after = Buffer.from(text); replacements.push({ path: weeklyPath, text });
      }
      Object.assign(receipt.files.find(file => file.path === weeklyPath)!, { afterSha256: custodyHash(after), action: custodyHash(after) === custodyHash(weekly) ? "retained-byte-identical" : "legacy-unverified-wrapper" });
      await writeJsonAtomic(receiptPath, receipt);
    }
    if (replacements.length) receipt.transactionId = (await replaceArtifacts(root, replacements)).id;
    receipt.status = "complete"; await writeJsonAtomic(receiptPath, receipt); return receipt;
    } catch (error) {
      receipt.status = "failed"; receipt.error = error instanceof Error ? error.message : String(error);
      try { await writeJsonAtomic(receiptPath, receipt, { signal: null }); } catch { /* Existing running receipt and immutable backups remain available. */ }
      throw error;
    }
  });
}
/** Restore a reviewed committed migration only while its exact after-bytes remain. */
export async function rollbackGeneratedOutput(root: string, migrationId: string): Promise<OutputMigrationReceipt> {
  if (!/^v2-[a-f0-9-]{36}$/.test(migrationId)) throw new Error("Invalid migration identity");
  return withMigrationOwnership(root, async () => {
    const path = join(root, "state", "migrations", migrationId, "receipt.json"); await assertSafeFilesystemPath(path); const bytes = await readBoundedArtifact(path, 2_000_000); if (!bytes) throw new Error("Missing migration rollback receipt"); const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as OutputMigrationReceipt;
    if (receipt.schemaVersion !== "output-migration/v2" || receipt.migrationId !== migrationId || !receipt.transactionId || !Array.isArray(receipt.files)) throw new Error("Migration has no supported exact rollback transaction; preserve its original backups");
    if (receipt.files.length > 100) throw new Error('Migration file inventory exceeds bound');
    for (const file of receipt.files) { if (typeof file.path !== 'string' || isAbsolute(file.path) || relative(resolve(root), resolve(root, file.path)) !== file.path || file.path.startsWith('..') || !/^[a-f0-9]{64}$/.test(file.beforeSha256)) throw new Error('Invalid migration rollback file custody'); await assertSafeFilesystemPath(join(root, file.path)); }
    await rollbackArtifactTransaction(root, receipt.transactionId);
    for (const file of receipt.files) { const source = await readBoundedArtifact(join(root, file.path), 16_000_000); if (!source || custodyHash(source) !== file.beforeSha256) throw new Error("Rollback failed exact original-byte verification"); }
    receipt.status = "rolled-back"; await writeJsonAtomic(path, receipt, { signal: null }); return receipt;
  });
}

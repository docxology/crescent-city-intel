/** Recoverable replacements: exact prior bytes, bounded roots, and conflict refusal. */
import { mkdir, readFile, readdir, lstat, unlink, writeFile, open, rename, link } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { createHash } from "node:crypto";
import { withFileLease } from "./storage.js";
import { writeJsonAtomic, writeTextAtomic } from "./source_health.js";
import { currentRunSignal } from "./run_scope.js";
export type ArtifactReplacement = { path: string; text: string } | { path: string; bytes: Uint8Array };
interface FileReceipt { path: string; before: string | null; after: string; beforeSha256: string | null; afterSha256: string }
export interface ArtifactTransactionReceipt { schemaVersion: "artifact-transaction/v1"; id: string; root: string; status: "prepared" | "applying" | "committed" | "rolled-back"; createdAt: string; completedAt?: string; applied: string[]; files: FileReceipt[] }
const hash = (value: string) => createHash("sha256").update(Buffer.from(value, "base64")).digest("hex");
function target(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\0")) throw new Error("Invalid transaction artifact path");
  const absolute = resolve(root, path); const rel = relative(root, absolute);
  if (rel.startsWith("..") || !rel || isAbsolute(rel)) throw new Error("Transaction artifact escaped its root");
  if (rel !== path) throw new Error("Transaction artifact path must be canonical");
  return absolute;
}
async function noSymlink(root: string, path: string): Promise<void> {
  let current = resolve(root);
  const rootInfo = await lstat(current); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Transaction root must be a real directory");
  for (const part of relative(root, path).split(/[\\/]/)) {
    current = join(current, part); const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error("Transaction artifact cannot traverse symlinks");
  }
}
/** Bound allocation before and during a read, including concurrent file growth. */
export async function readBoundedArtifact(path: string, maximum: number): Promise<Buffer | null> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64_000_000) throw new Error("Invalid artifact read bound");
  const fd = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!fd) return null;
  try {
    const info = await fd.stat(); if (!info.isFile() || info.size > maximum) throw new Error("Artifact file exceeds bounded regular-file policy");
    const parts: Buffer[] = []; let total = 0;
    while (true) { const buffer = Buffer.alloc(Math.min(65_536, maximum + 1 - total)); const { bytesRead } = await fd.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > maximum) throw new Error("Artifact file exceeded byte limit during read"); parts.push(buffer.subarray(0, bytesRead)); }
    return Buffer.concat(parts);
  } finally { await fd.close(); }
}
async function currentBytes(root: string, file: FileReceipt): Promise<string | null> {
  const path = target(root, file.path); await noSymlink(root, path);
  return (await readBoundedArtifact(path, 18_000_000))?.toString("base64") ?? null;
}
async function loadReceipt(root: string, path: string): Promise<ArtifactTransactionReceipt | null> {
  await noSymlink(root, path); const bytes = await readBoundedArtifact(path, 64_000_000); if (bytes === null) return null;
  const receipt = JSON.parse(bytes.toString("utf8")) as ArtifactTransactionReceipt; validate(receipt, root); if (receipt.id !== basename(dirname(path))) throw new Error("Artifact receipt identity differs from its owned directory");
  const inventory = await readBoundedArtifact(join(dirname(path), "originals.json"), 64_000_000);
  if (!inventory || JSON.stringify(JSON.parse(inventory.toString("utf8"))) !== JSON.stringify(receipt.files)) throw new Error("Artifact receipt differs from immutable original inventory");
  return receipt;
}
async function restore(root: string, receipt: ArtifactTransactionReceipt, receiptPath: string): Promise<void> {
  // Preflight the entire set before any rollback write; preserve third-party edits.
  for (const file of receipt.files) { const bytes = await currentBytes(root, file); if (bytes !== file.before && bytes !== file.after) throw new Error(`Artifact changed outside transaction: ${file.path}`); }
  for (const file of [...receipt.files].reverse()) {
    if (await currentBytes(root, file) === file.before) continue;
    const path = target(root, file.path);
    if (file.before === null) { await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    else {
      await mkdir(dirname(path), { recursive: true }); const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.recovery`);
      try {
        // Prepared rollback bytes avoid allocating another full copy after a disk-full failure.
        const backup = join(dirname(receiptPath), `${receipt.files.indexOf(file)}.before`);
        const staged = await readBoundedArtifact(backup, 18_000_000);
        if (staged) { if (staged.toString("base64") !== file.before) throw new Error("Rollback bytes differ from original custody"); await link(backup, temporary); }
        else { const fd = await open(temporary, "wx", 0o600); try { await fd.writeFile(Buffer.from(file.before, "base64")); await fd.sync(); } finally { await fd.close(); } }
        await rename(temporary, path);
      }
      finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
  }
  receipt.status = "rolled-back"; receipt.completedAt = new Date().toISOString(); await writeJsonAtomic(receiptPath, receipt, { signal: null });
}
function validate(receipt: ArtifactTransactionReceipt, root: string): void {
  if (receipt.schemaVersion !== "artifact-transaction/v1" || receipt.root !== resolve(root) || !/^[a-f0-9-]{36}$/.test(receipt.id) || !Array.isArray(receipt.files) || receipt.files.length > 100 || !Array.isArray(receipt.applied) || !["prepared", "applying", "committed", "rolled-back"].includes(receipt.status)) throw new Error("Invalid artifact transaction receipt");
  const seen = new Set<string>();
  for (const file of receipt.files) {
    const absolute = target(root, file.path);
    if (seen.has(absolute) || typeof file.after !== "string" || Buffer.from(file.after, "base64").toString("base64") !== file.after || file.before !== null && (typeof file.before !== "string" || Buffer.from(file.before, "base64").toString("base64") !== file.before) || hash(file.after) !== file.afterSha256 || file.before !== null && hash(file.before) !== file.beforeSha256) throw new Error("Invalid artifact byte custody");
    seen.add(absolute);
  }
}
async function recover(root: string): Promise<ArtifactTransactionReceipt[]> {
  const directory = join(root, "state", "artifact-transactions"); const recovered: ArtifactTransactionReceipt[] = [];
  for (const name of (await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; })).sort()) {
    if (!/^[a-f0-9-]{36}$/.test(name)) throw new Error("Invalid artifact transaction directory");
    const path = join(directory, name, "receipt.json");
    // Publication never starts before this receipt exists.
    const receipt = await loadReceipt(root, path); if (receipt === null) continue;
    if (receipt.status === "prepared" || receipt.status === "applying") { await restore(root, receipt, path); recovered.push(receipt); }
  }
  return recovered;
}
/** Caller must also own the producer leases for these artifacts. */
export async function recoverArtifactTransactions(root: string): Promise<ArtifactTransactionReceipt[]> {
  root = resolve(root); await noSymlink(root, root); return withFileLease(join(root, "state", "artifact-transactions.lock"), () => recover(root), { staleMs: 0 });
}
export async function rollbackArtifactTransaction(root: string, id: string): Promise<ArtifactTransactionReceipt> {
  root = resolve(root); await noSymlink(root, root); if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid transaction identity");
  return withFileLease(join(root, "state", "artifact-transactions.lock"), async () => { const path = join(root, "state", "artifact-transactions", id, "receipt.json"); const receipt = await loadReceipt(root, path); if (!receipt) throw new Error("Missing artifact transaction receipt"); await restore(root, receipt, path); return receipt; }, { staleMs: 0 });
}
export async function replaceArtifacts(root: string, replacements: ArtifactReplacement[], options: { signal?: AbortSignal; onProgress?: (receipt: ArtifactTransactionReceipt) => Promise<void> } = {}): Promise<ArtifactTransactionReceipt> {
  options = { ...options, signal: options.signal ?? currentRunSignal() };
  root = resolve(root);
  if (!replacements.length || replacements.length > 100 || new Set(replacements.map(file => file.path)).size !== replacements.length || replacements.reduce((sum, file) => sum + ("text" in file ? Buffer.byteLength(file.text) : file.bytes.byteLength), 0) > 16_000_000) throw new Error("Invalid artifact transaction size");
  for (const replacement of replacements) target(root, replacement.path);
  await noSymlink(root, root);
  return withFileLease(join(root, "state", "artifact-transactions.lock"), async () => {
    options.signal?.throwIfAborted(); await recover(root);
    const receipt: ArtifactTransactionReceipt = { schemaVersion: "artifact-transaction/v1", id: crypto.randomUUID(), root, status: "prepared", createdAt: new Date().toISOString(), applied: [], files: [] };
    const directory = join(root, "state", "artifact-transactions", receipt.id);
    const receiptPath = join(directory, "receipt.json");
    let priorBytes = 0;
    for (const replacement of replacements) {
      const path = target(root, replacement.path); await noSymlink(root, path);
      const before = (await readBoundedArtifact(path, 18_000_000))?.toString("base64") ?? null;
      priorBytes += before === null ? 0 : Buffer.byteLength(before); if (priorBytes > 24_000_000) throw new Error("Prior artifacts exceed transaction byte limit");
      const after = ("text" in replacement ? Buffer.from(replacement.text, "utf8") : Buffer.from(replacement.bytes)).toString("base64");
      receipt.files.push({ path: replacement.path, before, after, beforeSha256: before === null ? null : hash(before), afterSha256: hash(after) });
    }
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "originals.json"), JSON.stringify(receipt.files), { flag: "wx", mode: 0o600 });
    for (const [index, file] of receipt.files.entries()) if (file.before !== null) { const fd = await open(join(directory, `${index}.before`), "wx", 0o600); try { await fd.writeFile(Buffer.from(file.before, "base64")); await fd.sync(); } finally { await fd.close(); } }
    await writeJsonAtomic(receiptPath, receipt, { signal: null });
    try {
      receipt.status = "applying"; await writeJsonAtomic(receiptPath, receipt, { signal: null });
      for (const replacement of replacements) {
        options.signal?.throwIfAborted();
        const file = receipt.files.find(file => file.path === replacement.path)!;
        if (await currentBytes(root, file) !== file.before) throw new Error(`Artifact changed before commit: ${file.path}`);
        if ("text" in replacement) await writeTextAtomic(target(root, replacement.path), replacement.text, { signal: options.signal });
        else { const path = target(root, replacement.path); await mkdir(dirname(path), { recursive: true }); const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`); try { const fd = await open(temporary, "wx", 0o600); try { await fd.writeFile(replacement.bytes); await fd.sync(); } finally { await fd.close(); } options.signal?.throwIfAborted(); await rename(temporary, path); } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); } }
        receipt.applied.push(replacement.path); await writeJsonAtomic(receiptPath, receipt, { signal: null }); await options.onProgress?.(receipt);
      }
      options.signal?.throwIfAborted(); receipt.status = "committed"; receipt.completedAt = new Date().toISOString(); await writeJsonAtomic(receiptPath, receipt); return receipt;
    } catch (error) { await restore(root, receipt, receiptPath); throw error; }
  }, { signal: options.signal, staleMs: 0 });
}

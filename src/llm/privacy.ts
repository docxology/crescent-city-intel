/** Opt-in, content-free, bounded private request diagnostics. */
import { mkdir, open, writeFile, rename, chmod, rm } from "fs/promises";
import { join } from "path";
import { outputRoot } from "../shared/paths.js";
import { withFileLease } from "../shared/storage.js";

const MAX_BYTES = 512_000;
let pending: Promise<void> = Promise.resolve();
interface Receipt { resultCount?: number; latencyMs?: number; provider?: string; model?: string; queryId?: string }
function safeMetadata(receipt: Receipt): Receipt {
  return {
    ...(Number.isSafeInteger(receipt.resultCount) && receipt.resultCount! >= 0 && receipt.resultCount! <= 100_000 ? { resultCount: receipt.resultCount } : {}),
    ...(Number.isFinite(receipt.latencyMs) && receipt.latencyMs! >= 0 && receipt.latencyMs! <= 300_000 ? { latencyMs: Math.round(receipt.latencyMs!) } : {}),
    ...(["ollama", "openrouter", "none"].includes(receipt.provider ?? "") ? { provider: receipt.provider } : {}),
    ...(/^[A-Za-z0-9:._/-]{1,200}$/.test(receipt.model ?? "") ? { model: receipt.model } : {}),
    ...(/^(?:rag-|rag-stream-)?[a-f0-9-]{36}$/i.test(receipt.queryId ?? "") ? { queryId: receipt.queryId } : {}),
  };
}
export function privateReceipt(kind: "search" | "rag", receipt: Receipt): Promise<void> {
  // Questions, answers, arbitrary extra fields and history are never persisted.
  if (process.env.CC_QUERY_LOGGING !== "metadata") return Promise.resolve();
  const root = outputRoot(), metadata = safeMetadata(receipt);
  const operation = async () => {
    const dir = join(root, "private"), path = join(dir, "request-receipts.jsonl");
    await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    await withFileLease(`${path}.lock`, async () => {
      const days = Math.max(1, Math.min(30, Number(process.env.CC_QUERY_RETENTION_DAYS) || 7));
      const cutoff = Date.now() - days * 86_400_000;
      let tail = "";
      try {
        const file = await open(path, "r");
        try {
          const size = (await file.stat()).size, offset = Math.max(0, size - MAX_BYTES), buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
          await file.read(buffer, 0, buffer.length, offset); tail = buffer.toString("utf8");
          if (offset) tail = tail.slice(tail.indexOf("\n") + 1);
        } finally { await file.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const lines = tail.split("\n").flatMap(line => {
        try { const row = JSON.parse(line); return ["search", "rag"].includes(row.kind) && Date.parse(row.ts) >= cutoff ? [JSON.stringify({ ts: row.ts, kind: row.kind, ...safeMetadata(row) })] : []; } catch { return []; }
      });
      lines.push(JSON.stringify({ ts: new Date().toISOString(), kind, ...metadata }));
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(temp, lines.slice(-1000).join("\n") + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, path); }
      finally { await rm(temp, { force: true }); }
    }, { waitMs: 1000 });
  };
  pending = pending.then(operation, operation).catch(() => undefined);
  return pending;
}
export async function deletePrivateReceipts(): Promise<void> {
  const path = join(outputRoot(), "private", "request-receipts.jsonl");
  await pending;
  await withFileLease(`${path}.lock`, () => rm(path, { force: true }), { waitMs: 1000 });
}

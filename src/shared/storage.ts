/** Cross-process writer leases; a rename alone does not serialize read/modify/write. */
import { mkdir, open, readFile, stat, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync, statSync, renameSync } from "node:fs";
import { throwIfAborted, waitWithSignal } from "./transport.js";

export interface LeaseOptions { waitMs?: number; staleMs?: number; signal?: AbortSignal; }
interface Lease { pid: number; token: string; startedAt: string; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; }
}
export async function acquireFileLease(path: string, options: LeaseOptions = {}): Promise<() => Promise<void>> {
  return acquireLease(path, options, 0);
}
async function acquireLease(path: string, options: LeaseOptions, recoveryDepth: number): Promise<() => Promise<void>> {
  if (![options.waitMs ?? 5000, options.staleMs ?? 30_000].every(value => Number.isFinite(value) && value >= 0) || (options.waitMs ?? 5000) > 3_600_000) throw new Error("Invalid writer lease bounds");
  if (recoveryDepth > 16) throw new Error("Excessive abandoned lease recovery guards");
  const deadline = Date.now() + (options.waitMs ?? 5000);
  const staleMs = options.staleMs ?? 30_000;
  const signal = options.signal ?? new AbortController().signal;
  const receipt: Lease = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  throwIfAborted(signal);
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    throwIfAborted(signal);
    let created = false; let inode: number | undefined;
    try {
      const file = await open(path, "wx", 0o600);
      created = true;
      try { inode = (await file.stat()).ino; throwIfAborted(signal); await file.writeFile(JSON.stringify(receipt)); await file.sync(); } finally { await file.close(); }
      const release = async () => {
        const owner = await readFile(path, "utf-8").then(raw => JSON.parse(raw)).catch(() => null);
        if (owner?.token === receipt.token) await unlink(path);
      };
      if (signal.aborted) { await release(); throwIfAborted(signal); }
      return release;
    } catch (error: any) {
      if (created) {
        const owner = await readFile(path, "utf-8").then(raw => JSON.parse(raw)).catch(() => null); const info = await stat(path).catch(() => null);
        if (owner?.token === receipt.token || !owner && info?.ino === inode) await unlink(path).catch(unlinkError => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
      const [owner, info] = await Promise.all([
        readFile(path, "utf-8").then(raw => JSON.parse(raw) as Lease).catch(() => null), stat(path).catch(() => null),
      ]);
      throwIfAborted(signal);
      if (info && Date.now() - info.mtimeMs > staleMs && (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !alive(owner.pid))) {
        // Serialize recovery too. Recheck the stale token under this guard;
        // never move a lease created after the initial observation.
        let releaseGuard: (() => Promise<void>) | undefined;
        try { releaseGuard = await acquireLease(`${path}.recovery`, { waitMs: Math.max(1, deadline - Date.now()), staleMs, signal }, recoveryDepth + 1); } catch (guardError) { throwIfAborted(signal); if (Date.now() >= deadline) throw guardError; }
        if (releaseGuard) {
          try {
            const raw = await readFile(path, "utf-8").catch(() => null);
            const current = raw === null ? null : (() => { try { return JSON.parse(raw) as Lease; } catch { return null; } })();
            const currentInfo = await stat(path).catch(() => null);
            throwIfAborted(signal);
            if (currentInfo && currentInfo.ino === info.ino && current?.token === owner?.token
              && Date.now() - currentInfo.mtimeMs > staleMs && (!current || !Number.isSafeInteger(current.pid) || current.pid < 1 || !alive(current.pid))) {
              await rename(path, `${path}.orphan-${randomUUID()}`);
            }
          } finally { await releaseGuard(); }
          if (Date.now() >= deadline) throw new Error(`Writer lease unavailable: ${path}`);
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Writer lease unavailable: ${path}`);
      await waitWithSignal(Math.min(25, Math.max(1, deadline - Date.now())), signal);
    }
  }
}

export async function withFileLease<T>(path: string, task: () => Promise<T>, options?: LeaseOptions): Promise<T> {
  const release = await acquireFileLease(path, options);
  try { if (options?.signal) throwIfAborted(options.signal); return await task(); } finally { await release(); }
}

/** Sync history writers serialize the entire append/trim transaction across processes. */
export function withFileLeaseSync<T>(path: string, task: () => T, waitMs = 1000, recoveryDepth = 0): T {
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 3_600_000) throw new Error("Invalid sync writer lease bounds");
  if (recoveryDepth > 16) throw new Error("Excessive abandoned sync recovery guards");
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID(); const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); } finally { closeSync(fd); }
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      let owner: Lease | null = null; let info: ReturnType<typeof statSync> | null = null;
      try { owner = JSON.parse(readFileSync(path, "utf8")); info = statSync(path); } catch { try { info = statSync(path); } catch { /* owner released */ } }
      if (info && Date.now() - info.mtimeMs > 30_000 && (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !alive(owner.pid))) {
        withFileLeaseSync(`${path}.recovery`, () => {
          let current: Lease | null = null; let currentInfo: ReturnType<typeof statSync> | null = null;
          try { current = JSON.parse(readFileSync(path, "utf8")); currentInfo = statSync(path); } catch { try { currentInfo = statSync(path); } catch { /* released */ } }
          if (currentInfo && currentInfo.ino === info!.ino && current?.token === owner?.token && Date.now() - currentInfo.mtimeMs > 30_000 && (!current || !Number.isSafeInteger(current.pid) || current.pid < 1 || !alive(current.pid))) renameSync(path, `${path}.orphan-${randomUUID()}`);
        }, Math.max(1, deadline - Date.now()), recoveryDepth + 1);
        if (Date.now() >= deadline) throw new Error(`Sync writer lease unavailable: ${path}`);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Sync writer lease unavailable: ${path}`);
      // Same-process async owners cannot progress during a sync wait.
      try { if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) throw new Error(`Sync lease conflicts with this process: ${path}`); } catch (ownerError: any) { if (ownerError.message?.startsWith("Sync lease")) throw ownerError; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return task(); } finally {
    try { if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
}

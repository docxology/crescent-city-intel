/** Cross-process writer leases; a rename alone does not serialize read/modify/write. */
import { mkdir, open, readFile, stat, rename, unlink, link, lstat } from "node:fs/promises";
import { dirname, basename, join, resolve, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync, statSync, renameSync, linkSync, fsyncSync, lstatSync, realpathSync } from "node:fs";
import { currentRunSignal, remainingRunMs } from "./run_scope.js";
import { throwIfAborted, waitWithSignal } from "./transport.js";

export interface LeaseOptions { waitMs?: number; staleMs?: number; signal?: AbortSignal; }
interface Lease { pid: number; token: string; startedAt: string; }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== "ESRCH"; }
}
// macOS exposes these OS directories through fixed aliases; user-controlled
// links below them remain forbidden, including state and producer namespaces.
function filesystemPath(path: string): string {
  let absolute = resolve(path);
  if (process.platform === "darwin") for (const alias of ["/var", "/tmp"]) {
    if ((absolute === alias || absolute.startsWith(`${alias}/`)) && realpathSync(alias) === `/private${alias}`) absolute = `/private${absolute}`;
  }
  return absolute;
}
/** Admission before mkdir/lease recovery; never follow an owned namespace link. */
export async function assertSafeFilesystemPath(path: string): Promise<string> {
  const absolute = filesystemPath(path); let current = parse(absolute).root; const parts = absolute.slice(current.length).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part); const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error("Owned filesystem path cannot traverse symlinks");
    if (info && index < parts.length - 1 && !info.isDirectory()) throw new Error("Owned filesystem parent must be a directory");
  }
  return absolute;
}
function assertSafeFilesystemPathSync(path: string): string {
  const absolute = filesystemPath(path); let current = parse(absolute).root; const parts = absolute.slice(current.length).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part); let info: ReturnType<typeof lstatSync> | null;
    try { info = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; info = null; }
    if (info?.isSymbolicLink()) throw new Error("Owned filesystem path cannot traverse symlinks");
    if (info && index < parts.length - 1 && !info.isDirectory()) throw new Error("Owned filesystem parent must be a directory");
  }
  return absolute;
}
export async function acquireFileLease(path: string, options: LeaseOptions = {}): Promise<() => Promise<void>> {
  return acquireLease(path, options, 0);
}
async function acquireLease(path: string, options: LeaseOptions, recoveryDepth: number): Promise<() => Promise<void>> {
  if (![options.waitMs ?? 5000, options.staleMs ?? 30_000].every(value => Number.isFinite(value) && value >= 0) || (options.waitMs ?? 5000) > 3_600_000) throw new Error("Invalid writer lease bounds");
  if (recoveryDepth > 16) throw new Error("Excessive abandoned lease recovery guards");
  const deadline = Date.now() + (options.waitMs ?? 5000);
  const staleMs = options.staleMs ?? 30_000;
  const signal = options.signal ?? currentRunSignal() ?? new AbortController().signal;
  const receipt: Lease = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  throwIfAborted(signal);
  path = await assertSafeFilesystemPath(path);
  const existing = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing && (!existing.isFile() || existing.size > 4096)) throw new Error("Writer lease must be a bounded regular file");
  await mkdir(dirname(path), { recursive: true });
  const prepared = join(dirname(path), `.${basename(path)}.${receipt.token}.lease`);
  const file = await open(prepared, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); } catch (error) { await unlink(prepared); throw error; } finally { await file.close(); }
  try { for (;;) {
    throwIfAborted(signal);
    let created = false; let inode: number | undefined;
    try {
      throwIfAborted(signal); await link(prepared, path);
      created = true; inode = (await stat(path)).ino;
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
  } } finally { await unlink(prepared).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function withFileLease<T>(path: string, task: () => Promise<T>, options?: LeaseOptions): Promise<T> {
  const release = await acquireFileLease(path, options);
  try { const signal = options?.signal ?? currentRunSignal(); if (signal) throwIfAborted(signal); return await task(); } finally { await release(); }
}

/** Sync history writers serialize the entire append/trim transaction across processes. */
export function withFileLeaseSync<T>(path: string, task: () => T, waitMs = 1000, recoveryDepth = 0): T {
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 3_600_000) throw new Error("Invalid sync writer lease bounds");
  if (recoveryDepth > 16) throw new Error("Excessive abandoned sync recovery guards");
  const signal = currentRunSignal(); if (signal) throwIfAborted(signal);
  waitMs = Math.min(waitMs, remainingRunMs() ?? waitMs);
  path = assertSafeFilesystemPathSync(path);
  try { const existing = lstatSync(path); if (!existing.isFile() || existing.size > 4096) throw new Error("Writer lease must be a bounded regular file"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID(); const deadline = Date.now() + waitMs;
  const prepared = join(dirname(path), `.${basename(path)}.${token}.lease`); const fd = openSync(prepared, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); fsyncSync(fd); } catch (error) { unlinkSync(prepared); throw error; } finally { closeSync(fd); }
  try { for (;;) {
    if (signal) throwIfAborted(signal);
    try {
      linkSync(prepared, path);
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
  try { if (signal) throwIfAborted(signal); return task(); } finally {
    try { if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  } } finally { try { unlinkSync(prepared); } catch (error: any) { if (error.code !== "ENOENT") throw error; } }
}

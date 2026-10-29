import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, utimes, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLease, withFileLease, withFileLeaseSync } from "../src/shared/storage.ts";
import { IdempotencyStore } from "../src/shared/idempotency.ts";
import { existsSync, readFileSync } from "node:fs";
import { recoverArtifactTransactions } from "../src/shared/artifact_transaction.ts";
import { recoverOwnedBrowsers } from "../src/browser_launcher.ts";

test("linked state namespaces refuse recovery and sync admission without touching outside bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-state-link-")), outside = await mkdtemp(join(tmpdir(), "cci-state-outside-")); const sentinel = join(outside, "artifact-transactions.lock"); const bytes = JSON.stringify({ pid: 0, token: "outside-owner", startedAt: "2020-01-01T00:00:00Z" }); await writeFile(sentinel, bytes); await utimes(sentinel, new Date(0), new Date(0)); await symlink(outside, join(root, "state"));
  try {
    await expect(recoverArtifactTransactions(root)).rejects.toThrow("symlinks"); await expect(recoverOwnedBrowsers(root)).rejects.toThrow("symlinks"); await expect(acquireFileLease(join(root, "state", "producers", "news.lock"))).rejects.toThrow("symlinks"); expect(() => withFileLeaseSync(join(root, "state", "writer.lock"), () => "unsafe")).toThrow("symlinks");
    expect(await readFile(sentinel, "utf8")).toBe(bytes); expect(await readdir(outside)).toEqual(["artifact-transactions.lock"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("a parent abort ends a real child-owned lease wait and leaves owner/data intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-cancel-lease-")); const storePath = join(root, "seen.json"); const path = `${storePath}.lock`;
  const initial = JSON.stringify({ prior: { hash: "old", firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-09-01T00:00:00Z" } });
  await writeFile(storePath, initial);
  const child = Bun.spawn([process.execPath, "-e", 'require("fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,token:"owned-child",startedAt:new Date().toISOString()}),{flag:"wx"});setInterval(()=>{},1000)', path], { stdout: "ignore", stderr: "pipe" });
  try {
    const deadline = Date.now() + 1000; while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(existsSync(path)).toBe(true);
    const ownerBytes = await readFile(path, "utf8"); const store = new IdempotencyStore(storePath); await store.load(); store.record("new", "new-hash");
    expect(() => withFileLeaseSync(path, () => "must not run", 20)).toThrow("Sync writer lease unavailable");
    expect(await readFile(path, "utf8")).toBe(ownerBytes);
    expect(await readFile(storePath, "utf8")).toBe(initial);
    const controller = new AbortController(); const started = Date.now(); const save = store.save({ signal: controller.signal }); setTimeout(() => controller.abort(new Error("Parent cancelled")), 30);
    await expect(save).rejects.toThrow(); expect(Date.now() - started).toBeLessThan(300); expect(await readFile(path, "utf8")).toBe(ownerBytes); expect(await readFile(storePath, "utf8")).toBe(initial);
    const preAborted = new AbortController(); preAborted.abort();
    await expect(acquireFileLease(join(root, "never-created", "writer.lock"), { signal: preAborted.signal })).rejects.toThrow(); expect(existsSync(join(root, "never-created"))).toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; await rm(root, { recursive: true, force: true }); }
});

test("live owner is retained, release is token-bound, dead stale owner is recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-lease-")); const path = join(root, "writer.lock");
  try {
    const release = await acquireFileLease(path);
    await expect(acquireFileLease(path, { waitMs: 20, staleMs: 0 })).rejects.toThrow("Writer lease unavailable");
    await writeFile(path, JSON.stringify({ pid: process.pid, token: "replacement", startedAt: new Date().toISOString() }));
    await release(); expect(JSON.parse(await readFile(path, "utf-8")).token).toBe("replacement");
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    await writeFile(path, JSON.stringify({ pid: child.pid, token: "dead", startedAt: "2020-01-01T00:00:00Z" }));
    await utimes(path, new Date(0), new Date(0));
    await withFileLease(path, async () => { expect(JSON.parse(await readFile(path, "utf-8")).pid).toBe(process.pid); }, { staleMs: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("killed recovery and sync owners are reclaimable with token receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-killed-lease-")); const path = join(root, "writer.lock");
  const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    for (const name of [path, `${path}.recovery`]) { await writeFile(name, JSON.stringify({ pid: child.pid, token: "killed", startedAt: "2020-01-01T00:00:00Z" })); await utimes(name, new Date(0), new Date(0)); }
    child.kill("SIGKILL"); await child.exited;
    // Qualify recovery using the API's production budgets. Nested recovery
    // includes real fsyncs; a 100 ms fixture budget is not a portability claim.
    // Tight waits are checked against live owners separately above.
    const release = await acquireFileLease(path, { staleMs: 1 }); await release();
    for (const name of [path, `${path}.recovery`]) { await writeFile(name, JSON.stringify({ pid: child.pid, token: "killed-sync", startedAt: "2020-01-01T00:00:00Z" })); await utimes(name, new Date(0), new Date(0)); }
    expect(withFileLeaseSync(path, () => "recovered")).toBe("recovered");
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
});
test("invalid zero and negative PIDs recover with production budgets and owned tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-invalid-lease-")); const path = join(root, "writer.lock");
  try {
    for (const pid of [0, -1]) {
      await writeFile(path, JSON.stringify({ pid, token: "invalid", startedAt: "2020-01-01T00:00:00Z" })); await utimes(path, new Date(0), new Date(0));
      // Positive recovery qualifies correctness with the production budgets.
      // Tight refusal and cancellation use a live owner in the controls above.
      const release = await acquireFileLease(path, { staleMs: 0 });
      const owner = JSON.parse(await readFile(path, "utf8")); expect(owner.pid).toBe(process.pid); expect(owner.token).not.toBe("invalid");
      await release(); expect(existsSync(path)).toBe(false);
      await writeFile(path, JSON.stringify({ pid, token: "invalid-sync", startedAt: "2020-01-01T00:00:00Z" })); await utimes(path, new Date(0), new Date(0));
      const syncOwner = withFileLeaseSync(path, () => JSON.parse(readFileSync(path, "utf8")));
      expect(syncOwner.pid).toBe(process.pid); expect(syncOwner.token).not.toBe("invalid-sync"); expect(existsSync(path)).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

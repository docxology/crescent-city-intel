/** A private launcher receipt makes pre-protocol browser setup ownable. */
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { outputRoot } from "./shared/paths.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { readBoundedArtifact } from "./shared/artifact_transaction.js";
import { withFileLease, assertSafeFilesystemPath } from "./shared/storage.js";
import { runBoundedChild } from "./shared/subprocess.js";
export interface BrowserLauncher { executable: string; pid(): Promise<number | null>; dispose(): Promise<void> }
interface DurableBrowserOwner { schemaVersion: "browser-owner/v1"; root: string; parentPid: number; token: string; executable: string; createdAt: string; status: "pending" | "closed" | "recovered"; recoveredPid?: number; processGroupGone?: boolean }
function alive(pid: number, group = false): boolean { try { process.kill(group ? -pid : pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
/** Dead-controller recovery requires the private launcher token AND its exact current command identity. */
export async function recoverOwnedBrowsers(root = outputRoot()): Promise<DurableBrowserOwner[]> {
  root = resolve(root); const directory = join(root, "state", "browser-owners"); const recovered: DurableBrowserOwner[] = [];
  await assertSafeFilesystemPath(directory);
  await mkdir(directory, { recursive: true });
  return withFileLease(join(root, "state", "browser-recovery.lock"), async () => {
    const names = await readdir(directory); if (names.length > 10_000) throw new Error("Browser owner inventory exceeds recovery bound");
    for (const name of names.sort()) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Unexpected browser-owner record");
      const path = join(directory, name); const raw = await readBoundedArtifact(path, 4096); if (!raw) continue; const record = JSON.parse(raw.toString("utf8")) as DurableBrowserOwner;
      if (record.schemaVersion !== "browser-owner/v1" || record.root !== root || record.token + ".json" !== name || !Number.isSafeInteger(record.parentPid) || record.parentPid < 1 || !["pending", "closed", "recovered"].includes(record.status)) throw new Error("Invalid durable browser ownership receipt");
      if (record.status !== "pending" || alive(record.parentPid)) continue;
      const expectedDirectory = dirname(record.executable);
      if (resolve(expectedDirectory, "..") !== resolve(tmpdir()) || !expectedDirectory.startsWith(join(resolve(tmpdir()), "cci-browser-launch-")) || record.executable !== join(expectedDirectory, "launch")) throw new Error("Browser recovery launcher outside private temporary namespace");
      await assertSafeFilesystemPath(expectedDirectory);
      const identityBytes = await readBoundedArtifact(join(expectedDirectory, "identity.json"), 4096); const identity = identityBytes ? JSON.parse(identityBytes.toString("utf8")) : null;
      if (!identity || identity.schemaVersion !== "browser-launcher-identity/v1" || identity.token !== record.token || identity.root !== root || identity.parentPid !== record.parentPid || identity.executable !== record.executable) throw new Error("Private launcher identity does not match durable root ownership; preserve ambiguous directory");
      const ownerBytes = await readBoundedArtifact(join(expectedDirectory, "owner.json"), 4096); const owner = ownerBytes ? JSON.parse(ownerBytes.toString("utf8")) : null;
      if (owner) {
        if (owner.token !== record.token || owner.root !== root || owner.parentPid !== record.parentPid || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Private browser launcher does not match durable root ownership");
        if (alive(owner.pid) || alive(owner.pid, true)) {
          const identity = await runBoundedChild(["ps", "-p", String(owner.pid), "-o", "command="], { timeoutMs: 1000, maxBytes: 4096 });
          if (identity.status !== "ok" || !identity.stdout.trim().split(/\s+/).includes(record.executable) || !alive(owner.pid, true)) throw new Error("Browser owner PID no longer has the authenticated launcher identity");
          process.kill(-owner.pid, "SIGKILL"); const until = Date.now() + 1000; while (alive(owner.pid, true) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
          if (alive(owner.pid, true)) throw new Error("Recovered browser group did not terminate within its cleanup bound");
        }
        record.recoveredPid = owner.pid; record.processGroupGone = true;
      }
      record.status = "recovered"; await writeJsonAtomic(path, record, { signal: null }); await rm(expectedDirectory, { recursive: true, force: true }); recovered.push(record);
    }
    return recovered;
  }, { waitMs: 1000, staleMs: 0 });
}
export async function createBrowserLauncher(executable: string): Promise<BrowserLauncher> {
  if (process.platform === "win32") throw new Error("Owned browser process-group cancellation requires a POSIX host");
  if (!executable || /[\0\r\n]/.test(executable) || /[\r\n ]/.test(process.execPath)) throw new Error("Invalid owned browser launcher executable");
  const root = resolve(outputRoot()); await assertSafeFilesystemPath(join(root, "state", "browser-owners"));
  const directory = await mkdtemp(join(tmpdir(), "cci-browser-launch-")); const token = crypto.randomUUID(); const parentPid = process.pid;
  const receipt = join(directory, "owner.json"); const wrapper = join(directory, "launch");
  const script = `#!${process.execPath}\nimport {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,token:${JSON.stringify(token)},root:${JSON.stringify(root)},parentPid:${parentPid}}),{flag:'wx',mode:0o600});\nconst child=spawn(${JSON.stringify(executable)},process.argv.slice(2),{detached:false,stdio:['ignore','inherit','inherit',3,4]});child.once('error',()=>process.exit(1));child.once('exit',(code,signal)=>process.exit(code??(signal?1:0)));\n`;
  await writeFile(wrapper, script, { flag: "wx", mode: 0o700 }); await chmod(wrapper, 0o700);
  await writeFile(join(directory, "identity.json"), JSON.stringify({ schemaVersion: "browser-launcher-identity/v1", root, parentPid, token, executable: wrapper }), { flag: "wx", mode: 0o600 });
  const durable: DurableBrowserOwner = { schemaVersion: "browser-owner/v1", root, parentPid, token, executable: wrapper, createdAt: new Date().toISOString(), status: "pending" };
  const durablePath = join(root, "state", "browser-owners", `${token}.json`);
  try { await writeJsonAtomic(durablePath, durable); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { executable: wrapper, pid: async () => {
    const raw = await readFile(receipt, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; }); if (raw === null) return null;
    const owner = JSON.parse(raw); if (owner.token !== token || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid owned launcher receipt"); return owner.pid;
  }, dispose: async () => { await writeJsonAtomic(durablePath, { ...durable, status: "closed" }, { signal: null }); await rm(directory, { recursive: true, force: true }); } };
}
/** POSIX group ownership comes from the exclusive launcher receipt and Playwright detach. */
export async function terminateBrowserLauncher(launcher: BrowserLauncher, timeoutMs = 1000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("Invalid launcher cleanup bound");
  const pid = await launcher.pid(); if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  // An unreaped Darwin zombie can produce EPERM instead of ESRCH. Retain the
  // launcher receipt until the owned group has actually disappeared.
  const deadline = Date.now() + timeoutMs;
  while (alive(pid, process.platform !== "win32") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (alive(pid, process.platform !== "win32")) throw new Error("Owned launcher group did not terminate within its cleanup bound");
}

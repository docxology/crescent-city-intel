/** A private launcher receipt makes pre-protocol browser setup ownable. */
import { mkdtemp, writeFile, rm, chmod, mkdir, readdir, readlink, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { outputRoot } from "./shared/paths.js";
import { writeJsonAtomic } from "./shared/source_health.js";
import { readBoundedArtifact } from "./shared/artifact_transaction.js";
import { withFileLease, assertSafeFilesystemPath } from "./shared/storage.js";
import { runBoundedChild } from "./shared/subprocess.js";
import { withRunSignal } from "./shared/run_scope.js";
export interface BrowserLauncher { executable: string; pid(): Promise<number | null>; dispose(): Promise<void> }
interface PrivateLauncherOwner { pid: number; linuxStartTime?: string }
interface ActiveLauncherIdentity { executable: string; owner(): Promise<PrivateLauncherOwner | null>; termination?: Promise<void> }
const activeLaunchers = new WeakMap<BrowserLauncher, ActiveLauncherIdentity>();
interface DurableBrowserOwner { schemaVersion: "browser-owner/v1"; root: string; parentPid: number; token: string; executable: string; createdAt: string; status: "pending" | "closed" | "recovered"; recoveredPid?: number; processGroupGone?: boolean }
function alive(pid: number, group = false): boolean { try { process.kill(group ? -pid : pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
type LauncherIdentity = "authenticated" | "exiting" | "ambiguous";
async function currentLauncherIdentity(pid: number, executable: string, linuxStartTime?: string, timeoutMs = 1000): Promise<LauncherIdentity> {
  if (process.platform === "linux") {
    const statBytes = await readBoundedArtifact(`/proc/${pid}/stat`, 4096);
    if (!statBytes) return "exiting";
    const stat = new TextDecoder("utf-8", { fatal: true }).decode(statBytes);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+ \(.+\) /.test(stat) || Number(fields[2]) !== pid || !/^\d+$/.test(fields[19] ?? "") || linuxStartTime !== undefined && fields[19] !== linuxStartTime) return "ambiguous";
    if (fields[0] === "Z" || fields[0] === "X") return "exiting";
    const command = await readBoundedArtifact(`/proc/${pid}/cmdline`, 16_384);
    if (!command) return "exiting";
    const argv = new TextDecoder("utf-8", { fatal: true }).decode(command).split("\0");
    const kernelExecutable = await readlink(`/proc/${pid}/exe`).catch(error => { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; });
    if (!kernelExecutable) return "exiting";
    if (kernelExecutable !== await realpath(process.execPath)) return "ambiguous";
    const currentBytes = await readBoundedArtifact(`/proc/${pid}/stat`, 4096);
    if (!currentBytes) return "exiting";
    const currentStat = new TextDecoder("utf-8", { fatal: true }).decode(currentBytes);
    const current = currentStat.slice(currentStat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!/^\d+ \(.+\) /.test(currentStat) || Number(current[2]) !== pid || current[19] !== fields[19]) return "ambiguous";
    if (current[0] === "Z" || current[0] === "X") return "exiting";
    if (argv[0] === process.execPath && argv[1] === executable) return "authenticated";
    // A leader can exit between the stat and argv reads. Never signal a
    // mismatched live process; absence only permits waiting for disappearance.
    return command.length === 0 ? "exiting" : "ambiguous";
  }
  const identity = await runBoundedChild(["ps", "-p", String(pid), "-o", "pid=,pgid="], { timeoutMs, maxBytes: 4096 });
  const command = /^\s*(\d+)\s+(\d+)\s*$/.exec(identity.stdout);
  if (identity.status === "ok" && command && Number(command[1]) === pid && Number(command[2]) === pid) {
    if (process.platform !== "darwin") return "ambiguous";
    // argv[0] and ps comm can be supplied by the caller. Authenticate the
    // executable mapped by the Darwin kernel, with a fixed OS buffer limit.
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    try {
      const buffer = new Uint8Array(4096); const length = library.symbols.proc_pidpath(pid, ptr(buffer), buffer.length);
      if (length <= 0) return "exiting";
      if (length >= buffer.length) return "ambiguous";
      const kernelExecutable = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).replace(/\0.*$/, "");
      if (kernelExecutable !== await realpath(process.execPath)) return "ambiguous";
      // KERN_PROCARGS2 preserves argument boundaries; ps text cannot distinguish
      // a real script argument from spaces injected into argv[0]. Decode only
      // the two required argv entries, never the trailing environment bytes.
      const mib = new Int32Array([1, 49, pid]), args = new Uint8Array(65_536), size = new BigUint64Array([BigInt(args.length)]);
      const result = library.symbols.sysctl(ptr(mib), mib.length, ptr(args), ptr(size), null, 0n);
      const bytes = Number(size[0]);
      if (result !== 0 || bytes < 4) return "exiting";
      if (bytes > args.length) return "ambiguous";
      const argc = new DataView(args.buffer).getInt32(0, true);
      if (argc === 0) return "exiting";
      if (argc < 2 || argc > 4096) return "ambiguous";
      let cursor = args.subarray(0, bytes).indexOf(0, 4);
      if (cursor < 0) return "ambiguous";
      while (cursor < bytes && args[cursor] === 0) cursor++;
      const argv: string[] = [];
      for (let index = 0; index < 2; index++) {
        const end = args.subarray(0, bytes).indexOf(0, cursor);
        if (end < 0) return "ambiguous";
        argv.push(new TextDecoder("utf-8", { fatal: true }).decode(args.subarray(cursor, end))); cursor = end + 1;
      }
      return argv[0] === process.execPath && argv[1] === executable ? "authenticated" : "ambiguous";
    } finally { library.close(); }
  }
  return identity.stdout.trim() && !identity.stdout.includes("<defunct>") ? "ambiguous" : "exiting";
}
async function waitForOwnedDisappearance(pid: number, timeoutMs = 1000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while ((alive(pid) || alive(pid, true)) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  return !alive(pid) && !alive(pid, true);
}
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
      if (!owner) throw new Error("Missing private browser launcher owner; preserve ambiguous directory");
      if (owner.token !== record.token || owner.root !== root || owner.parentPid !== record.parentPid || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.linuxStartTime !== undefined && (typeof owner.linuxStartTime !== "string" || !/^\d+$/.test(owner.linuxStartTime))) throw new Error("Private browser launcher does not match durable root ownership");
      if (alive(owner.pid) || alive(owner.pid, true)) {
        const identity = await currentLauncherIdentity(owner.pid, record.executable, owner.linuxStartTime);
        if (identity === "ambiguous" || identity === "authenticated" && !alive(owner.pid, true) && alive(owner.pid)) throw new Error("Browser owner PID no longer has the authenticated launcher identity");
        if (identity === "authenticated") {
          try { process.kill(-owner.pid, "SIGKILL"); } catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
        // Missing argv/zombie/EPERM never establish death or grant kill
        // authority. A naturally exiting owner must actually disappear.
        if (!await waitForOwnedDisappearance(owner.pid)) throw new Error("Recovered browser group did not terminate within its cleanup bound");
      }
      record.recoveredPid = owner.pid; record.processGroupGone = true;
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
  const script = `#!${process.execPath}\nimport {spawn} from 'node:child_process';import {writeFileSync,readFileSync} from 'node:fs';\nconst linuxStartTime=process.platform==='linux'?readFileSync('/proc/self/stat','utf8').split(') ').slice(1).join(') ').trim().split(/\\s+/)[19]:undefined;\nwriteFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,token:${JSON.stringify(token)},root:${JSON.stringify(root)},parentPid:${parentPid},linuxStartTime}),{flag:'wx',mode:0o600});\nconst child=spawn(${JSON.stringify(executable)},process.argv.slice(2),{detached:false,stdio:['ignore','inherit','inherit',3,4]});child.once('error',()=>process.exit(1));child.once('exit',(code,signal)=>process.exit(code??(signal?1:0)));\n`;
  await writeFile(wrapper, script, { flag: "wx", mode: 0o700 }); await chmod(wrapper, 0o700);
  await writeFile(join(directory, "identity.json"), JSON.stringify({ schemaVersion: "browser-launcher-identity/v1", root, parentPid, token, executable: wrapper }), { flag: "wx", mode: 0o600 });
  const durable: DurableBrowserOwner = { schemaVersion: "browser-owner/v1", root, parentPid, token, executable: wrapper, createdAt: new Date().toISOString(), status: "pending" };
  const durablePath = join(root, "state", "browser-owners", `${token}.json`);
  try { await writeJsonAtomic(durablePath, durable); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const readOwner = async (): Promise<PrivateLauncherOwner | null> => {
    await assertSafeFilesystemPath(directory);
    const raw = await readBoundedArtifact(receipt, 4096); if (raw === null) return null;
    const owner = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (owner.token !== token || owner.root !== root || owner.parentPid !== parentPid || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.linuxStartTime !== undefined && (typeof owner.linuxStartTime !== "string" || !/^\d+$/.test(owner.linuxStartTime))) throw new Error("Invalid owned launcher receipt");
    return { pid: owner.pid, linuxStartTime: owner.linuxStartTime };
  };
  const launcher: BrowserLauncher = { executable: wrapper, pid: async () => (await readOwner())?.pid ?? null,
    dispose: async () => { await writeJsonAtomic(durablePath, { ...durable, status: "closed" }, { signal: null }); await rm(directory, { recursive: true, force: true }); } };
  activeLaunchers.set(launcher, { executable: wrapper, owner: readOwner }); return launcher;
}
/** POSIX group ownership comes from the exclusive launcher receipt and Playwright detach. */
export async function terminateBrowserLauncher(launcher: BrowserLauncher, timeoutMs = 1000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("Invalid launcher cleanup bound");
  const owned = activeLaunchers.get(launcher); if (!owned) throw new Error("Unregistered owned browser launcher");
  if (owned.termination) return owned.termination;
  // Cleanup has its own bounded signal. The interrupted producer's signal
  // must not prevent authentication/reaping, and repeated watchdog callbacks
  // share one inspection instead of launching overlapping ps processes.
  const deadline = Date.now() + timeoutMs, signal = AbortSignal.timeout(Math.ceil(timeoutMs));
  owned.termination = withRunSignal(signal, async () => {
    const owner = await owned.owner();
    if (!owner) throw new Error("Missing owned launcher receipt; preserve ambiguous directory");
    if (!alive(owner.pid) && !alive(owner.pid, true)) return;
    const identity = await currentLauncherIdentity(owner.pid, owned.executable, owner.linuxStartTime, Math.max(1, deadline - Date.now()));
    if (identity === "ambiguous" || identity === "authenticated" && !alive(owner.pid, true) && alive(owner.pid)) throw new Error("Browser owner PID no longer has the authenticated launcher identity");
    if (identity === "authenticated") {
      try { process.kill(-owner.pid, "SIGKILL"); } catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    if (!await waitForOwnedDisappearance(owner.pid, Math.max(1, deadline - Date.now()))) throw new Error("Owned launcher group did not terminate within its cleanup bound");
  }, deadline);
  try { await owned.termination; } finally { owned.termination = undefined; }
}

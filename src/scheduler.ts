import { isCrescentCityProfile } from "./civic_profile.js";
/** Reviewed scheduling plans and explicit, ownership-checked installation targets. */
import { mkdir, readFile, writeFile, lstat, unlink, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { withFileLease, assertSafeFilesystemPath } from "./shared/storage.js";
import { writeJsonAtomic, writeTextAtomic } from "./shared/source_health.js";
import { replaceArtifacts, readBoundedArtifact, type ArtifactReplacement } from "./shared/artifact_transaction.js";
import { runBoundedChild } from "./shared/subprocess.js";
const schedulerHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function shellArgument(value: string): string { if (/[\0\r\n]/.test(value)) throw new Error("Scheduled arguments cannot contain NUL/newlines"); return `'${value.replace(/'/g, `'"'"'`)}'`; }
function xml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!)); }
export function renderSchedulerPlan(options: { project: string; bun: string; platform: "darwin" | "linux"; timezone?: string }): { content: string; timezone: string; instruction: string } {
  if (!isCrescentCityProfile()) throw new Error("The weekly scheduler requires a configured regional pipeline and distinct ownership plan for this civic profile");
  shellArgument(options.project); shellArgument(options.bun);
  const timezone = options.timezone ?? "America/Los_Angeles";
  if (timezone !== "America/Los_Angeles") throw new Error("This plan requires America/Los_Angeles calendar policy");
  if (options.platform === "darwin") return { timezone, instruction: "Review the plist and confirm the host calendar timezone is America/Los_Angeles before installation.", content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.crescentcity.weekly-check</string><key>ProgramArguments</key><array><string>${xml(options.bun)}</string><string>run</string><string>weekly-check</string></array><key>WorkingDirectory</key><string>${xml(options.project)}</string><key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict><key>StandardOutPath</key><string>${xml(options.project)}/output/logs/weekly-check.stdout.log</string><key>StandardErrorPath</key><string>${xml(options.project)}/output/logs/weekly-check.stderr.log</string></dict></plist>\n` };
  const command = `cd ${shellArgument(options.project)} && ${shellArgument(options.bun)} run weekly-check >> ${shellArgument(`${options.project}/output/logs/weekly-check.log`)} 2>&1`;
  return { timezone, instruction: "Review CRON_TZ support and create the log directory before installing this plan.", content: `CRON_TZ=${timezone}\n0 7 * * 0 ${command.replace(/%/g, "\\%")} # crescent-city\n` };
}
const BEGIN = "# BEGIN crescent-city-weekly"; const END = "# END crescent-city-weekly";
type SchedulerJob = Parameters<typeof renderSchedulerPlan>[0];
export interface SchedulerInstallOptions { job: SchedulerJob; targetPath: string; stateDirectory: string; activate?: boolean; signal?: AbortSignal }
export interface SchedulerReceipt { schemaVersion: "scheduler-install/v1"; platform: "darwin" | "linux"; targetPath: string; managedSha256: string; beforeSha256: string; afterSha256: string; status: "installed-file" | "activation-pending" | "activated" | "removed"; nativeActivation: boolean; writtenAt: string }
/** Canonicalize the operator's declared parent (including macOS /var), refuse a linked target. */
async function safeTarget(path: string, maximum = 1_000_000): Promise<string> {
  const absolute = await assertSafeFilesystemPath(path); await mkdir(dirname(absolute), { recursive: true });
  const canonical = join(await realpath(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
  const info = await lstat(canonical).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > maximum)) throw new Error("Scheduler target must be a bounded regular file");
  return canonical;
}
async function schedulerState(directory: string): Promise<string> { directory = await assertSafeFilesystemPath(directory); await mkdir(directory, { recursive: true }); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Scheduler state must be an owned directory"); return realpath(directory); }
function managedBlock(text: string): { block: string; start: number; end: number } | null {
  const starts = [...text.matchAll(/^# BEGIN crescent-city-weekly\r?$/gm)], ends = [...text.matchAll(/^# END crescent-city-weekly\r?$/gm)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0]!.index! <= starts[0]!.index!) throw new Error("Ambiguous or incomplete scheduler ownership block");
  const start = starts[0]!.index!, end = ends[0]!.index! + ends[0]![0].length + (text[ends[0]!.index! + ends[0]![0].length] === "\n" ? 1 : 0);
  return { block: text.slice(start, end), start, end };
}
async function maybeText(path: string, maximum = 1_000_000): Promise<string | null> { const bytes = await readBoundedArtifact(path, maximum); return bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
interface SchedulerJournal { operationId: string; schemaVersion: "scheduler-journal/v1"; target: string; before: string | null; after: string | null; priorReceipt: string | null; nextReceipt: string; status: "prepared" | "committed" | "rolled-back" }
async function restoreScheduler(state: string, journal: SchedulerJournal): Promise<void> {
  await safeTarget(journal.target); const current = await maybeText(journal.target);
  const receiptPath = join(state, "scheduler-receipt.json"), receipt = await maybeText(receiptPath);
  if (current !== journal.before && current !== journal.after || receipt !== journal.priorReceipt && receipt !== journal.nextReceipt) throw new Error("Scheduler changed outside interrupted operation; preserve it for review");
  if (current !== journal.before) { if (journal.before === null) await unlink(journal.target); else await writeTextAtomic(journal.target, journal.before, { signal: null }); }
  if (receipt !== journal.priorReceipt) { if (journal.priorReceipt === null) await unlink(receiptPath); else await writeTextAtomic(receiptPath, journal.priorReceipt, { signal: null }); }
  journal.status = "rolled-back"; await writeJsonAtomic(join(state, "scheduler-journal.json"), journal, { signal: null });
}
async function recoverScheduler(state: string, path: string): Promise<void> {
  await safeTarget(join(state, "scheduler-journal.json"), 4_000_000); const raw = await maybeText(join(state, "scheduler-journal.json"), 4_000_000); if (!raw) return;
  const journal = JSON.parse(raw) as SchedulerJournal;
  if (!/^[a-f0-9-]{36}$/.test(journal.operationId) || journal.schemaVersion !== "scheduler-journal/v1" || journal.target !== path || !["prepared", "committed", "rolled-back"].includes(journal.status) || ![journal.before, journal.after, journal.priorReceipt].every(value => value === null || typeof value === "string") || typeof journal.nextReceipt !== "string") throw new Error("Invalid scheduler recovery journal");
  const original = JSON.parse((await maybeText(join(state, `scheduler-original-${journal.operationId}.json`), 4_000_000))!);
  if (JSON.stringify({ ...original, status: journal.status }) !== JSON.stringify(journal)) throw new Error("Scheduler recovery differs from immutable original custody");
  if (journal.status === "prepared") await restoreScheduler(state, journal);
}
async function commitScheduler(state: string, path: string, after: string | null, receipt: SchedulerReceipt, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted(); const receiptPath = join(state, "scheduler-receipt.json"); await safeTarget(receiptPath);
  const journal: SchedulerJournal = { operationId: crypto.randomUUID(), schemaVersion: "scheduler-journal/v1", target: path, before: await maybeText(path), after, priorReceipt: await maybeText(receiptPath), nextReceipt: JSON.stringify(receipt, null, 2), status: "prepared" };
  await writeFile(join(state, `scheduler-original-${journal.operationId}.json`), JSON.stringify(journal), { flag: "wx", mode: 0o600 });
  await writeJsonAtomic(join(state, "scheduler-journal.json"), journal, { signal: null });
  try {
    signal?.throwIfAborted(); if (after === null) await unlink(path); else await writeTextAtomic(path, after, { signal });
    await writeTextAtomic(receiptPath, journal.nextReceipt, { signal }); journal.status = "committed"; await writeJsonAtomic(join(state, "scheduler-journal.json"), journal, { signal: null });
  } catch (error) { await restoreScheduler(state, journal); throw error; }
}
/** Native cron replacement is admitted only against an exact operator-reviewed host snapshot. */
async function requireNativeCron(expected: string, signal?: AbortSignal): Promise<void> {
  const result = await runBoundedChild(["crontab", "-l"], { timeoutMs: 10_000, maxBytes: 1_000_000, signal });
  if (result.status !== "ok" || result.stdout !== expected) throw new Error("Native crontab differs from the reviewed target; unrelated host entries must be preserved");
}
async function applyNativeCron(path: string, expectedBefore: string, expectedAfter: string, signal?: AbortSignal): Promise<void> {
  await requireNativeCron(expectedBefore, signal);
  const result = await runBoundedChild(["crontab", path], { timeoutMs: 10_000, maxBytes: 64_000, signal });
  if (result.status !== "ok") throw new Error("Native scheduler change failed; operation remains pending for explicit review");
  await requireNativeCron(expectedAfter, signal);
}
function launchdDomain(): string { const uid = process.getuid?.(); if (!Number.isSafeInteger(uid) || uid! < 0) throw new Error("Native launchd requires a known user identity"); return `gui/${uid}`; }
export async function installScheduler(options: SchedulerInstallOptions): Promise<SchedulerReceipt> {
  if (!isCrescentCityProfile()) throw new Error("Alternate civic scheduler ownership is not configured");
  options.signal?.throwIfAborted(); const path = await safeTarget(options.targetPath), state = await schedulerState(options.stateDirectory), plan = renderSchedulerPlan(options.job);
  return withFileLease(join(state, "scheduler.lock"), async () => {
    options.signal?.throwIfAborted(); await recoverScheduler(state, path); await safeTarget(path);
    const before = await maybeText(path) ?? ""; const receiptPath = join(state, "scheduler-receipt.json"); await safeTarget(receiptPath);
    const priorRaw = await maybeText(receiptPath); const prior = priorRaw ? JSON.parse(priorRaw) as SchedulerReceipt : null;
    const block = options.job.platform === "linux" ? managedBlock(before) : null;
    if (before && options.job.platform === "darwin" || block) {
      if (!prior || prior.schemaVersion !== "scheduler-install/v1" || prior.targetPath !== path || prior.platform !== options.job.platform || schedulerHash(block?.block ?? before) !== prior.managedSha256) throw new Error("Scheduler target has no matching managed ownership receipt");
    }
    if (prior?.nativeActivation) throw new Error("Remove the activated scheduler before replacing its reviewed file");
    const prefix = block ? before.slice(0, block.start) : before;
    const timezone = [...prefix.matchAll(/^\s*CRON_TZ\s*=\s*([^\r\n]*)$/gm)].at(-1)?.[1] ?? "";
    // CRON_TZ is file-scoped: restore the preceding setting for subsequent unrelated jobs.
    const managed = options.job.platform === "linux" ? `${BEGIN}\n${plan.content}CRON_TZ=${timezone}\n${END}\n` : plan.content;
    const after = options.job.platform === "darwin" ? managed : block ? `${before.slice(0, block.start)}${managed}${before.slice(block.end)}` : `${before}${before && !before.endsWith("\n") ? "\n" : ""}${managed}`;
    if (options.activate && options.job.platform === "linux") await requireNativeCron(before, options.signal);
    if (options.activate && options.job.platform === "darwin") {
      const existing = await runBoundedChild(["launchctl", "print", `${launchdDomain()}/com.crescentcity.weekly-check`], { signal: options.signal, timeoutMs: 10_000, maxBytes: 64_000 });
      if (existing.status === "ok" || !/Could not find service/i.test(existing.stderr + existing.stdout)) throw new Error("Native launchd label is present or ownership cannot be established");
    }
    const receipt: SchedulerReceipt = { schemaVersion: "scheduler-install/v1", platform: options.job.platform, targetPath: path, managedSha256: schedulerHash(managed), beforeSha256: schedulerHash(before), afterSha256: schedulerHash(after), status: "installed-file", nativeActivation: false, writtenAt: new Date().toISOString() };
    await commitScheduler(state, path, after, receipt, options.signal);
    if (options.activate) {
      receipt.status = "activation-pending"; receipt.nativeActivation = true; await writeJsonAtomic(receiptPath, receipt, { signal: null });
      if (options.job.platform === "linux") await applyNativeCron(path, before, after, options.signal);
      else { const result = await runBoundedChild(["launchctl", "bootstrap", launchdDomain(), path], { signal: options.signal, timeoutMs: 10_000, maxBytes: 64_000 }); if (result.status !== "ok") throw new Error("Native launchd activation remains pending for explicit review"); }
      receipt.status = "activated"; await writeJsonAtomic(receiptPath, receipt, { signal: null });
    }
    return receipt;
  }, { signal: options.signal, staleMs: 0 });
}
export async function removeScheduler(options: { targetPath: string; stateDirectory: string; deactivate?: boolean; signal?: AbortSignal }): Promise<SchedulerReceipt> {
  if (!isCrescentCityProfile()) throw new Error("Alternate civic scheduler ownership is not configured");
  options.signal?.throwIfAborted(); const path = await safeTarget(options.targetPath), state = await schedulerState(options.stateDirectory);
  return withFileLease(join(state, "scheduler.lock"), async () => {
    await recoverScheduler(state, path); const receiptPath = join(state, "scheduler-receipt.json"); await safeTarget(receiptPath); const receipt = JSON.parse((await maybeText(receiptPath))!) as SchedulerReceipt;
    if (receipt.schemaVersion !== "scheduler-install/v1" || receipt.targetPath !== path || receipt.status === "removed" || !["darwin", "linux"].includes(receipt.platform)) throw new Error("Scheduler removal has no matching ownership receipt");
    const before = (await maybeText(path))!, block = receipt.platform === "linux" ? managedBlock(before) : null;
    if (schedulerHash(block?.block ?? before) !== receipt.managedSha256) throw new Error("Managed scheduler entry changed; preserve it for review");
    if (receipt.status === "activation-pending") throw new Error("Native activation is uncertain; resolve it before automated removal");
    if (receipt.nativeActivation && !options.deactivate) throw new Error("An activated scheduler requires explicit deactivation");
    const after = block ? before.slice(0, block.start) + before.slice(block.end) : "";
    if (options.deactivate && receipt.nativeActivation && receipt.platform === "darwin") { const result = await runBoundedChild(["launchctl", "bootout", launchdDomain(), path], { signal: options.signal, timeoutMs: 10_000, maxBytes: 64_000 }); if (result.status !== "ok") throw new Error("Native scheduler deactivation failed; reviewed file preserved"); }
    if (options.deactivate && receipt.nativeActivation && receipt.platform === "linux") {
      const nativePlan = join(state, `scheduler-removal-${crypto.randomUUID()}.txt`); await writeFile(nativePlan, after, { flag: "wx", mode: 0o600 });
      try { await applyNativeCron(nativePlan, before, after, options.signal); } finally { await unlink(nativePlan); }
    }
    const removed = { ...receipt, afterSha256: schedulerHash(after), status: "removed" as const, nativeActivation: false, writtenAt: new Date().toISOString() };
    await commitScheduler(state, path, receipt.platform === "darwin" ? null : after, removed, options.signal); return removed;
  }, { signal: options.signal, staleMs: 0 });
}
/** Exact-byte recoverable rotation, admitted only while its producer lease is idle. */
export async function rotateSchedulerLog(options: { path: string; producerLease: string; maxBytes?: number; keep?: number; signal?: AbortSignal }): Promise<{ rotated: boolean; bytes: number; sha256?: string }> {
  const maximum = options.maxBytes ?? 5_000_000, keep = options.keep ?? 3;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_000_000 || !Number.isSafeInteger(keep) || keep < 1 || keep > 10) throw new Error("Invalid scheduler log retention bounds");
  return withFileLease(options.producerLease, async () => {
    const path = await safeTarget(options.path, 16_000_000), info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info || info.size <= maximum) return { rotated: false, bytes: info?.size ?? 0 };
    const bytes = (await readBoundedArtifact(path, 16_000_000))!; options.signal?.throwIfAborted(); const replacements: ArtifactReplacement[] = [{ path: path.slice(dirname(path).length + 1), bytes: new Uint8Array() }];
    for (let index = 1; index <= keep; index++) { const source = index === 1 ? path : `${path}.${index - 1}`; await safeTarget(source, 16_000_000); const content = await readBoundedArtifact(source, 16_000_000); if (content) replacements.push({ path: `${path.slice(dirname(path).length + 1)}.${index}`, bytes: content }); }
    await replaceArtifacts(dirname(path), replacements, { signal: options.signal }); return { rotated: true, bytes: bytes.length, sha256: schedulerHash(bytes) };
  }, { signal: options.signal, waitMs: 1000, staleMs: 0 });
}

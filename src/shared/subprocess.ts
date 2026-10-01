/** Own an argument-array child, its process group, pipes and terminal receipt. */
import { spawn } from "node:child_process";
import { currentRunSignal } from "./run_scope.js";
export interface ChildResult { stdout: string; stderr: string; exitCode: number; status: "ok" | "failed" | "timeout" | "cancelled" | "output-limit" | "spawn-failed"; reaped: boolean; pid?: number }
export async function runBoundedChild(argv: readonly string[], options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; cwd?: string } = {}): Promise<ChildResult> {
  const parent = currentRunSignal();
  if (parent) options = { ...options, signal: options.signal ? AbortSignal.any([parent, options.signal]) : parent };
  const timeoutMs = options.timeoutMs ?? 45_000; const maxBytes = options.maxBytes ?? 4_000_000;
  if (!argv.length || argv.some(argument => typeof argument !== "string" || argument.includes("\0")) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid bounded child invocation");
  options.signal?.throwIfAborted();
  return await new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let status: ChildResult["status"] | undefined; let stdout = "", stderr = "", bytes = 0, finished = false;
    const stdoutDecoder = new TextDecoder(); const stderrDecoder = new TextDecoder();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killOwnedGroup = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Owned group may already have exited. */ }
    };
    const finish = (exitCode: number, reaped: boolean) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", cancel);
      stdout += stdoutDecoder.decode(); stderr += stderrDecoder.decode();
      killOwnedGroup();
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve({ stdout, stderr, exitCode, status: status ?? (exitCode === 0 ? "ok" : "failed"), reaped, ...(child.pid ? { pid: child.pid } : {}) });
    };
    const kill = (reason: ChildResult["status"]) => {
      if (finished || status) return; status = reason;
      killOwnedGroup();
      killTimer = setTimeout(() => finish(-2, false), 2000);
    };
    const cancel = () => kill("cancelled");
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { kill("output-limit"); return; } stdout += stdoutDecoder.decode(chunk, { stream: true }); });
    child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { kill("output-limit"); return; } stderr += stderrDecoder.decode(chunk, { stream: true }); });
    child.on("error", error => { status = "spawn-failed"; stderr = error.message; finish(-1, true); });
    child.on("exit", killOwnedGroup);
    child.on("close", code => finish(code ?? -2, true));
  });
}

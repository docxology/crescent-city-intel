/** Terminate only an explicitly owned child and its detached POSIX process group. */
import type { ChildProcess } from "node:child_process";
export interface ProcessShutdownReceipt { pid: number | null; directChildReaped: boolean; processGroupGone: boolean; forced: boolean }
function groupAlive(pid: number): boolean { try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
export async function stopOwnedProcess(child: ChildProcess, timeoutMs = 1000): Promise<ProcessShutdownReceipt> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw new Error("Invalid process cleanup bound");
  const pid = child.pid ?? null; let reaped = child.exitCode !== null || child.signalCode !== null;
  const exit = () => { reaped = true; };
  child.once("exit", exit);
  const receipt = { pid, directChildReaped: reaped, processGroupGone: pid === null, forced: false };
  try {
    if (pid && groupAlive(pid)) {
      receipt.forced = true;
      try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-pid, "SIGKILL"); } catch (error) {
        // Darwin can return EPERM for a group whose owned leader is already
        // a zombie. Wait for this exact child's exit and require ESRCH below;
        // permission failure alone never becomes proof that the group is gone.
        if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    const deadline = Date.now() + timeoutMs;
    while ((!reaped || pid && groupAlive(pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    receipt.directChildReaped = reaped; receipt.processGroupGone = pid === null || !groupAlive(pid);
    return receipt;
  } finally { child.removeListener("exit", exit); }
}

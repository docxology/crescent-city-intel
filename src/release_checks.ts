import { resolve } from "node:path";
import { describeDrift, diffTrees, isUnchanged, snapshotTree } from "./shared/output_fence.js";
import { runBoundedChild } from "./shared/subprocess.js";

export interface CoverageSummary { lines: number; functions?: number; branches?: number }

/** Parse named columns rather than assigning meaning to their position. */
export function parseCoverageSummary(output: string): CoverageSummary {
  const rows = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const header = rows.find(row => row.includes("% Lines") && row.includes("|"));
  const aggregates = rows.filter(row => /^\s*All files\s*\|/.test(row));
  if (!header || aggregates.length !== 1) throw new Error("Coverage requires one aggregate row and named % Lines header");
  const columns = header.split("|").map(value => value.trim());
  const values = aggregates[0]!.split("|").map(value => value.trim());
  const result: Partial<CoverageSummary> = {};
  for (const [name, key] of [["% Lines", "lines"], ["% Funcs", "functions"], ["% Branches", "branches"]] as const) {
    const index = columns.indexOf(name);
    if (index < 0) continue;
    const value = values[index];
    if (!value || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Coverage ${name} is malformed`);
    const number = Number(value);
    if (number < 0 || number > 100) throw new Error(`Coverage ${name} is outside 0–100`);
    result[key] = number;
  }
  if (result.lines === undefined) throw new Error("Coverage line measurement is missing");
  return result as CoverageSummary;
}

/** Every exit path checks the corpus, including failure, timeout and coverage. */
export async function runFencedCommand(options: {
  args: string[]; cwd: string; outputRoot?: string; timeoutMs?: number; capture?: boolean;
}): Promise<string> {
  const roots = [...new Set([resolve(options.cwd, "output"), resolve(options.cwd, options.outputRoot ?? "output")])];
  const before = await Promise.all(roots.map(root => snapshotTree(root)));
  let output = "";
  const errors: Error[] = [];
  try {
    const child = await runBoundedChild(options.args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 20 * 60 * 1000, maxBytes: 16 * 1024 * 1024 });
    output = child.stdout + child.stderr;
    if (!options.capture || child.status !== "ok") {
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
    }
    if (child.status !== "ok" || !child.reaped) errors.push(new Error(`Command failed (exit ${child.exitCode}, ${child.status}, reaped=${child.reaped}): ${options.args.join(" ")}`));
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    for (const [index, root] of roots.entries()) {
      try {
        const drift = diffTrees(before[index]!, await snapshotTree(root));
        if (!isUnchanged(drift)) errors.push(new Error(`Output-corpus fence failed:\n${describeDrift(drift).join("\n")}`));
      } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join("\n"));
  return output;
}

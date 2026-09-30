import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCoverageSummary, runFencedCommand } from "../src/release_checks.ts";

describe("release measurement and fence", () => {
  test("reads line coverage by the header, including reordered columns", () => {
    expect(parseCoverageSummary("File | % Funcs | % Lines | Uncovered Line #s\nAll files | 99 | 42 |\n")).toEqual({ functions: 99, lines: 42 });
    expect(parseCoverageSummary("File | % Lines | % Funcs |\nAll files | 71 | 40 |\n")).toEqual({ functions: 40, lines: 71 });
    for (const output of ["All files | 99 | 42 |", "File | % Lines |\nAll files | NaN |", "File | % Lines |\nAll files | 101 |", "File | % Lines |\nAll files | 70 |\nAll files | 80 |"])
      expect(() => parseCoverageSummary(output)).toThrow();
  });
  test("checks output drift even when the real child fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-fence-"));
    try {
      await mkdir(join(root, "output"));
      await writeFile(join(root, "output", "evidence.json"), "original");
      let message = "";
      try { await runFencedCommand({ cwd: root, args: [process.execPath, "-e", "await Bun.write('output/evidence.json','changed'); process.exit(3)"], capture: true }); }
      catch (error) { message = String(error); }
      expect(message).toContain("exit 3"); expect(message).toContain("Output-corpus fence failed");
      expect(await readFile(join(root, "output", "evidence.json"), "utf8")).toBe("changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("checks captured runs and retains an unchanged corpus on timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-fence-"));
    try {
      await expect(runFencedCommand({ cwd: root, args: [process.execPath, "-e", "await Bun.write('output/covered.json','changed')"], capture: true })).rejects.toThrow("Output-corpus fence failed");
      await expect(runFencedCommand({ cwd: root, args: [process.execPath, "-e", "await new Promise(()=>{setInterval(()=>{},1000)})"], timeoutMs: 50, capture: true })).rejects.toThrow("Command failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("a descendant holding inherited pipes cannot outlive the fenced deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-fence-"));
    try {
      const started = performance.now();
      let message = "";
      try { await runFencedCommand({ cwd: root, args: ["/bin/sh", "-c", "mkdir -p output; printf changed > output/descendant.json; sleep 30 & printf 'descendant-ready\\n'; wait"], timeoutMs: 300, capture: true }); }
      catch (error) { message = String(error); }
      expect(message).toContain("timeout"); expect(message).toContain("Output-corpus fence failed");
      expect(performance.now() - started).toBeLessThan(3000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

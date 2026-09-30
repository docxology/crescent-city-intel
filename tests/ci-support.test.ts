import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { selectAffectedTests, validateMonitorCycle } from "../src/ci_support.ts";

describe("CI evidence", () => {
  test("traces source and test-helper dependencies with nested tests and quote styles", async () => {
    const root = await mkdtemp(join(tmpdir(), "ci-selection-"));
    const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
    try {
      await put("src/leaf.ts", "export const value=1;");
      await put("src/middle.ts", "export {value} from './leaf.js';");
      await put("tests/helpers/load.ts", "import {value} from '../../src/middle.js'; export {value};");
      await put("tests/nested/subject.test.ts", "import {value} from '../helpers/load.ts';");
      await put("tests/other.test.ts", "export const other=1;");
      expect(selectAffectedTests(root, ["src/leaf.ts"]).files).toEqual(["tests/nested/subject.test.ts"]);
      expect(selectAffectedTests(root, ["tests/helpers/load.ts"]).files).toEqual(["tests/nested/subject.test.ts"]);
      expect(selectAffectedTests(root, []) .full).toBe(true);
      expect(selectAffectedTests(root, ["package.json"]).full).toBe(true);
      expect(selectAffectedTests(root, ["src/deleted.ts"]).full).toBe(true);
      await put("src/middle.ts", "await import(process.env.SOURCE!);");
      expect(selectAffectedTests(root, ["src/leaf.ts"]).full).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("valid upstream outages pass while crashes and stale/incomplete evidence fail", () => {
    const started = Date.now();
    const row = { source: "A", status: "unavailable", checkedAt: new Date(started).toISOString(), itemCount: 0 };
    expect(validateMonitorCycle({ sources: [row] }, ["A"], started, 0)).toEqual([]);
    expect(validateMonitorCycle({ sources: [row] }, ["A"], started, 1).join()).toContain("runner exited");
    expect(validateMonitorCycle({ sources: [] }, ["A"], started, 0).join()).toContain("Missing monitor");
    expect(validateMonitorCycle({ sources: [{ ...row, checkedAt: "2000-01-01T00:00:00Z" }] }, ["A"], started, 0).join()).toContain("Not current-run");
    expect(validateMonitorCycle({ sources: [row, row] }, ["A"], started, 0).join()).toContain("Duplicate");
  });
});

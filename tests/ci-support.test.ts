import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { selectAffectedTests, validateMonitorCycle, validateGithubWorkflow, validateGithubWorkflows } from "../src/ci_support.ts";

describe("workflow YAML and runnable structure", () => {
  const valid = "on: workflow_dispatch\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";
  test("rejects the published plain run scalar even though its shell argument is quoted", () => {
    const broken = valid.replace("echo ok", "bun test tests/lane5-render-smoke.test.ts -t 'lane 5: exported pages render cleanly' --timeout 120000");
    expect(() => Bun.YAML.parse(broken)).toThrow();
    expect(validateGithubWorkflow(broken, "pages.yml").join()).toContain("pages.yml: invalid YAML");
    const repaired = broken.replace("run: bun test", "run: |\n          bun test");
    expect(validateGithubWorkflow(repaired)).toEqual([]);
    const parsed = Bun.YAML.parse(repaired) as { jobs: { check: { steps: Array<{ run: string }> } } };
    expect(parsed.jobs.check.steps[0]?.run.trim()).toBe("bun test tests/lane5-render-smoke.test.ts -t 'lane 5: exported pages render cleanly' --timeout 120000");
  });
  test("rejects parseable but unrunnable jobs and wrongly typed commands", () => {
    expect(validateGithubWorkflow("[]").join()).toContain("must be a mapping");
    expect(validateGithubWorkflow(valid.replace("on: workflow_dispatch", "on: false")).join()).toContain("on must declare");
    expect(validateGithubWorkflow("on: push\njobs: []").join()).toContain("jobs must be a nonempty mapping");
    expect(validateGithubWorkflow(valid.replace("    runs-on: ubuntu-latest\n", "")).join()).toContain("runs-on");
    expect(validateGithubWorkflow(valid.replace("run: echo ok", "run: {command: echo ok}")).join()).toContain("run must be a nonempty string");
    expect(validateGithubWorkflow(valid.replace("run: echo ok", "name: Only a name")).join()).toContain("exactly one of run or uses");
    expect(validateGithubWorkflow(valid.replace("run: echo ok", "run: echo ok\n        uses: actions/checkout@v4")).join()).toContain("exactly one of run or uses");
    expect(validateGithubWorkflow(valid.replace("    steps:", "    needs: missing\n    steps:")).join()).toContain("unknown or self-dependent job missing");
    expect(validateGithubWorkflow(valid.replace("run: echo ok", "run: echo ok\n        env: {INVALID: [a, b]}")).join()).toContain("env must map names to scalar values");
  });
  test("accepts a runnable reusable workflow and catches newly added .yaml files", async () => {
    expect(validateGithubWorkflow("on: push\njobs:\n  shared:\n    uses: owner/repo/.github/workflows/check.yml@main\n    with: {enabled: true}\n")).toEqual([]);
    const root = await mkdtemp(join(tmpdir(), "ci-workflows-"));
    try {
      const directory = join(root, ".github", "workflows");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "valid.yml"), valid);
      expect(validateGithubWorkflows(root)).toEqual([]);
      await writeFile(join(directory, "additional.yaml"), valid.replace("run: echo ok", "run: [not, a, script]"));
      expect(validateGithubWorkflows(root).join()).toContain(".github/workflows/additional.yaml: jobs.check.steps[0].run");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

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

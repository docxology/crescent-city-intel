/**
 * CI configuration contract.
 *
 * Offline assertions guard the declared Bun pin, authoritative PR gate and
 * full monitor roster. Configuration agreement is separate from hosted workflow
 * execution and current-source acceptance.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { MONITOR_KEYS } from "../src/alerts/composite.ts";
import { validateGithubWorkflows } from "../src/ci_support.ts";

const ROOT = process.cwd();
const readWorkflow = (name: string): string =>
  readFileSync(join(ROOT, ".github/workflows", name), "utf8");
/**
 * Workflow source with comments stripped.
 *
 * Necessary, not cosmetic: these files carry comments that quote the very
 * patterns being asserted on (the `bun-version: latest` line explains why
 * `latest` was removed), so a raw substring check matches the explanation and
 * reports a false failure.
 */
const workflow = (name: string): string =>
  readWorkflow(name)
    .split("\n")
    .filter(line => !/^\s*#/.test(line))
    .join("\n");
const has = (name: string): boolean => existsSync(join(ROOT, ".github/workflows", name));

describe("actual workflow parser contracts", () => {
  test("every current YAML workflow parses and declares runnable jobs/steps", () => {
    expect(validateGithubWorkflows(ROOT)).toEqual([]);
  });
  test("the real Pages filter survives YAML parsing as one shell command", () => {
    const parsed = Bun.YAML.parse(readWorkflow("pages.yml")) as { jobs: { build: { steps: Array<{ name?: string; run?: string }> } } };
    const render = parsed.jobs.build.steps.find(step => step.name === "Real browser render smoke");
    expect(render?.run?.trim()).toBe("bun test tests/lane5-render-smoke.test.ts -t 'lane 5: exported pages render cleanly' --timeout 120000");
  });
  test("the authoritative gate invokes YAML validation before the contract-mode split", () => {
    const text = readFileSync(join(ROOT, "src/release_gate.ts"), "utf8");
    expect(text).toContain("const workflowErrors = validateGithubWorkflows(root)");
    expect(text.indexOf("const workflowErrors = validateGithubWorkflows(root)")).toBeLessThan(text.indexOf("if (contractsOnly)"));
  });
});

describe("Bun is pinned, not floating", () => {
  const pinned = (text: string): boolean => /BUN_VERSION:\s*"[^"]+"/.test(text);

  for (const name of ["pr-gate.yml", "weekly.yml", "pages.yml"]) {
    test(`${name} pins a Bun version`, () => {
      expect(has(name)).toBe(true);
      const text = workflow(name);
      expect(`BUN_VERSION declared: ${pinned(text)}`).toBe("BUN_VERSION declared: true");
      // Every setup step must consume the pin, or a step silently ignores it.
      const usesLatest = /bun-version:\s*latest/.test(text);
      expect(`${name} uses bun-version: latest: ${usesLatest}`).toBe(`${name} uses bun-version: latest: false`);
      const setupSteps = [...text.matchAll(/setup-bun@v2/g)].length;
      const pinnedRefs = [...text.matchAll(/bun-version:\s*\$\{\{\s*env\.BUN_VERSION\s*\}\}/g)].length;
      expect(`${name}: ${setupSteps} setup step(s), ${pinnedRefs} consuming the pin`)
        .toBe(`${name}: ${setupSteps} setup step(s), ${pinnedRefs} consuming the pin`);
      if (setupSteps > 0) expect(pinnedRefs).toBe(setupSteps);
    });
  }

  test("all workflows pin the SAME version", () => {
    // Three pins drifting apart is the same class of problem as one floating
    // pin: CI would pass in one job and fail in another.
    const versions = ["pr-gate.yml", "weekly.yml", "pages.yml"]
      .filter(has)
      .map(name => readWorkflow(name).match(/BUN_VERSION:\s*"([^"]+)"/)?.[1]);
    expect(`pinned versions: ${[...new Set(versions)].join(", ")}`)
      .toBe(`pinned versions: ${[...new Set(versions)].join(", ")}`);
    expect([...new Set(versions)].length).toBeLessThanOrEqual(1);
  });
});

describe("the alert roster is exercised in CI", () => {
  test("weekly.yml does not restate the monitor list", () => {
    // The regression this guards: a hand-maintained list of monitors in CI that
    // silently falls behind the roster. The smoke step must derive its list.
    const text = workflow("weekly.yml");
    const perMonitorSteps = [...text.matchAll(/bun run alerts:[a-z]+/g)];
    expect(`hand-written per-monitor steps: ${perMonitorSteps.length}`).toBe("hand-written per-monitor steps: 0");
    // And it must call the derived smoke script instead.
    expect(text).toContain("scripts/ci-monitor-smoke.ts");
  });

  test("the smoke script covers the whole roster without restating it", () => {
    const text = readFileSync(join(ROOT, "scripts/ci-monitor-smoke.ts"), "utf8");
    // It reads the roster rather than listing keys, and does not build a
    // key-to-filename map (which would be a second copy: the key `tsunami`
    // lives in `noaa_tsunami.ts`, so such a map does not follow from the key).
    expect(text).toContain("MONITOR_KEYS");
    expect(text).not.toMatch(/src\/alerts\/\$\{/);
    expect(text).toContain("validateMonitorCycle");
  });
});

describe("pull requests are gated", () => {
  test("pr-gate.yml triggers on pull_request", () => {
    expect(has("pr-gate.yml")).toBe(true);
    const text = workflow("pr-gate.yml");
    expect(text).toMatch(/pull_request:/);
    expect(text).toContain("branches: [main]");
  });

  test("the PR job runs the contract checks, not just typecheck", () => {
    // The whole point of the job: `bunx tsc` alone would not catch a broken
    // route table, an unresolvable $ref, a roster mismatch, or a type enum that
    // disagrees with the code.
    const text = workflow("pr-gate.yml");
    expect(text).toContain("bunx tsc --noEmit");
    expect(text).toContain("--only=contracts");
  });

  test("the affected-test CLI delegates conservative selection to its tested module", () => {
    const text = readFileSync(join(ROOT, "scripts/ci-affected-tests.ts"), "utf8");
    expect(text).toContain("selectAffectedTests");
    expect(text).toContain("running the full suite rather than nothing");
  });

});

describe("the release gate is a mode, not two implementations", () => {
  test("--only=contracts stops before the suite and says what it skipped", () => {
    // A fast CI path that silently skips checks reads like a full pass. The
    // contract-only mode must name what it did not run.
    const text = readFileSync(join(ROOT, "src/release_gate.ts"), "utf8");
    expect(text).toContain("contractsOnly");
    expect(text).toContain("SKIPPED_BY_CONTRACTS_MODE");
    expect(text).toContain("this is NOT a full release-gate pass");
  });

  test("the suite runs twice on purpose, and the reason is recorded", () => {
    // Measured: merging the two runs into one with --coverage makes the gate
    // fail on six timeout-only failures, because instrumentation compounds
    // across the run. Without this note the next reader "optimises" it away.
    const text = readFileSync(join(ROOT, "src/release_gate.ts"), "utf8");
    expect(text).toContain("TWO suite runs, and the duplication is load-bearing");
    const plainRuns = [...text.matchAll(/"bun", "test", "tests\/", "--timeout"/g)].length;
    const coveredRuns = [...text.matchAll(/"--coverage"/g)].length;
    expect(`plain suite runs: ${plainRuns}, coverage runs: ${coveredRuns}`).toBe("plain suite runs: 1, coverage runs: 1");
  });
});

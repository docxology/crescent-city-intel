/**
 * CI configuration contract.
 *
 * The workflows are configuration, so nothing typechecks them and nothing fails
 * when they drift. That is how this state was reached:
 *
 *  - `bun-version: latest` in all three workflows, so a Bun release could break
 *    any of them with no change to this repository.
 *  - `weekly.yml` smoke-testing eight hand-written `bun run alerts:<x>` steps
 *    while the roster held fifteen, so seven monitors — including the marine
 *    forecast and the USCG broadcasts — were never exercised in CI and a change
 *    that broke them was invisible until the weekly cycle published a degraded
 *    source-health record.
 *  - No `pull_request` trigger anywhere: the authoritative release gate ran only
 *    on `push: main` and a schedule, so a regression could be merged and the
 *    first signal was the publish failing after it was already on main.
 *
 * These assertions are cheap and offline. They are not a substitute for running
 * the workflows, but they catch the class of drift where a file is edited to add
 * a monitor and the enforcement around it is not.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { MONITOR_KEYS } from "../src/alerts/composite.ts";

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
    // And it reports rather than enforces, because these hit live endpoints.
    expect(text).toContain("process.exit(0)");
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

  test("the affected-test selector refuses to narrow to nothing", () => {
    const text = readFileSync(join(ROOT, "scripts/ci-affected-tests.ts"), "utf8");
    // "No changed files" and "no test covers this" must both fall back to the
    // full suite. Silently running zero tests turns the job into a green light
    // that verifies nothing.
    expect(text).toContain("running the full suite rather than nothing");
    // And shared infrastructure must always force the full suite.
    for (const shared of ["src/types.ts", "src/constants.ts", "src/shared/paths.ts", "src/release_gate.ts"]) {
      expect(`triggers on ${shared}: ${text.includes(shared)}`).toBe(`triggers on ${shared}: true`);
    }
  });

  test("the affected-test selector maps tests by the module they import", () => {
    const text = readFileSync(join(ROOT, "scripts/ci-affected-tests.ts"), "utf8");
    // Subject mapping, read from each test's imports. A filename-similarity
    // heuristic would miss every test whose subject did not change name.
    expect(text).toContain("subjectsOf");
    // The import pattern must key on the module path, e.g. `../src/legal_parser.js`.
    expect(text).toContain('from\\s+"\\.\\.\\/(src\\/');
    // And strip the ESM-style `.js` specifier to reach the `.ts` source.
    expect(text).toContain('.replace(/\\.(ts|js)$/, ".ts")');
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

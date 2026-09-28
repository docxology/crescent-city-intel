#!/usr/bin/env bun
/**
 * Choose and run the tests a change could plausibly affect.
 *
 * The pull-request CI job needs a fast signal, but "run only the changed test
 * files" is wrong in both directions: a change to `src/utils.ts` is covered by
 * tests that did not change, and a change to a test's *subject* is not visible
 * by looking at test filenames at all. So this maps changed files to test files
 * by SUBJECT — the source module under test — rather than by name similarity,
 * and falls back to the whole suite whenever the answer is not bounded.
 *
 * Two properties matter more than cleverness:
 *
 *  - **Err toward running more.** A wrong guess costs seconds; a missed test
 *    costs a regression on main. So shared infrastructure (types, constants,
 *    paths, the release gate) always forces the full suite.
 *  - **Fail loudly rather than silently narrow.** If the changed-file list
 *    cannot be read, the answer is the full suite — never "zero tests", which
 *    would turn the job into a green light that tests nothing.
 *
 * Reads the changed-file list from `$CHANGED` (newline separated) or stdin, so
 * it is usable by hand as well as from CI.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const TESTS_DIR = join(ROOT, "tests");

/**
 * A change here invalidates "which tests are relevant", so do not try to narrow.
 * These are the shared surfaces every module depends on, plus the test
 * infrastructure itself.
 */
const FULL_SUITE_TRIGGERS = [
  "src/types.ts",
  "src/constants.ts",
  "src/shared/paths.ts",
  "src/shared/data.ts",
  "src/release_gate.ts",
  "src/utils.ts",
  "tsconfig.json",
  "bun.lock",
  "package.json",
];

function readChangedFiles(): string[] {
  const fromEnv = process.env.CHANGED;
  const raw = fromEnv && fromEnv.trim() !== "" ? fromEnv : "";
  if (raw) {
    // Trim the heredoc markers the workflow writes around the list.
    return raw.split("\n").map(l => l.trim()).filter(l => l !== "" && l !== "EOF" && l !== "changed");
  }
  const files: string[] = [];
  try {
    files.push(...readFileSync(0, "utf8").split("\n"));
  } catch {
    return [];
  }
  return files.map(l => l.trim()).filter(Boolean);
}

/**
 * The source module a test file exercises, read from its imports.
 *
 * Read rather than restated: a hand-maintained map here would be exactly the
 * kind of second copy that drifts, which is the problem this script exists to
 * solve. A test that imports several modules maps to all of them, so it runs
 * when any of them changes.
 */
function subjectsOf(testFile: string): Set<string> {
  const subjects = new Set<string>();
  let source: string;
  try {
    source = readFileSync(join(TESTS_DIR, testFile), "utf8");
  } catch {
    return subjects;
  }
  // Imports are relative to `tests/`, so `../src/legal_parser.js` resolves to
  // `src/legal_parser.ts`. The `.js` extension is the ESM-style specifier the
  // repo uses for TypeScript sources, so it is stripped rather than matched.
  for (const match of source.matchAll(/from\s+"\.\.\/(src\/[^"]+)"/g)) {
    subjects.add(match[1]!.replace(/\.(ts|js)$/, ".ts"));
  }
  return subjects;
}

function testFiles(): string[] {
  if (!existsSync(TESTS_DIR)) return [];
  return readdirSync(TESTS_DIR).filter(f => f.endsWith(".test.ts")).sort();
}

const changed = readChangedFiles().map(f => relative(ROOT, join(ROOT, f)).replace(/\\/g, "/"));

if (changed.length === 0) {
  console.log("No changed files reported — running the full suite rather than nothing.");
  await runAll();
} else {
  const triggers = FULL_SUITE_TRIGGERS.filter(t => changed.includes(t));
  if (triggers.length > 0) {
    console.log(`Shared infrastructure changed (${triggers.join(", ")}) — running the full suite.`);
    await runAll();
  } else {
    const sourceChanges = changed.filter(f => f.startsWith("src/") && f.endsWith(".ts"));
    const testChanges = changed.filter(f => f.startsWith("tests/"));
    const other = changed.filter(f => !f.startsWith("src/") && !f.startsWith("tests/"));

    if (other.length > 0) {
      console.log(`Non-source changes (${other.join(", ")}) — running the full suite.`);
      await runAll();
    } else {
      const selected = new Set<string>(testChanges);
      for (const file of testFiles()) {
        const subjects = subjectsOf(file);
        for (const change of sourceChanges) {
          if (subjects.has(change)) { selected.add(file); break; }
        }
      }
      if (selected.size === 0) {
        console.log(`No test covers ${sourceChanges.join(", ")} — running the full suite rather than nothing.`);
        await runAll();
      } else {
        const list = [...selected].sort();
        console.log(`${changed.length} changed file(s); ${sourceChanges.length} source, ${testChanges.length} test.`);
        console.log(`Running ${list.length}/${testFiles().length} affected test file(s):`);
        for (const f of list) console.log(`  ${f}`);
        await runTests(list);
      }
    }
  }
}

async function runAll(): Promise<void> {
  const result = Bun.spawnSync(["bun", "test", "tests/", "--timeout", "30000"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  process.exit(result.exitCode ?? 1);
}

async function runTests(files: string[]): Promise<void> {
  // `CHANGED` carries repo-relative paths ("tests/foo.test.ts"), and a changed
  // path is used verbatim as the bun test filter; only a bare test filename
  // needs the tests/ prefix. Joining unconditionally produced
  // "tests/tests/foo.test.ts", which matches nothing and fails the run — first
  // hit by the first PR whose changed set was tests-only.
  const result = Bun.spawnSync(
    ["bun", "test", ...files.map(f => (f.startsWith("tests/") ? f : join("tests", f))), "--timeout", "30000"],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  process.exit(result.exitCode ?? 1);
}

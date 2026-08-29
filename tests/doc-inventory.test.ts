/**
 * Documented numbers must match the code that produces them.
 *
 * Every count in README.md, AGENTS.md and docs/** is hand-typed with no
 * generator, so each one is a claim that decays silently: the monitor family
 * grew 8 → 13 and the docs still said 8 in six places, the version moved
 * 2.5.1 → 2.6.0 and four places still said 2.5.1, the domain list grew 6 → 12
 * and the README's own sample output still said 6. A reader cannot tell a stale
 * number from a current one, which makes every number in the docs worth less.
 *
 * These assertions read both sides — the doc and the source of truth — so the
 * next drift fails the gate instead of aging quietly in the prose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const root = process.cwd();
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

const DOC_FILES = ["README.md", "AGENTS.md", "docs/README.md", "docs/architecture.md", "docs/roadmap.md", "docs/modules/alerts.md", "docs/modules/monitoring.md", "docs/modules/pages.md", "docs/modules/events.md", "docs/modules/gui.md"];

describe("documented version numbers match the shipped version", () => {
  const version = (JSON.parse(read("package.json")) as { version: string }).version;

  test("openapi.yaml declares the package version", () => {
    expect(read("openapi.yaml")).toContain(`  version: ${version}`);
  });

  test("no doc quotes a different spec version", () => {
    // Any vN.N.N that looks like this project's own version claim must be current.
    const stale: string[] = [];
    for (const file of DOC_FILES) {
      const text = read(file);
      for (const match of text.matchAll(/(?:OpenAPI 3\.0\.3[^\n]*?|Version-)v?(\d+\.\d+\.\d+)/g)) {
        if (match[1] !== version) stale.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(`stale version claims: ${JSON.stringify(stale)}`).toBe("stale version claims: []");
  });
});

describe("documented inventories match the code", () => {
  test("the monitor count the docs quote matches the runner's batch", () => {
    // The runner is the source of truth: it logs the count it runs.
    const runner = read("scripts/run-alerts.ts");
    const declared = /Running All (\d+) Alert Monitors/.exec(runner);
    expect(declared).not.toBeNull();
    const monitorCount = Number(declared![1]);

    const stale: string[] = [];
    for (const file of DOC_FILES) {
      const text = read(file);
      // (?<![\w-]) so "Phase-12 monitors" reads as a phase name, not a count.
      for (const match of text.matchAll(/(?<![\w-])(\d+)[- ]monitor/gi)) {
        if (Number(match[1]) !== monitorCount) stale.push(`${file}: "${match[0]}" (runner says ${monitorCount})`);
      }
    }
    expect(`stale monitor counts: ${JSON.stringify(stale)}`).toBe("stale monitor counts: []");
  });

  test("the composite severity really takes the number of inputs the docs claim", async () => {
    const { computeAlertSeverity } = await import("../src/alerts/severity.ts");
    const runner = read("scripts/run-alerts.ts");
    const monitorCount = Number(/Running All (\d+) Alert Monitors/.exec(runner)![1]);
    // The claim "13-monitor composite" is only true if the function accepts 13
    // inputs AND the runner passes them; length counts required parameters, so
    // check the call site too.
    expect(computeAlertSeverity.length).toBeLessThanOrEqual(monitorCount);
    const callSite = /computeAlertSeverity\(([\s\S]*?)\n\s*\);/.exec(runner);
    expect(callSite).not.toBeNull();
    const argumentCount = callSite![1]!.split(",").filter(part => part.trim().length > 0).length;
    expect(`composite inputs passed: ${argumentCount}`).toBe(`composite inputs passed: ${monitorCount}`);
  });

  test("the domain count in the README sample matches src/domains.ts", async () => {
    const { domains } = await import("../src/domains.ts");
    const count = Array.isArray(domains) ? domains.length : Object.keys(domains).length;
    const readme = read("README.md");
    const sample = /\/api\/domains\s+HTTP 200\s+array len=(\d+)/.exec(readme);
    expect(sample).not.toBeNull();
    expect(`README sample domain count: ${sample![1]}`).toBe(`README sample domain count: ${count}`);
    for (const match of read("run.sh").matchAll(/All (\d+) intelligence domains/g)) {
      expect(`run.sh domain count: ${match[1]}`).toBe(`run.sh domain count: ${count}`);
    }
  });

  test("every module the docs list under src/ actually exists", () => {
    const listed = new Set<string>();
    for (const file of ["README.md", "AGENTS.md"]) {
      for (const match of read(file).matchAll(/^\s*([a-z_0-9]+\.ts)\s+#/gm)) listed.add(match[1]!);
    }
    expect(listed.size).toBeGreaterThan(10);
    // Walk the tree rather than guessing directories: a hardcoded candidate
    // list is the same hand-maintained inventory this test exists to replace.
    const sources = new Set<string>();
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name));
        else if (entry.name.endsWith(".ts")) sources.add(entry.name);
      }
    };
    walk(join(root, "src"));
    walk(join(root, "scripts"));
    const missing = [...listed].filter(name => !sources.has(name));
    expect(`documented modules that do not exist: ${JSON.stringify(missing)}`).toBe("documented modules that do not exist: []");
  });
});

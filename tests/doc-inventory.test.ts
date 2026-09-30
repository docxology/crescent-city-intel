/**
 * Documented numbers must match the code that produces them.
 *
 * Handwritten roster, version, and module claims must remain in sync with their
 * canonical runtime definitions. Full paths distinguish equal basenames in
 * different directories; structural YAML checks ignore serialization layout.
 *
 * These assertions read both sides — the doc and the source of truth — so the
 * next drift fails the gate instead of aging quietly in the prose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { MONITOR_KEYS } from "../src/alerts/composite.ts";
import { documentedSourcePaths } from "../src/doc_inventory.ts";

const root = process.cwd();
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

const DOC_FILES = ["README.md", "AGENTS.md", "docs/README.md", "docs/architecture.md", "docs/roadmap.md", "docs/modules/alerts.md", "docs/modules/monitoring.md", "docs/modules/pages.md", "docs/modules/events.md", "docs/modules/gui.md"];

describe("documented version numbers match the shipped version", () => {
  const version = (JSON.parse(read("package.json")) as { version: string }).version;

  test("openapi.yaml declares the package version", () => {
    expect((Bun.YAML.parse(read("openapi.yaml")) as { info: { version: string } }).info.version).toBe(version);
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
    const monitorCount = MONITOR_KEYS.length;

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
    const { SEVERITY_MONITOR_KEYS } = await import("../src/alerts/severity.ts");
    expect(MONITOR_KEYS.length).toBeGreaterThan(0);
    expect(SEVERITY_MONITOR_KEYS.map(key => key.toLowerCase()).sort()).toEqual([...MONITOR_KEYS].sort());
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

  test("every full source path appears in the architecture tree", () => {
    const listed = documentedSourcePaths(read("AGENTS.md"));
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) sources.push(relative(root, path));
      }
    };
    walk(join(root, "src"));
    expect(sources.filter(path => !listed.has(path)).sort()).toEqual([]);
    expect([...listed].filter(path => !sources.includes(path)).sort()).toEqual([]);
  });

  test("equal basenames in different directories remain independent inventory entries", () => {
    const listed = documentedSourcePaths("```\nsrc/ # root\napi/ # api\n  index.ts # API\nllm/ # llm\n  index.ts # LLM\nscripts/ # scripts\n``` ");
    expect([...listed]).toEqual(["src/api/index.ts", "src/llm/index.ts"]);
    expect(listed.has("src/gui/index.ts")).toBe(false);
  });
});

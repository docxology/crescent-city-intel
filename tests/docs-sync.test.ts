/**
 * Docs stay in sync with the implementation and the published contract.
 *
 * The release gate checks OpenAPI route parity with the implementation. These
 * tests check that the module reference points readers to that route authority,
 * advertises no nonexistent route, and keeps the architecture roster current.
 *
 * Counts are read from the sources, never restated, so the check cannot itself
 * become a thing that needs updating.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf-8");

/** Every `/api/...` path in the published spec. */
function specPaths(): string[] {
  return Object.keys((Bun.YAML.parse(read("openapi.yaml")) as { paths: Record<string, unknown> }).paths);
}

/**
 * Spec-vs-implementation agreement is deliberately NOT re-asserted here.
 * `src/release_gate.ts` owns that check, including the parameterised routes
 * that need a maintained matcher list; re-deriving it here would create exactly
 * the kind of second copy this repo keeps having to reconcile. The checks below
 * cover only what the gate does not: whether the DOCS still tell the truth.
 */

describe("the API reference does not misrepresent the route surface", () => {
  // `docs/api-reference.md` is a MODULE EXPORT reference — functions,
  // constants, interfaces — with route rows appearing only where a module's
  // exports are routes. It is deliberately not a route catalogue: `openapi.yaml`
  // is that, and the release gate already proves spec and implementation agree.
  // So the risk here is not completeness but a doc that LIES: advertising a
  // route that no longer exists, or being read as the route inventory when it
  // is not. Both are asserted; completeness is not, because making it complete
  // would create a third hand-maintained copy of the route table to drift.

  test("the reference advertises no route the spec does not publish", () => {
    const reference = read("docs", "api-reference.md");
    const published = new Set(specPaths());
    const claimed = [...reference.matchAll(/`(?:GET|POST) (\/api\/[^`?\s]*)/g)].map(m => m[1]!);
    const stale = [...new Set(claimed.filter(route => !published.has(route)))];
    expect(`stale reference entries: ${stale.join(", ")}`).toBe("stale reference entries: ");
  });

  test("the reference points at the spec as the route authority", () => {
    // Without this, a reader who finds `/api/alerts/correlation` absent from the
    // reference reasonably concludes the route does not exist.
    const reference = read("docs", "api-reference.md");
    expect(reference).toContain("openapi.yaml");
  });

  test("the reference's route rows are a small minority of the surface, not an inventory", () => {
    // Documents WHY this file asserts staleness rather than completeness, so a
    // future reader does not "fix" it by pasting the route table in. The spec is
    // the inventory; a second copy here is a third thing to drift.
    const reference = read("docs", "api-reference.md");
    const claimed = new Set([...reference.matchAll(/`(?:GET|POST) (\/api\/[^`?\s]*)/g)].map(m => m[1]!));
    expect(claimed.size).toBeLessThan(specPaths().length / 4);
  });
});

describe("the architecture document states the current monitor count", () => {
  test("its monitor roster matches MONITOR_KEYS", async () => {
    // A prose count restates the roster, so assert it against MONITOR_KEYS.
    const { MONITOR_KEYS } = await import("../src/alerts/composite.ts");
    const architecture = read("docs", "architecture.md");
    const layer = /Real-Time Intelligence Layer \((\d+) monitors: (\d+) core \+ (\d+) extended\)/
      .exec(architecture);
    expect(layer).not.toBeNull();
    const [, total, core, extended] = layer!;
    expect(Number(total)).toBe(MONITOR_KEYS.length);
    expect(Number(core) + Number(extended)).toBe(MONITOR_KEYS.length);
  });

  test("it names every monitor, so a new one cannot be omitted from the map", async () => {
    const { MONITOR_KEYS } = await import("../src/alerts/composite.ts");
    const { ALERT_MONITOR_SOURCE_NAMES } = await import("../src/alerts/composite.ts");
    const architecture = read("docs", "architecture.md");
    const missing = ALERT_MONITOR_SOURCE_NAMES.filter(name => !architecture.includes(name));
    expect(`monitors missing from the architecture map: ${missing.join(", ")}`)
      .toBe("monitors missing from the architecture map: ");
    expect(Number(MONITOR_KEYS.length)).toBe(ALERT_MONITOR_SOURCE_NAMES.length);
  });
});

describe("the per-directory agent guides exist and are current", () => {
  const GUIDED = ["src", "src/alerts", "src/gui", "src/llm", "src/shared", "scripts", "tests", "docs", "docs/modules"];

  for (const dir of GUIDED) {
    test(`${dir}/AGENTS.md exists`, () => {
      expect(existsSync(join(ROOT, dir, "AGENTS.md"))).toBe(true);
    });
  }

  test("the llm guide describes per-article incremental indexing", () => {
    // The guide describes the indexer as fingerprint-and-skip, which is now only
    // the fast path. A guide that describes the previous mechanism is worse than
    // no guide, because it is what an agent trusts.
    const guide = read("src", "llm", "AGENTS.md");
    expect(guide).toContain("index_plan.ts");
    expect(guide).toContain("article");
  });
});

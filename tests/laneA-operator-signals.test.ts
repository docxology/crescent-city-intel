/**
 * Lane A r2: §5.5 operator-channel artifact + public leakage gates.
 *
 * Positive controls exercise the real export + validate scripts; negative
 * controls feed known-wrong fixtures at the gate logic. No mocks.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "node:os";
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";
import { isOperatorOnlySignal, publicSignalNotice, type OverviewSignal } from "../src/analytics_backend.ts";

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lanea-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function put(root: string, relative: string, value: unknown): Promise<void> {
  await mkdir(join(root, relative, ".."), { recursive: true });
  await writeFile(join(root, relative), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

describe("lane A r2: operator signals artifact (§5.5)", () => {
  test("public analytics omits operator-only fields and unknown backend additions", async () => {
    await withFixture(async root => {
      await put(root, "state/analytics-overview.json", { schemaVersion: "1.0.0", generatedAt: "2026-08-28T00:00:00Z", inputFingerprint: "0".repeat(64), operatorSignalsNoticed: [{ detail: "/Users/private/operator" }], debug: "/Users/private/debug", signals: [{ id: "private", operatorOnly: true, detail: "/Users/private/signal" }] });
      const destination = join(root, "pages");
      await exportPagesSnapshot({ outputDir: root, destination, seedDir: join(root, "no-seed") });
      const analytics = JSON.parse(await readFile(join(destination, "data/analytics.json"), "utf8"));
      expect(analytics.operatorSignalsNoticed).toBeUndefined();
      expect(analytics.debug).toBeUndefined();
      expect(analytics.signals).toEqual([]);
      await expect(readFile(join(destination, "data/operator-signals.json"))).rejects.toThrow();
    });
  }, 60000);

  test("a non-rendered operator artifact added after export fails the complete-tree gate", async () => {
    await withFixture(async root => {
      const destination = join(root, "pages"); await exportPagesSnapshot({ outputDir: root, destination, seedDir: join(root, "no-seed") });
      await put(destination, "data/operator-signals.json", { operatorSignalsNoticed: [{ detail: "/Users/private/operator" }] });
      const { validatePagesArtifact } = await import("../src/pages_validation.ts");
      const errors = await validatePagesArtifact(destination);
      expect(errors.some(error => error.includes("operator-only artifact"))).toBe(true);
      expect(errors.some(error => error.includes("private field"))).toBe(true);
    });
  }, 60000);

  test("negative control: yt-dlp leakage on a public page fails the release gate", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      // A minimal valid analytics overview makes snapshot.analytics non-null,
      // which is what gates the operator artifact emission.
      await put(root, "state/analytics-overview.json", {
        schemaVersion: "1.0.0",
        generatedAt: "2026-08-28T00:00:00Z",
        inputFingerprint: "0".repeat(64),
        operatorSignalsNoticed: [],
      });
      const destination = join(root, "pages");
      await exportPagesSnapshot({ outputDir: root, destination, seedDir: join(root, "no-seed"), generatedAt: "2026-08-28T00:00:00Z" });
      const html = await readFile(join(destination, "news.html"), "utf8");
      await writeFile(join(destination, "news.html"), html.replace("</body>", "<!-- Executable not found in $PATH: \"yt-dlp\" --></body>"));
      const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
      const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
      expect(validate.exitCode).not.toBe(0);
      expect(output).toContain("leaks operator-side detail");
    });
  }, 60000);

  test("unavailable analytics envelope requires no operator artifact (2026-09-08 regression)", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      // No state/analytics-overview.json on purpose: snapshot.analytics is
      // null, so the exporter writes the honest analytics-unavailable
      // envelope and deliberately emits no operator channel. The lane-A gate
      // used to demand the operator artifact whenever data/analytics.json
      // parsed, failing every corpus-less export; it must exempt the
      // unavailable envelope.
      const destination = join(root, "pages");
      await exportPagesSnapshot({ outputDir: root, destination, seedDir: join(root, "no-seed"), generatedAt: "2026-08-28T00:00:00Z" });
      const analytics = JSON.parse(await readFile(join(destination, "data/analytics.json"), "utf8")) as { available?: boolean; schemaVersion?: string };
      expect(analytics.available).toBe(false);
      expect(analytics.schemaVersion).toBe("crescent-city-analytics-unavailable/v1");
      const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
      const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
      // Unavailable code/analytics and an empty feed are legitimate states;
      // the complete edition must validate without an operator artifact.
      expect(validate.exitCode).toBe(0);
      expect(output).not.toContain("missing required Pages asset when analytics exist");
    });
  }, 60000);

  test("publicSignalNotice copy stays free of executable detail (regression guard)", () => {
    const operatorSignal: OverviewSignal = {
      id: "source-youtube",
      category: "source",
      severity: "warning",
      title: "YouTube needs review",
      detail: 'Executable not found in $PATH: "yt-dlp"; RSS fallback failed.',
      evidence: ["status=unavailable"],
      nextStep: "Retry the monitor.",
    };
    expect(isOperatorOnlySignal(operatorSignal)).toBe(true);
    const notice = publicSignalNotice(operatorSignal);
    const serialized = JSON.stringify(notice);
    expect(serialized).not.toContain("yt-dlp");
    expect(serialized).not.toContain("$PATH");
    expect(notice.detail).toContain("monitoring is unavailable this edition");
  });
});

/**
 * Lane A r2: §5.5 operator-channel artifact + public leakage gates.
 *
 * Positive controls exercise the real export + validate scripts; negative
 * controls feed known-wrong fixtures at the gate logic. No mocks.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { exportPagesSnapshot, PAGES_OPERATOR_SIGNALS_ARTIFACT } from "../src/pages_snapshot.ts";
import { isOperatorOnlySignal, publicSignalNotice, type OverviewSignal } from "../src/analytics_backend.ts";

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), ".lanea-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function put(root: string, relative: string, value: unknown): Promise<void> {
  await mkdir(join(root, relative, ".."), { recursive: true });
  await writeFile(join(root, relative), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

describe("lane A r2: operator signals artifact (§5.5)", () => {
  test("exportPagesSnapshot emits data/operator-signals.json matching the overview and no leakage", async () => {
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
      await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-08-28T00:00:00Z" });
      const operatorSource = await readFile(join(destination, PAGES_OPERATOR_SIGNALS_ARTIFACT), "utf8");
      const operator = JSON.parse(operatorSource) as { schemaVersion: string; operatorSignalsNoticed: OverviewSignal[] };
      expect(operator.schemaVersion).toBe("crescent-city-operator-signals/v1");
      expect(Array.isArray(operator.operatorSignalsNoticed)).toBe(true);
      // Even when empty, the artifact preserves the honest operator channel.
      const analytics = JSON.parse(await readFile(join(destination, "data/analytics.json"), "utf8")) as { operatorSignalsNoticed: OverviewSignal[] };
      expect(JSON.stringify(operator.operatorSignalsNoticed)).toBe(JSON.stringify(analytics.operatorSignalsNoticed));
      // No operator-side leakage in the operator artifact itself.
      expect(operatorSource).not.toContain("yt-dlp");
      expect(operatorSource).not.toContain("$PATH");
      // And none on any public page.
      const indexHtml = await readFile(join(destination, "index.html"), "utf8");
      expect(indexHtml).not.toContain("yt-dlp");
      expect(indexHtml).not.toContain("$PATH");
    });
  });

  test("negative control: operator artifact disagreeing with the overview fails the release gate", async () => {
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
      await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-08-28T00:00:00Z" });
      // Corrupt the operator artifact's routed array.
      const parsed = JSON.parse(await readFile(join(destination, PAGES_OPERATOR_SIGNALS_ARTIFACT), "utf8")) as Record<string, unknown>;
      parsed.operatorSignalsNoticed = [{ id: "fabricated", title: "x" }];
      await writeFile(join(destination, PAGES_OPERATOR_SIGNALS_ARTIFACT), `${JSON.stringify(parsed, null, 2)}\n`);
      const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
      const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
      expect(validate.exitCode).not.toBe(0);
      // The empty fixture also trips the feed-items gate; the operator-divergence
      // error must be present in the same failure list.
      expect(output).toContain("does not match data/analytics.json");
    });
  }, 20000);

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
      await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-08-28T00:00:00Z" });
      const html = await readFile(join(destination, "news.html"), "utf8");
      await writeFile(join(destination, "news.html"), html.replace("</body>", "<!-- Executable not found in $PATH: \"yt-dlp\" --></body>"));
      const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
      const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
      expect(validate.exitCode).not.toBe(0);
      expect(output).toContain("leaks operator-side detail");
    });
  }, 20000);

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

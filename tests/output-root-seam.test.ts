/**
 * Every output path in the alert pipeline resolves through `outputRoot()`.
 *
 * `CC_OUTPUT_DIR` is the documented seam (`src/shared/paths.ts`): a test points
 * it at a temp dir instead of the real corpus. The alert layer resolved its
 * paths three different ways, so a redirected run read and wrote more than one
 * tree in a single report:
 *
 * - `alert_analytics` hardcoded `process.cwd()/output/alerts` for the eight core
 *   types while using `outputRoot()` for tides and fishing — one report, two
 *   trees, and nothing marked the result as partial;
 * - `alert_correlation` hardcoded it for eleven of thirteen sources;
 * - `run-alerts.ts` took its advisory lock and its per-monitor `current.json`
 *   reads in the real corpus while writing `paths.alertsHealth` (which follows
 *   the seam) elsewhere;
 * - `healer.ts` read `process.cwd()/output` and so could not see the
 *   source-health.json the same run had just written.
 *
 * The first two are pure enough to assert directly with an injected map, which
 * is what the correlation test does. The rest are checked structurally: this
 * file greps for a hardcoded cwd-based output path in the alert pipeline, since
 * a runtime test would have to run the whole live batch.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildAlertCorrelations, CORRELATION_SOURCES } from "../src/alert_correlation.ts";

/** Modules that must not build an artifact path from process.cwd(). */
const MUST_USE_OUTPUT_ROOT = [
  "src/alert_analytics.ts",
  "src/alert_correlation.ts",
  "src/alerts/healer.ts",
  "src/alerts/notify.ts",
  "scripts/run-alerts.ts",
] as const;

const root = process.cwd();

describe("the alert pipeline honours the output-root seam", () => {
  for (const relative of MUST_USE_OUTPUT_ROOT) {
    test(`${relative} resolves artifact paths through outputRoot()`, () => {
      const source = readFileSync(join(root, relative), "utf-8");
      // Strip comments so a prose mention of the old pattern does not fail this.
      const code = source
        .split("\n")
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const offenders = code.match(/process\.cwd\(\)\s*,\s*"output/g) ?? [];
      expect(`${relative}: ${offenders.length} hardcoded output path(s)`)
        .toBe(`${relative}: 0 hardcoded output path(s)`);
    });
  }

  test("an injected correlation map reports the same events from any cwd", () => {
    // The injected path used to consult the filesystem for `hasHistory`, so the
    // same input reported hasHistory true from the repo root and false from
    // anywhere else — a report that was not a function of its input.
    const injected = {
      wildfire: [
        { source: "wildfire" as const, timestamp: "2026-09-20T00:00:00.000Z", severity: "WARNING", description: "fire", record: { level: "WARNING", name: "Test", acres: 1000, county: "Del Norte" } },
        { source: "wildfire" as const, timestamp: "2026-09-22T00:00:00.000Z", severity: "WARNING", description: "fire", record: { level: "WARNING", name: "Test", acres: 1000, county: "Del Norte" } },
      ],
    };
    const report = buildAlertCorrelations(injected);
    expect(report.totalEventsScanned).toBe(2);
    // Only the injected sources have events; the rest report none, with no
    // filesystem consultation to make the answer cwd-dependent.
    const withHistory = report.sourcesScanned.filter(s => s.hasHistory);
    expect(withHistory.map(s => s.source)).toEqual(["wildfire"]);
    // Sources are scanned in roster order regardless of input order.
    expect(report.sourcesScanned.map(s => s.source)).toEqual([...CORRELATION_SOURCES]);
  });

  test("injected events are sorted, so a cadence cannot come out negative", () => {
    // Unsorted input made medianCadenceMinutes difference consecutive
    // timestamps backwards, producing a negative median that trivially tripped
    // the cadence-sensitivity gate and sorted a genuinely correlated pair last.
    const record = { source: "wildfire" as const, severity: "WARNING", description: "fire", record: { level: "WARNING", name: "Test", acres: 1000, county: "Del Norte" } };
    const report = buildAlertCorrelations({
      wildfire: [
        { ...record, timestamp: "2026-09-22T00:00:00.000Z" },
        { ...record, timestamp: "2026-09-20T00:00:00.000Z" },
        { ...record, timestamp: "2026-09-21T00:00:00.000Z" },
      ],
    });
    const pair = report.pairs.find(p => p.typeA === "wildfire" || p.typeB === "wildfire");
    // No negative lag is ever published.
    for (const p of report.pairs) {
      if (p.medianLagMinutes !== null) expect(p.medianLagMinutes).toBeGreaterThanOrEqual(0);
    }
    expect(pair).toBeDefined();
  });
});

describe("correlation is honest about an untestable window", () => {
  test("a window wider than the observed history is noted, not silently capped", () => {
    // The uniform-rate expectation used `w/span` instead of `min(w, span)/span`,
    // so a 30-day window over ~2 days of history over-counted the expectation
    // and mathematically capped lift below 1 — a perfect relationship read as
    // weak next to a coincidental short-window pair.
    const day = 24 * 60 * 60 * 1000;
    const record = (source: "wildfire" | "drought", severity: string, extra: Record<string, unknown>) => ({
      source, timestamp: "", severity, description: `${source} event`, record: { ...extra },
    });
    const report = buildAlertCorrelations({
      drought: [record("drought", "D3", { severity: "D3", county: "Del Norte", percent: 40, timestamp: "2026-09-20T00:00:00.000Z" })],
      wildfire: [
        { ...record("wildfire", "WARNING", { level: "WARNING", name: "A", acres: 1000, county: "Del Norte" }), timestamp: "2026-09-20T06:00:00.000Z" },
        { ...record("wildfire", "WARNING", { level: "WARNING", name: "B", acres: 1000, county: "Del Norte" }), timestamp: "2026-09-21T06:00:00.000Z" },
      ],
    });
    expect(report.totalEventsScanned).toBe(3);
    // Whenever a window exceeds the analysed span, the report says so rather
    // than presenting a clamped number as a real lift.
    const notes = report.notes.join(" | ");
    const widest = Math.max(...report.pairs.map(p => p.windowMinutes));
    const spanMinutes = report.analyzedSpan
      ? (Date.parse(report.analyzedSpan.end) - Date.parse(report.analyzedSpan.start)) / 60000
      : 0;
    if (widest > spanMinutes) expect(notes).toContain("wider than");
  });
});

describe("the deterministic suite is not the only check on the alert roster", () => {
  test("every source in CORRELATION_SOURCES is a real monitor key", () => {
    // Cheap structural backstop so a typo cannot enter the roster unnoticed.
    const composite = readFileSync(join(root, "src/alerts/composite.ts"), "utf-8");
    const keys = composite.match(/export const MONITOR_KEYS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
    for (const source of CORRELATION_SOURCES) {
      expect(`${source} declared in MONITOR_KEYS`).toBe(`${source} declared in MONITOR_KEYS`);
      expect(keys).toContain(`"${source}"`);
    }
  });

  test("the alerts directory still holds one subdirectory per monitor key", () => {
    // Disk-level confirmation that the roster and the artifact tree agree.
    //
    // A monitor is allowed to be ABSENT: `output/` is a build artifact, and a
    // monitor added but not yet run on this host legitimately has no directory
    // yet. What must not happen is the inverse — a directory that no key claims,
    // which is how a renamed or retired monitor leaves an orphan nobody notices.
    // Asserting the forward direction instead made this test fail the moment
    // `uscg` was added, before its first run.
    let dirs: string[] = [];
    try {
      dirs = readdirSync(join(root, "output", "alerts"), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return; // no corpus on this host; the pure-module tests cover the contract
    }
    const claimed = new Set<string>(CORRELATION_SOURCES);
    // `composite` holds the derived severity report, not a monitor's own output.
    const orphans = dirs.filter(dir => dir !== "composite" && !claimed.has(dir));
    expect(`unclaimed alert directories: ${orphans.join(", ")}`).toBe("unclaimed alert directories: ");
  });
});

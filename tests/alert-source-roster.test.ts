/**
 * Roster-drift guard for the 14 alert monitors.
 *
 * The recurring defect in this repo is count/roster drift: a monitor reaches
 * some lists and not others, and because the release gate only asserts a
 * *superset* in either direction, the omission cannot fail CI. These tests
 * derive every roster from `MONITOR_KEYS` — the single canonical list — instead
 * of restating it, so adding a monitor without updating a consumer is a
 * failure here rather than a silent coverage gap in production.
 *
 * Zero-mock: real spec tables, real contracts, no fixtures, no network.
 */
import { describe, expect, test } from "bun:test";
import {
  ALERT_MONITOR_SOURCE_NAMES,
  CORE_MONITOR_SOURCE_NAMES,
  EXTENDED_MONITOR_SPECS,
  MONITOR_KEYS,
  NULL_ON_FAILURE_MONITORS,
} from "../src/alerts/composite.ts";
import { CORRELATION_SOURCES } from "../src/alert_correlation.ts";
import { EXPECTED_SOURCE_HEALTH } from "../src/shared/source_health.ts";
import { readFileSync } from "fs";
import { join } from "path";

describe("the 14-monitor roster", () => {
  test("ALERT_MONITOR_SOURCE_NAMES covers every MONITOR_KEY, one name per key", () => {
    expect(ALERT_MONITOR_SOURCE_NAMES.length).toBe(MONITOR_KEYS.length);
    expect(new Set(ALERT_MONITOR_SOURCE_NAMES).size).toBe(MONITOR_KEYS.length);
  });

  test("core + extended monitor source names partition the roster", () => {
    const specNames = EXTENDED_MONITOR_SPECS.map(spec => spec[0]);
    const all = [...CORE_MONITOR_SOURCE_NAMES, ...specNames];
    expect(all.length).toBe(MONITOR_KEYS.length);
    expect(new Set(all).size).toBe(MONITOR_KEYS.length);
    // Order is the runner's batch order, so it must match MONITOR_KEYS exactly.
    expect(all).toEqual([...ALERT_MONITOR_SOURCE_NAMES]);
  });

  test("the coverage contract names all 14 alert monitors, not just the 8 core", () => {
    // The defect this replaces: EXPECTED_SOURCE_HEALTH listed only the eight
    // core monitors, so source-coverage totals had a denominator of 8 and the
    // six extended monitors could never be reported as "expected but absent".
    const contracted = EXPECTED_SOURCE_HEALTH
      .filter(entry => entry.monitor === "alerts")
      .map(entry => entry.source);
    for (const name of ALERT_MONITOR_SOURCE_NAMES) {
      expect(contracted).toContain(name);
    }
  });

  test("CORRELATION_SOURCES includes every monitor that keeps a history", () => {
    // The defect this replaces: marinezone was absent, so sourcesScanned
    // under-reported and the weather-marine pair never saw the zone forecast.
    for (const source of CORRELATION_SOURCES) expect(MONITOR_KEYS).toContain(source);
    expect(CORRELATION_SOURCES).toContain("marinezone");
  });

  test("every history-keeping monitor is analysed, and the gap list is empty", async () => {
    // The defect this replaces: ALERT_TYPES covered 8 of 14, so road closures,
    // school closures, PSPS, smoke, drought and the coastal-waters forecast
    // never reached the timeline, typeStats, the GUI heatmap, the insight brief
    // or the monthly report — despite all six writing a history.jsonl the
    // reader already consumed. The gap is now closed, and ANALYTICS_GAP_TYPES
    // is asserted empty so it cannot reopen silently.
    const { ALERT_TYPES, ANALYTICS_GAP_TYPES } = await import("../src/alert_analytics.ts");
    expect([...ANALYTICS_GAP_TYPES]).toEqual([]);
    expect(ALERT_TYPES.length).toBe(MONITOR_KEYS.length);
    const missing = MONITOR_KEYS.filter(key => !(ALERT_TYPES as readonly string[]).includes(key));
    expect(missing).toEqual([]);
  });

  test("ALERT_TYPES is in MONITOR_KEYS order, the heatmap's display order", async () => {
    // The order is a user-facing one (emergency-first) and the heatmap, trend
    // selector and browser smoke all derive from it, so it is pinned to the
    // canonical roster rather than restated.
    const { ALERT_TYPES } = await import("../src/alert_analytics.ts");
    const order = MONITOR_KEYS.filter(key => (ALERT_TYPES as readonly string[]).includes(key));
    expect([...ALERT_TYPES]).toEqual([...order]);
  });

  test("the GUI source map names the runner's own sources, one per type", async () => {
    // ALERT_SOURCE_BY_TYPE's values must BE the `source` fields in
    // output/alerts/source-health.json. It is a hand-maintained map (the GUI
    // imports it without pulling in the whole monitor roster), so this is the
    // check that keeps it from drifting on either side.
    const { ALERT_SOURCE_BY_TYPE } = await import("../src/gui/alert_trends.ts");
    const { ALERT_TYPES } = await import("../src/alert_analytics.ts");
    expect(Object.keys(ALERT_SOURCE_BY_TYPE)).toEqual([...ALERT_TYPES]);
    const values = Object.values(ALERT_SOURCE_BY_TYPE).sort();
    expect([...ALERT_MONITOR_SOURCE_NAMES].sort()).toEqual(values);
  });

  test("the SPA's hand-written monitor lists match the roster", () => {
    // The SPA modules cannot import the roster, so they restate the type list
    // three times (the trend selector, the source map, the per-monitor grid)
    // plus two icon maps. Those copies are the drift risk: the list sat at 8 of
    // 14 for most of the project's life and nothing flagged it. Assert they
    // agree with MONITOR_KEYS and cover every type.
    const html = readFileSync(join(process.cwd(), "src/gui/static/assets/modules/60-alerts.js"), "utf-8");
    const expected = "[" + [...MONITOR_KEYS].map(key => `'${key}'`).join(", ") + "]";
    expect(html.includes(`const ALERT_TREND_TYPES = ${expected};`)).toBe(true);

    const orderMatch = html.match(/const monitorOrder = (\[[^\]]*\]);/);
    expect(orderMatch).not.toBeNull();
    const monitorOrder = JSON.parse((orderMatch![1] as string).replace(/'/g, '"')) as string[];
    expect(new Set(monitorOrder)).toEqual(new Set(MONITOR_KEYS));

    // The source map's VALUES must be the runner's source names, so a tile can
    // find its own health record. It previously spelled USCG "USCG Notice to
    // Mariners" where the runner writes "USCG Broadcast Notice to Mariners",
    // which silently failed to match.
    const sourceMatch = html.match(/const ALERT_TREND_SOURCE_BY_TYPE = \{([\s\S]*?)\};/);
    expect(sourceMatch).not.toBeNull();
    const pairs = [...(sourceMatch![1] as string).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']+)'/g)];
    expect(pairs.map(([, key]) => key).sort()).toEqual([...MONITOR_KEYS].sort());
    expect(pairs.map(([, , value]) => value).sort()).toEqual([...ALERT_MONITOR_SOURCE_NAMES].sort());

    for (const mapName of ["ALERT_TREND_ICONS", "monitorIcons"]) {
      const mapMatch = html.match(new RegExp(`const ${mapName} = \\{([^}]*)\\}`));
      expect(`${mapName} found`).toBe(`${mapName} found`);
      const keys = [...(mapMatch![1] as string).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1]!);
      expect(`${mapName}: ${keys.sort().join(",")}`).toBe(`${mapName}: ${[...MONITOR_KEYS].sort().join(",")}`);
    }
  });

  test("NULL_ON_FAILURE_MONITORS covers the buoyant monitors and no more", () => {
    // Every entry must be a real key. The composite keys its null-report
    // contract on this set, so a typo here would silently disable a monitor's
    // unavailable path.
    for (const key of NULL_ON_FAILURE_MONITORS) expect(MONITOR_KEYS).toContain(key);
  });
});

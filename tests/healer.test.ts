/**
 * Tests for the self-healing monitor system (src/alerts/healer.ts).
 *
 * Pure function tests — no filesystem side effects beyond the temp state file
 * the module writes to output/state/healer-state.json.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, unlink, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// Import the module fresh each test so env changes take effect
async function importHealer() {
  return await import("../src/alerts/healer.ts");
}

const OUTPUT_DIR = join(process.cwd(), "output");
const ALERTS_HEALTH_PATH = join(OUTPUT_DIR, "alerts", "source-health.json");
const HEALER_STATE_PATH = join(OUTPUT_DIR, "state", "healer-state.json");
const COMPOSITE_DIR = join(OUTPUT_DIR, "alerts", "composite");

/** Write a fake source-health.json for testing. */
async function writeHealth(sources: Array<{ source: string; status: string }>) {
  await mkdir(join(OUTPUT_DIR, "alerts"), { recursive: true });
  await writeFile(ALERTS_HEALTH_PATH, JSON.stringify({
    checkedAt: new Date().toISOString(),
    sources: sources.map(s => ({
      source: s.source,
      status: s.status,
      checkedAt: new Date().toISOString(),
      itemCount: 0,
      url: "https://example.com",
      provenance: "test fixture",
    })),
  }, null, 2) + "\n");
}

/** Remove the healer state and alerts health for a clean slate. */
async function cleanState() {
  await unlink(HEALER_STATE_PATH).catch(() => {});
  await unlink(ALERTS_HEALTH_PATH).catch(() => {});
}

describe("Healer — getHealerState", () => {
  beforeEach(cleanState);

  test("returns a fresh state with all 8 monitors when no state file exists", async () => {
    const { getHealerState } = await importHealer();
    const state = await getHealerState();
    expect(state).toBeDefined();
    expect(state.lastCycleRun).toBeTruthy();
    expect(Object.keys(state.monitors).length).toBe(8);
    // Verify all expected monitor keys
    const names = Object.keys(state.monitors).sort();
    expect(names).toContain("NOAA Tsunami");
    expect(names).toContain("USGS Earthquake");
    expect(names).toContain("NWS Weather");
    expect(names).toContain("NOAA Tides");
    expect(names).toContain("CDFW Fishing");
    expect(names).toContain("EPA AirNow");
    expect(names).toContain("CAL FIRE Wildfire");
    expect(names).toContain("NDBC Marine");
  });

  test("all monitors start with zero consecutive failures", async () => {
    const { getHealerState } = await importHealer();
    const state = await getHealerState();
    for (const entry of Object.values(state.monitors)) {
      expect(entry.consecutiveFailures).toBe(0);
      expect(entry.retryCount).toBe(0);
    }
  });

  test("returns fresh state even on corrupt file (graceful degradation)", async () => {
    await mkdir(join(OUTPUT_DIR, "state"), { recursive: true });
    await writeFile(HEALER_STATE_PATH, "{{{ not json }}}\n");
    const { getHealerState } = await importHealer();
    const state = await getHealerState();
    expect(state).toBeDefined();
    expect(Object.keys(state.monitors).length).toBe(8);
  });
});

describe("Healer — runHealingCycle", () => {
  beforeEach(cleanState);

  test("returns zero checks when no source-health.json exists", async () => {
    const { runHealingCycle } = await importHealer();
    const result = await runHealingCycle();
    expect(result.monitorsChecked).toBe(0);
    expect(result.monitorsRetried).toEqual([]);
    expect(result.monitorsRecovered).toEqual([]);
  });

  test("all healthy monitors: no retries, all counters reset", async () => {
    await writeHealth([
      { source: "NOAA Tsunami", status: "ok" },
      { source: "USGS Earthquake", status: "ok" },
      { source: "NWS Weather", status: "ok" },
      { source: "NOAA Tides", status: "ok" },
      { source: "CDFW Fishing", status: "empty" },
      { source: "EPA AirNow", status: "ok" },
      { source: "CAL FIRE Wildfire", status: "ok" },
      { source: "NDBC Marine", status: "ok" },
    ]);
    const { runHealingCycle } = await importHealer();
    const result = await runHealingCycle();
    expect(result.monitorsChecked).toBe(8);
    expect(result.monitorsRetried).toEqual([]);
    expect(result.monitorsRecovered).toEqual([]);
    for (const entry of Object.values(result.state.monitors)) {
      expect(entry.consecutiveFailures).toBe(0);
    }
  });

  test("monitor with unavailable status increments consecutive failures", async () => {
    await writeHealth([
      { source: "NOAA Tsunami", status: "unavailable" },
      { source: "USGS Earthquake", status: "ok" },
      { source: "NWS Weather", status: "ok" },
      { source: "NOAA Tides", status: "ok" },
      { source: "CDFW Fishing", status: "ok" },
      { source: "EPA AirNow", status: "ok" },
      { source: "CAL FIRE Wildfire", status: "ok" },
      { source: "NDBC Marine", status: "ok" },
    ]);
    const { runHealingCycle } = await importHealer();
    const result = await runHealingCycle();
    expect(result.state.monitors["NOAA Tsunami"].consecutiveFailures).toBe(1);
    expect(result.monitorsRetried).toEqual([]); // Not yet at threshold (default 3)
  });

  test("stale status also increments consecutive failures", async () => {
    await writeHealth([
      { source: "NWS Weather", status: "stale" },
      { source: "NOAA Tsunami", status: "ok" },
      { source: "USGS Earthquake", status: "ok" },
      { source: "NOAA Tides", status: "ok" },
      { source: "CDFW Fishing", status: "ok" },
      { source: "EPA AirNow", status: "ok" },
      { source: "CAL FIRE Wildfire", status: "ok" },
      { source: "NDBC Marine", status: "ok" },
    ]);
    const { runHealingCycle } = await importHealer();
    const result = await runHealingCycle();
    expect(result.state.monitors["NWS Weather"].consecutiveFailures).toBe(1);
  });

  test("3 consecutive failures triggers a retry (HEALER_MAX_CONSECUTIVE_FAILURES=3 default)", async () => {
    // Simulate 3 runs of unavailable for the same monitor
    const { runHealingCycle } = await importHealer();

    // Run 1
    await writeHealth([{ source: "EPA AirNow", status: "unavailable" }, { source: "NOAA Tsunami", status: "ok" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "CDFW Fishing", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
    await runHealingCycle();

    // Run 2
    await writeHealth([{ source: "EPA AirNow", status: "unavailable" }, { source: "NOAA Tsunami", status: "ok" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "CDFW Fishing", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
    await runHealingCycle();

    // Run 3 — should trigger retry
    await writeHealth([{ source: "EPA AirNow", status: "unavailable" }, { source: "NOAA Tsunami", status: "ok" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "CDFW Fishing", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
    const result = await runHealingCycle();

    expect(result.monitorsRetried).toContain("EPA AirNow");
    expect(result.state.monitors["EPA AirNow"].consecutiveFailures).toBe(3);
    expect(result.state.monitors["EPA AirNow"].retryCount).toBe(1);
    expect(result.state.monitors["EPA AirNow"].lastRetriedAt).toBeTruthy();
    expect(result.state.monitors["EPA AirNow"].backoffUntil).toBeTruthy();
  });

  test("recovery resets counter and marks monitor as recovered", async () => {
    const { runHealingCycle } = await importHealer();

    // Run 1: fail
    await writeHealth([{ source: "NOAA Tsunami", status: "unavailable" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "CDFW Fishing", status: "ok" }, { source: "EPA AirNow", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
    await runHealingCycle();

    // Run 2: recovered
    await writeHealth([{ source: "NOAA Tsunami", status: "ok" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "CDFW Fishing", status: "ok" }, { source: "EPA AirNow", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
    const result = await runHealingCycle();

    expect(result.monitorsRecovered).toContain("NOAA Tsunami");
    expect(result.state.monitors["NOAA Tsunami"].consecutiveFailures).toBe(0);
    expect(result.state.monitors["NOAA Tsunami"].retryCount).toBe(0);
  });

  test("exponential backoff: retry triggers at threshold then backoff blocks", async () => {
    const { runHealingCycle } = await importHealer();

    // Accumulate 3 failures (default threshold) to trigger retry
    for (let i = 0; i < 3; i++) {
      await writeHealth([{ source: "CDFW Fishing", status: "stale" }, { source: "NOAA Tsunami", status: "ok" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "EPA AirNow", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
      const result = await runHealingCycle();
      if (i === 2) {
        // Third failure triggers retry
        expect(result.state.monitors["CDFW Fishing"].retryCount).toBe(1);
        expect(result.monitorsRetried).toContain("CDFW Fishing");
        expect(result.state.monitors["CDFW Fishing"].backoffUntil).toBeTruthy();
      }
    }

    // 4th failure: backoff has NOT expired (5min delay), so retryCount stays at 1
    await writeHealth([{ source: "CDFW Fishing", status: "stale" }, { source: "NOAA Tsunami", status: "ok" }, { source: "USGS Earthquake", status: "ok" }, { source: "NWS Weather", status: "ok" }, { source: "NOAA Tides", status: "ok" }, { source: "EPA AirNow", status: "ok" }, { source: "CAL FIRE Wildfire", status: "ok" }, { source: "NDBC Marine", status: "ok" }]);
    const fourth = await runHealingCycle();
    // Backoff blocks, so retryCount stays at 1
    expect(fourth.state.monitors["CDFW Fishing"].retryCount).toBe(1);
    expect(fourth.monitorsRetried).toEqual([]);
  });

  test("never throws even on corrupt input", async () => {
    await mkdir(join(OUTPUT_DIR, "alerts"), { recursive: true });
    await writeFile(ALERTS_HEALTH_PATH, "{{{ total garbage }}}\n");
    const { runHealingCycle } = await importHealer();
    // Should not throw
    const result = await runHealingCycle();
    expect(result.monitorsChecked).toBe(0);
  });
});

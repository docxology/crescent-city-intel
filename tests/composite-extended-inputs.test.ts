/**
 * The composite alert level must hear every monitor that ran.
 *
 * `computeAlertSeverity` takes fourteen monitor inputs. Originally it took
 * thirteen: the runner passed eight, and the remaining five — drought, PSPS,
 * smoke, road closures, school closures — fell back to their "nothing happening,
 * not available" defaults. So the county-level alert state published on the
 * front page could read CLEAR
 * while the road monitor's own artifact recorded a full US-101 closure and the
 * school monitor recorded a district closure.
 *
 * These tests drive the real mapper and the real severity function: the proof is
 * that a monitor's finding changes the composite outcome, not that a field was
 * copied.
 */
import { describe, expect, test } from "bun:test";
import { buildExtendedCompositeInput } from "../src/alerts/composite.ts";
import { computeAlertSeverity } from "../src/alerts/severity.ts";
import { buildHmsSmokeReport } from "../src/alerts/hrrr_smoke.ts";

/** The eight original inputs, all quiet and available (real interface shapes). */
const QUIET_BASE = [
  { warningCount: 0, watchCount: 0, available: true },
  { events: [], available: true },
  { severities: [], count: 0, available: true },
  { waterLevelFt: 3, available: true },
  { closureActive: false, available: true },
  { maxAqi: 20, available: true },
  { incidentCount: 0, hasEvacuationOrders: false, hasLargeFireNearby: false },
  { waveHeightFt: 2, windSpeedKt: 5, available: true },
] as const;

/** Compute severity from the quiet base plus whatever the extended monitors said. */
function severityWith(reports: Parameters<typeof buildExtendedCompositeInput>[0]) {
  const extended = buildExtendedCompositeInput(reports);
  /** The eight core severity inputs, in computeAlertSeverity's positional order. */
  type CoreSeverityInputs = [
    Parameters<typeof computeAlertSeverity>[0],
    Parameters<typeof computeAlertSeverity>[1],
    Parameters<typeof computeAlertSeverity>[2],
    Parameters<typeof computeAlertSeverity>[3],
    Parameters<typeof computeAlertSeverity>[4],
    Parameters<typeof computeAlertSeverity>[5],
    Parameters<typeof computeAlertSeverity>[6],
    Parameters<typeof computeAlertSeverity>[7],
  ];
  return computeAlertSeverity(
    ...(QUIET_BASE as unknown as CoreSeverityInputs),
    extended.drought as Parameters<typeof computeAlertSeverity>[8],
    extended.psps as Parameters<typeof computeAlertSeverity>[9],
    extended.smoke as Parameters<typeof computeAlertSeverity>[10],
    extended.roads as Parameters<typeof computeAlertSeverity>[11],
    extended.schools as Parameters<typeof computeAlertSeverity>[12],
    extended.marinezone as Parameters<typeof computeAlertSeverity>[13],
    extended.uscg as Parameters<typeof computeAlertSeverity>[14],
  );
}

/**
 * The extended monitors are freshness-gated through the same `isFreshReport` as
 * the eight core ones, so a fixture must be stamped like a real report — every
 * real extended report interface carries a `timestamp`. `FRESH` is the stamp for
 * "this run"; `STALE` is one well outside the alert freshness window.
 */
const FRESH = new Date().toISOString();
const STALE = "2020-01-01T00:00:00.000Z";

describe("extended monitors reach the composite severity", () => {
  test("an all-quiet run with every monitor reporting is not escalated by the mapping itself", () => {
    const report = severityWith({
      drought: { timestamp: FRESH, compositeSeverity: "NONE", severeDroughtPercent: 0 },
      psps: { timestamp: FRESH, overallStatus: "NONE", totalEvents: 0, delNorteAffected: false },
      smoke: buildHmsSmokeReport({ mapDate: FRESH.slice(0, 10).replaceAll("-", ""), maxDensity: "Light", plumes: 0 }, FRESH),
      roads: { timestamp: FRESH, overallSeverity: "NONE", hasMajorClosure: false, totalIncidents: 0 },
      schools: { timestamp: FRESH, districtStatus: "OPEN", hasActiveClosure: false, hasActiveDelay: false, totalEvents: 0 },
    });
    expect(report.level).toBe("CALM");
  });

  test("a full closure on a major route raises the composite above the quiet baseline", () => {
    const quiet = severityWith({});
    const closed = severityWith({
      roads: { timestamp: FRESH, overallSeverity: "CLOSURE", hasMajorClosure: true, totalIncidents: 4 },
    });
    // The specific level is severity.ts's business; what this test pins is that
    // the finding REACHES it, which it did not before.
    expect(closed.level).not.toBe(quiet.level);
    expect(JSON.stringify(closed)).toContain("road");
  });

  test("an active district closure reaches the composite", () => {
    const quiet = severityWith({});
    const closed = severityWith({
      schools: { timestamp: FRESH, districtStatus: "CLOSED", hasActiveClosure: true, hasActiveDelay: false, totalEvents: 2 },
    });
    expect(closed.level).not.toBe(quiet.level);
  });

  test("an active PSPS affecting Del Norte reaches the composite", () => {
    const quiet = severityWith({});
    const psps = severityWith({
      psps: { timestamp: FRESH, overallStatus: "ACTIVE", totalEvents: 1, delNorteAffected: true },
    });
    expect(psps.level).not.toBe(quiet.level);
  });

  test("mapped heavy HMS plume reaches WATCH with unknown surface exposure", () => {
    const quiet = severityWith({});
    const smoke = severityWith({ smoke: buildHmsSmokeReport({ mapDate: FRESH.slice(0, 10).replaceAll("-", ""), maxDensity: "Heavy", plumes: 3 }, FRESH) });
    expect(smoke.level).not.toBe(quiet.level);
  });

  test("a finding from a stale snapshot does not reach the composite as a current one", () => {
    // The freshness gate the extended monitors were missing: a road closure
    // recorded yesterday is not the county's road state now. Before the gate,
    // `available` was `reports.X != null`, so a day-old report scored as current
    // while the core monitors went stale after an hour.
    const stale = severityWith({
      roads: { timestamp: STALE, overallSeverity: "CLOSURE", hasMajorClosure: true, totalIncidents: 4 },
    });
    const absent = severityWith({});
    expect(stale.monitors.roads.level).toBe("CALM");
    expect(stale.monitors.roads.availability).toBe("unavailable");
    expect(stale.level).toBe(absent.level);
  });

  test("a USCG broadcast advisory reaches the composite", () => {
    const quiet = severityWith({});
    const advisory = severityWith({ uscg: { timestamp: FRESH, worstLevel: "ADVISORY", totalBroadcasts: 1, relevantCount: 1 } });
    expect(quiet.level).toBe("CALM");
    // BNM traffic is informational, so the composite's advisory-class WATCH is
    // the ceiling it can impose — the same mapping NWS advisories get.
    expect(advisory.level).toBe("WATCH");
    expect(advisory.monitors.uscg.level).toBe("WATCH");
    expect(advisory.monitors.uscg.availability).toBeUndefined();
  });
});

describe("the mapping is honest about what the monitors reported", () => {
  test("a monitor that produced no report is unavailable, not calm", () => {
    const input = buildExtendedCompositeInput({});
    for (const key of ["drought", "psps", "smoke", "roads", "schools"]) {
      expect(`${key}: ${(input[key] as { available: boolean }).available}`).toBe(`${key}: false`);
    }
  });

  test("a report's own fields are carried through unchanged, not re-derived", () => {
    const input = buildExtendedCompositeInput({
      drought: { timestamp: FRESH, productDate: FRESH.slice(0, 10), compositeSeverity: "D3", severeDroughtPercent: 42 },
      roads: { timestamp: FRESH, overallSeverity: "WARNING", hasMajorClosure: false, totalIncidents: 7 },
      schools: { timestamp: FRESH, districtStatus: "DELAYED", hasActiveClosure: false, hasActiveDelay: true, totalEvents: 1 },
    });
    expect(input.drought).toEqual({ severity: "D3", severeDroughtPercent: 42, available: true });
    expect(input.roads).toEqual({ severity: "WARNING", hasMajorClosure: false, incidentCount: 7, available: true });
    expect(input.schools).toEqual({ status: "DELAYED", hasActiveClosure: false, hasActiveDelay: true, eventCount: 1, available: true });
  });

  test("a malformed current report is unavailable and cannot manufacture calm coverage", () => {
    // Present-but-unreadable is a different fact from absent: the monitor ran,
    // it just did not emit the fields the mapper reads. The freshness stamp is
    // what makes it "present" now, exactly as a real report carries one.
    const input = buildExtendedCompositeInput({ roads: { timestamp: FRESH, unexpected: true } });
    expect(input.roads).toEqual({ severity: "NONE", hasMajorClosure: false, incidentCount: 0, available: false });
  });

  test("a report with no freshness stamp is treated as stale, not as current", () => {
    // The whole point of the gate: `isFreshReport` reads `fetchedAt ?? timestamp`
    // and treats neither-present as stale forever. That is precisely how the
    // NWS marine forecast read as permanently stale — it had no timestamp at all.
    const input = buildExtendedCompositeInput({ roads: { hasMajorClosure: true, totalIncidents: 4 } });
    expect((input.roads as { available: boolean }).available).toBe(false);
  });
});

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
  return computeAlertSeverity(
    ...(QUIET_BASE as unknown as Parameters<typeof computeAlertSeverity>),
    extended.drought as Parameters<typeof computeAlertSeverity>[8],
    extended.psps as Parameters<typeof computeAlertSeverity>[9],
    extended.smoke as Parameters<typeof computeAlertSeverity>[10],
    extended.roads as Parameters<typeof computeAlertSeverity>[11],
    extended.schools as Parameters<typeof computeAlertSeverity>[12],
    extended.marinezone as Parameters<typeof computeAlertSeverity>[13],
  );
}

describe("extended monitors reach the composite severity", () => {
  test("an all-quiet run with every monitor reporting is not escalated by the mapping itself", () => {
    const report = severityWith({
      drought: { compositeSeverity: "NONE", severeDroughtPercent: 0 },
      psps: { overallStatus: "NONE", totalEvents: 0, delNorteAffected: false },
      smoke: { peakLevel: "GOOD", peakAqi: 10, maxPm25: 2 },
      roads: { overallSeverity: "NONE", hasMajorClosure: false, totalIncidents: 0 },
      schools: { districtStatus: "OPEN", hasActiveClosure: false, hasActiveDelay: false, totalEvents: 0 },
    });
    expect(report.level).toBe("CALM");
  });

  test("a full closure on a major route raises the composite above the quiet baseline", () => {
    const quiet = severityWith({});
    const closed = severityWith({
      roads: { overallSeverity: "CLOSURE", hasMajorClosure: true, totalIncidents: 4 },
    });
    // The specific level is severity.ts's business; what this test pins is that
    // the finding REACHES it, which it did not before.
    expect(closed.level).not.toBe(quiet.level);
    expect(JSON.stringify(closed)).toContain("road");
  });

  test("an active district closure reaches the composite", () => {
    const quiet = severityWith({});
    const closed = severityWith({
      schools: { districtStatus: "CLOSED", hasActiveClosure: true, hasActiveDelay: false, totalEvents: 2 },
    });
    expect(closed.level).not.toBe(quiet.level);
  });

  test("an active PSPS affecting Del Norte reaches the composite", () => {
    const quiet = severityWith({});
    const psps = severityWith({
      psps: { overallStatus: "ACTIVE", totalEvents: 1, delNorteAffected: true },
    });
    expect(psps.level).not.toBe(quiet.level);
  });

  test("hazardous forecast smoke reaches the composite", () => {
    const quiet = severityWith({});
    const smoke = severityWith({ smoke: { peakLevel: "HAZARDOUS", peakAqi: 320, maxPm25: 250 } });
    expect(smoke.level).not.toBe(quiet.level);
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
      drought: { compositeSeverity: "D3", severeDroughtPercent: 42 },
      roads: { overallSeverity: "WARNING", hasMajorClosure: false, totalIncidents: 7 },
      schools: { districtStatus: "DELAYED", hasActiveClosure: false, hasActiveDelay: true, totalEvents: 1 },
    });
    expect(input.drought).toEqual({ severity: "D3", severeDroughtPercent: 42, available: true });
    expect(input.roads).toEqual({ severity: "WARNING", hasMajorClosure: false, incidentCount: 7, available: true });
    expect(input.schools).toEqual({ status: "DELAYED", hasActiveClosure: false, hasActiveDelay: true, eventCount: 1, available: true });
  });

  test("a malformed report degrades to the quiet defaults but stays marked available", () => {
    // Present-but-unreadable is a different fact from absent: the monitor ran.
    const input = buildExtendedCompositeInput({ roads: { unexpected: true } });
    expect(input.roads).toEqual({ severity: "NONE", hasMajorClosure: false, incidentCount: 0, available: true });
  });
});

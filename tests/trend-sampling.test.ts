import { test, expect } from "bun:test";
import { assessSampling } from "../src/trend_sampling.ts";
const nowMs = Date.parse("2026-09-30T00:00:00Z"), day = 86_400_000;
const row = (at: number, status = "ok", source = "one") => ({ checkedAt: new Date(at).toISOString(), sources: [{ source, sourceId: source, checkedAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString(), status, itemCount: 0 }] });
const options = { nowMs, windowDays: 2, intervalMs: day, expectedSources: ["one"] };
test("irregular polling and repeated checks use slots, with empty windows and invalid rows explicit", () => {
  const checks = [row(nowMs), row(nowMs - day), row(nowMs - 2 * day), row(nowMs - 3 * day)];
  const result = assessSampling([...checks, ...checks, row(nowMs - 1000)], options);
  expect(result.comparable).toBe(true); expect(result.current.observedSlots).toBe(2); expect(result.duplicateChecks).toBe(4);
  expect(assessSampling([], options).current.missingSlots).toBe(2);
  expect(assessSampling([...checks, null], options).comparable).toBe(false);
  expect(assessSampling([row(nowMs), row(nowMs - day, "unavailable"), ...checks.slice(2)], options).comparable).toBe(false);
});
test("changed source coverage and future checks cannot masquerade as a trend", () => {
  const changed = assessSampling([row(nowMs), row(nowMs - day), row(nowMs - 2 * day, "ok", "two"), row(nowMs - 3 * day, "ok", "two")], { ...options, expectedSources: ["one", "two"] });
  expect(changed.comparable).toBe(false); expect(changed.current.coveragePercent).toBe(50);
  const future = assessSampling([row(nowMs + day)], options); expect(future.invalidRows).toBe(1); expect(future.current.observedSlots).toBe(0);
});

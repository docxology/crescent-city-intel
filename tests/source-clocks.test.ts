import { test, expect } from "bun:test";
import { assessSourceClock } from "../src/source_clocks.ts";
import { sourceHealth, completeSourceHealth, writeJsonAtomic } from "../src/shared/source_health.ts";
import { withRunSignal } from "../src/shared/run_scope.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const now = Date.parse("2026-09-30T12:00:00Z");
test("fresh retrieval cannot freshen an old buoy, fuel week, or drought product", () => {
  expect(assessSourceClock("marine", { fetchedAt: new Date(now).toISOString(), observations: [{ timestamp: "2026-09-29T12:00:00Z" }] }, now).observationFreshness).toBe("stale");
  expect(assessSourceClock("fuel", { fetchedAt: new Date(now).toISOString(), latest: { weekOf: "2026-09-14" } }, now).usable).toBe(false);
  expect(assessSourceClock("drought", { fetchedAt: new Date(now).toISOString(), productDate: "2026-09-22", validUntil: "2026-09-28T23:59:59Z" }, now).usable).toBe(false);
  expect(assessSourceClock("drought", { productDate: "2026-09-29" }, now).usable).toBe(true);
  expect(assessSourceClock("marine", { observedAt: "2026-10-01T12:00:00Z" }, now).observationFreshness).toBe("unknown");
  expect(assessSourceClock("marine", { observedAt: "2026-02-30T12:00:00Z" }, now).usable).toBe(false);
  expect(assessSourceClock("drought", { timestamp: new Date(now).toISOString() }, now).usable).toBe(false);
  expect(assessSourceClock('ais', { fetchedAt: new Date(now).toISOString(), vesselsInWatchArea: [{ positionAt: '2026-09-30T11:50:00Z' }] }, now).usable).toBe(true);
  expect(assessSourceClock('ais', { fetchedAt: new Date(now).toISOString(), vesselsInWatchArea: [{ positionAt: '2026-09-30T11:00:00Z' }] }, now).observationFreshness).toBe('stale');
});
test("consumers reassess observation age while retaining original check and retrieval clocks", () => {
  const original = sourceHealth("NDBC Marine", "ok", "2026-09-30T10:00:00Z", { fetchedAt: "2026-09-30T10:00:00Z", observedAt: "2026-09-30T09:30:00Z", timestampBasis: "observation", freshnessWindowMs: 2 * 3_600_000 });
  const current = completeSourceHealth([original], new Date(now).toISOString()).find(row => row.source === original.source)!;
  expect(current.status).toBe("stale"); expect(current.checkedAt).toBe(original.checkedAt); expect(current.fetchedAt).toBe(original.fetchedAt); expect(current.observationAgeMs).toBe(9_000_000);
});
test("inherited cancellation preserves the prior artifact; trusted recovery can record interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-clock-cancel-")), path = join(root, "state.json");
  const controller = new AbortController();
  try {
    await writeJsonAtomic(path, { state: "valid" });
    await withRunSignal(controller.signal, async () => { controller.abort(); await expect(writeJsonAtomic(path, { state: "late" })).rejects.toThrow(); await writeJsonAtomic(join(root, "attempt.json"), { state: "interrupted" }, { signal: null }); });
    expect(JSON.parse(await readFile(path, "utf8")).state).toBe("valid");
  } finally { await rm(root, { recursive: true, force: true }); }
});

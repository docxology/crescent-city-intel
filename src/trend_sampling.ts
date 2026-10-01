/** Sampling denominators are evidence, not proxies for civic or hazard frequency. */
import { isIsoTimestamp, isSourceHealthReceipt } from "./shared/source_health.js";
import type { SourceHealth } from "./types.js";
import { EXPECTED_SOURCE_HEALTH } from "./shared/source_health.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export interface SamplingWindow {
  startMs: number; endMs: number; intervalMs: number; expectedSlots: number;
  observedSlots: number; presentSlots: number; unavailableSlots: number; missingSlots: number;
  coveragePercent: number; presentSourceIds: string[];
}
export interface SamplingReceipt { schemaVersion: "civic-sampling/v1"; current: SamplingWindow; previous: SamplingWindow; invalidRows: number; duplicateChecks: number; comparable: boolean; reason: string; unit: "distinct source checks per declared sampling slot" }
/** A missing historical check stays a gap, even when activity records exist. */
export function assessSampling(envelopes: unknown[], options: { nowMs: number; windowDays: number; intervalMs: number; expectedSources: string[] }): SamplingReceipt {
  const { nowMs, windowDays, intervalMs } = options;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 366 || !Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 31 * 86_400_000 || options.expectedSources.length > 1000 || !options.expectedSources.length || new Set(options.expectedSources).size !== options.expectedSources.length) throw new Error("Invalid sampling denominator");
  const width = windowDays * 86_400_000;
  const make = (startMs: number, endMs: number): SamplingWindow => ({ startMs, endMs, intervalMs, expectedSlots: Math.ceil(width / intervalMs) * options.expectedSources.length, observedSlots: 0, presentSlots: 0, unavailableSlots: 0, missingSlots: 0, coveragePercent: 0, presentSourceIds: [] });
  const current = make(nowMs - width, nowMs), previous = make(nowMs - 2 * width, nowMs - width);
  const receipt: SamplingReceipt = { schemaVersion: "civic-sampling/v1", current, previous, invalidRows: 0, duplicateChecks: 0, comparable: false, reason: "insufficient sampling evidence", unit: "distinct source checks per declared sampling slot" };
  const checks = new Set<string>();
  const slots = new Map<SamplingWindow, Map<string, { at: number; health: SourceHealth }>>([[current, new Map()], [previous, new Map()]]);
  for (const raw of envelopes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).sources) || !isIsoTimestamp((raw as Record<string, unknown>).checkedAt)) { receipt.invalidRows++; continue; }
    for (const health of (raw as { sources: unknown[] }).sources) {
      if (!isSourceHealthReceipt(health)) { receipt.invalidRows++; continue; }
      const identity = health.sourceId && options.expectedSources.includes(health.sourceId) ? health.sourceId : health.source;
      if (!options.expectedSources.includes(identity)) continue;
      const at = Date.parse(health.checkedAt); if (at > nowMs) { receipt.invalidRows++; continue; }
      const check = `${identity}|${health.checkedAt}`;
      if (checks.has(check)) { receipt.duplicateChecks++; continue; } checks.add(check);
      const window = at > current.startMs ? current : at > previous.startMs && at <= previous.endMs ? previous : null;
      if (!window || at > window.endMs) continue;
      const key = `${identity}|${Math.ceil((at - window.startMs) / intervalMs) - 1}`;
      const prior = slots.get(window)!.get(key);
      if (!prior || at > prior.at) slots.get(window)!.set(key, { at, health });
    }
  }
  for (const window of [current, previous]) {
    for (const { health } of slots.get(window)!.values()) {
      window.observedSlots++;
      if (["ok", "empty"].includes(health.status)) { window.presentSlots++; window.presentSourceIds.push(health.sourceId && options.expectedSources.includes(health.sourceId) ? health.sourceId : health.source); }
      else window.unavailableSlots++;
    }
    window.missingSlots = window.expectedSlots - window.observedSlots;
    window.coveragePercent = Math.round(window.presentSlots / window.expectedSlots * 10_000) / 100;
    window.presentSourceIds = [...new Set(window.presentSourceIds)].sort();
  }
  receipt.comparable = receipt.invalidRows === 0 && current.coveragePercent >= 80 && previous.coveragePercent >= 80 && JSON.stringify(current.presentSourceIds) === JSON.stringify(previous.presentSourceIds);
  receipt.reason = receipt.comparable ? "same declared sources and at least 80% present sampling slots in both windows" : "coverage changed, checks are missing, or history is invalid; activity counts do not establish a civic trend";
  return receipt;
}
/** Bounded recorded history, with explicit gaps; no activity row substitutes for a check. */
export async function readSamplingReceipt(root: string, generatedAt: string, windowDays = 30): Promise<SamplingReceipt> {
  const inputs: unknown[] = [];
  for (const folder of ['alerts', 'news', 'gov_meetings', 'youtube', 'triplicate']) {
    try {
      const bytes = await (await import('./shared/artifact_transaction.js')).readBoundedArtifact(join(root, folder, 'source-health-history.jsonl'), 16_000_000);
      if (!bytes) continue;
      for (const line of bytes.toString('utf8').split('\n').filter(Boolean).slice(-10_000)) { try { inputs.push(JSON.parse(line)); } catch { inputs.push(null); } }
    } catch { inputs.push(null); }
  }
  return assessSampling(inputs, { nowMs: Date.parse(generatedAt), windowDays, intervalMs: 7 * 86_400_000, expectedSources: EXPECTED_SOURCE_HEALTH.map(source => source.source) });
}

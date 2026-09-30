/**
 * Self-healing monitor system for alert monitors.
 *
 * Tracks consecutive "unavailable" or "stale" runs per monitor. When a monitor
 * crosses the threshold (N consecutive failures, configurable default 3) it is
 * marked eligible for retry and given an exponential backoff window —
 * 5min, 15min, 1hr, 4hr — so a failing monitor is re-attempted no more often
 * than the backoff allows.
 *
 * Scope, stated plainly: this module identifies and schedules. It does not
 * itself re-invoke a monitor; the alert batch independently checks its requested
 * roster. A monitor
 * named here is "eligible for retry", not "has been retried by this module".
 *
 * State is persisted to output/state/healer-state.json so it survives restarts.
 * NEVER throws — graceful degradation at every step.
 *
 * Env:
 *   HEALER_MAX_CONSECUTIVE_FAILURES (default 3)
 *   HEALER_RETRY_BACKOFF_CAP_MS     (default 4 * 60 * 60 * 1000 = 4 hours)
 */
import { createLogger } from "../logger.js";
import { outputRoot } from "../shared/paths.js";
import { ALERT_MONITOR_SOURCE_NAMES as MONITOR_SOURCE_NAMES, MONITOR_KEYS } from "./composite.js";
import { readFile } from "fs/promises";
import { writeJsonAtomic } from "../shared/source_health.js";
import { withFileLease } from "../shared/storage.js";
import { existsSync } from "fs";
import { join } from "path";

const log = createLogger("healer");

// ─── Constants ────────────────────────────────────────────────────────────

// Dependency-injection seam: tests point HEALER_OUTPUT_DIR at a temp dir so the
// healing cycle never reads or writes the real output/ tree. Resolved at call
// time so module-load order across test files can never freeze a wrong dir.
// Falls back to `outputRoot()` (the CC_OUTPUT_DIR seam) rather than a hardcoded
// cwd, so a redirected run has the healer read the same tree it wrote — it
// previously read `process.cwd()/output` and so could not see the
// source-health.json the same run had just written elsewhere.
function healerOutputDir(): string {
  return process.env.HEALER_OUTPUT_DIR ?? outputRoot();
}
function healerStatePath(): string {
  return join(healerOutputDir(), "state", "healer-state.json");
}

/**
 * All alert-monitor source names (matching source-health.json keys),
 * imported from the canonical roster in composite.ts. This was previously a
 * private hard-coded list of only the 8 core monitors, so the five Phase-12
 * extended monitors (USDM Drought, PG&E PSPS, HRRR Smoke, Caltrans Roads,
 * DUSD Schools) never accumulated failures, never reached the retry
 * threshold, and were invisible to healing — even though their health
 * records sit in the same source-health.json this module reads.
 */

/** Exponential backoff steps in ms: 5min, 15min, 1hr, 4hr */
const BACKOFF_STEPS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
] as const;

// ─── Types ────────────────────────────────────────────────────────────────

export interface HealerEntry {
  /** Name of the monitor (matches source-health.json source field). */
  source: string;
  /** Current consecutive failure count (unavailable or stale runs). */
  consecutiveFailures: number;
  /** Number of retry-eligibility notices; this is not an execution count. */
  retryCount: number;
  /** When this entry was last updated (ISO-8601). */
  lastUpdated: string;
  /** Last retry-eligibility notice, or empty; no retry execution is implied. */
  lastRetriedAt: string;
  /** ISO-8601 timestamp of when the current backoff period ends, or empty. */
  backoffUntil: string;
}

export interface HealerState {
  /** ISO-8601 timestamp of the last healing cycle run. */
  lastCycleRun: string;
  /** Per-monitor healing entries keyed by source name. */
  monitors: Record<string, HealerEntry>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Parse a positive integer env var with a fallback. */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Max consecutive failures before triggering a retry (default 3).
 *
 * Read at call time, not module load, for the same reason `healerOutputDir` is:
 * the env var is part of the documented test seam, and a frozen module-level
 * read silently ignores it when a test (or a runtime reconfiguration) sets it
 * after import.
 */
function maxConsecutiveFailures(): number {
  return envInt("HEALER_MAX_CONSECUTIVE_FAILURES", 3);
}

/** Read the source-health.json file produced by the alert monitor runner. */
async function readSourceHealthFile(): Promise<Record<string, unknown> | null> {
  const path = join(healerOutputDir(), "alerts", "source-health.json");
  if (!existsSync(path)) {
    log.warn("Alerts source-health.json not found; healing cycle skipped");
    return null;
  }
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn("Failed to parse source-health.json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Compute exponential backoff end time given the retry count. */
function computeBackoffUntil(retryCount: number, now: number): string {
  const stepIndex = Math.min(Math.max(0, retryCount - 1), BACKOFF_STEPS_MS.length - 1);
  const delayMs = Math.min(BACKOFF_STEPS_MS[stepIndex], envInt("HEALER_RETRY_BACKOFF_CAP_MS", 4 * 60 * 60 * 1000));
  return new Date(now + delayMs).toISOString();
}

// ─── State Persistence ────────────────────────────────────────────────────

/** Create a fresh empty healer state. */
function freshState(now: string): HealerState {
  const monitors: Record<string, HealerEntry> = {};
  for (const source of MONITOR_SOURCE_NAMES) {
    monitors[source] = {
      source,
      consecutiveFailures: 0,
      retryCount: 0,
      lastUpdated: now,
      lastRetriedAt: "",
      backoffUntil: "",
    };
  }
  return { lastCycleRun: now, monitors };
}

/** Load healer state from disk. Returns a fresh state if the file doesn't exist or is corrupt. */
async function loadState(): Promise<HealerState> {
  try {
    if (!existsSync(healerStatePath())) return freshState(new Date().toISOString());
    const raw = await readFile(healerStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as HealerState;
    // Ensure every tracked monitor (the full roster) exists in the loaded state
    const now = new Date().toISOString();
    for (const source of MONITOR_SOURCE_NAMES) {
      if (!parsed.monitors[source]) {
        parsed.monitors[source] = {
          source,
          consecutiveFailures: 0,
          retryCount: 0,
          lastUpdated: now,
          lastRetriedAt: "",
          backoffUntil: "",
        };
      }
    }
    return parsed;
  } catch {
    return freshState(new Date().toISOString());
  }
}

/** Persist healer state atomically. Never throws. */
async function saveState(state: HealerState): Promise<void> {
  try {
    await writeJsonAtomic(healerStatePath(), state);
  } catch (err) {
    log.warn("Failed to persist healer state (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Read the current healer state without running a healing cycle.
 * Returns the state as-is; never throws — returns a fresh default on error.
 */
export async function getHealerState(): Promise<HealerState> {
  try {
    return await loadState();
  } catch {
    return freshState(new Date().toISOString());
  }
}

/**
 * Run one healing cycle:
 * 1. Load the latest source-health.json from the alert monitors.
 * 2. For each monitor that is "unavailable" or "stale", increment its consecutiveFailures.
 * 3. For a monitor with clean status, reset its counter.
 * 4. When consecutiveFailures >= threshold, check if backoff expired; if so, retry.
 * 5. Persist the updated state.
 *
 * NEVER throws. Returns a summary of what happened.
 */
async function runHealingCycleUnlocked(): Promise<{
  cycleRun: string;
  monitorsChecked: number;
  monitorsRetried: string[];
  monitorsRecovered: string[];
  state: HealerState;
}> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const retried: string[] = [];
  const recovered: string[] = [];

  try {
    const health = await readSourceHealthFile();
    const state = await loadState();
    state.lastCycleRun = nowIso;

    if (!health) {
      await saveState(state);
      return { cycleRun: nowIso, monitorsChecked: 0, monitorsRetried: retried, monitorsRecovered: recovered, state };
    }

    const sources = (health as any).sources;
    if (!Array.isArray(sources)) {
      log.warn("source-health.json has no sources array; skipping healing assessment");
      await saveState(state);
      return { cycleRun: nowIso, monitorsChecked: 0, monitorsRetried: retried, monitorsRecovered: recovered, state };
    }

    const notRequested = new Set(Array.isArray(health.attempts) ? health.attempts.filter(entry => entry && typeof entry === "object" && (entry as Record<string, unknown>).requested === false).map(entry => (entry as Record<string, unknown>).key) : []);
    const checked = new Set<string>();
    for (const entry of sources) {
      const sourceName = entry?.source;
      if (typeof sourceName !== "string" || checked.has(sourceName)) continue;

      const monitor = state.monitors[sourceName];
      if (!monitor) continue;
      const key = MONITOR_SOURCE_NAMES.indexOf(sourceName as typeof MONITOR_SOURCE_NAMES[number]);
      if (notRequested.has(MONITOR_KEYS[key])) continue;
      checked.add(sourceName);

      const status: string = entry?.status ?? "";
      const isFailing = status !== "ok" && status !== "empty";

      if (isFailing) {
        monitor.consecutiveFailures += 1;
        if (monitor.consecutiveFailures >= maxConsecutiveFailures()) {
          const backoffTime = monitor.backoffUntil ? Date.parse(monitor.backoffUntil) : 0;
          if (!monitor.backoffUntil || (Number.isFinite(backoffTime) && now >= backoffTime)) {
            monitor.retryCount += 1;
            monitor.lastRetriedAt = nowIso;
            monitor.backoffUntil = computeBackoffUntil(monitor.retryCount, now);
            retried.push(sourceName);
            log.info(`Retry eligibility notice for ${sourceName} (${monitor.retryCount})`);
          }
        }
      } else {
        if (monitor.consecutiveFailures > 0) {
          recovered.push(sourceName);
          log.info(`Monitor ${sourceName} recovered after ${monitor.consecutiveFailures} consecutive failures`);
        }
        monitor.consecutiveFailures = 0;
        monitor.retryCount = 0;
        monitor.lastRetriedAt = "";
        monitor.backoffUntil = "";
      }
      monitor.lastUpdated = nowIso;
    }

    await saveState(state);

    return {
      cycleRun: nowIso,
      monitorsChecked: checked.size,
      monitorsRetried: retried,
      monitorsRecovered: recovered,
      state,
    };
  } catch (err) {
    log.warn("Healing cycle encountered unexpected error (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      cycleRun: nowIso,
      monitorsChecked: 0,
      monitorsRetried: retried,
      monitorsRecovered: recovered,
      state: await getHealerState(),
    };
  }
}

/** Serialize the complete state transition, including independent CLI callers. */
export async function runHealingCycle(): Promise<Awaited<ReturnType<typeof runHealingCycleUnlocked>>> {
  try { return await withFileLease(`${healerStatePath()}.lock`, runHealingCycleUnlocked); }
  catch (error) {
    log.warn("Healing ownership unavailable; no state transition", { error: error instanceof Error ? error.message : String(error) });
    return { cycleRun: new Date().toISOString(), monitorsChecked: 0, monitorsRetried: [], monitorsRecovered: [], state: await getHealerState() };
  }
}

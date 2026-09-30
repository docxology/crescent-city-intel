#!/usr/bin/env bun
/** Upstream outages are degraded evidence; runner and receipt faults fail CI. */
import { MONITOR_KEYS, ALERT_MONITOR_SOURCE_NAMES } from "../src/alerts/composite.js";
import { paths } from "../src/shared/paths.js";
import { publicSourceHealth, assertPublicArtifact } from "../src/pages_public.js";
import { writeJsonAtomic } from "../src/shared/source_health.js";
import { validateMonitorCycle } from "../src/ci_support.js";
const startedAt = Date.now();
console.log(`Running the alert batch (${MONITOR_KEYS.length} monitors).`);
const child = Bun.spawn(["bun", "run", "scripts/run-alerts.ts"], { stdout: "inherit", stderr: "inherit", timeout: 22 * 60 * 1000, env: process.env });
const exitCode = await child.exited;
let health: unknown;
try { health = await Bun.file(paths.alertsHealth).json(); } catch { health = null; }
const errors = validateMonitorCycle(health, ALERT_MONITOR_SOURCE_NAMES, startedAt, exitCode);
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else {
  const publicHealth = { checkedAt: new Date().toISOString(), sources: publicSourceHealth((health as { sources: unknown[] }).sources) };
  assertPublicArtifact(publicHealth);
  await writeJsonAtomic(`${paths.output}/alerts/public-source-health.json`, publicHealth);
  console.log("Current complete monitor evidence recorded; upstream unavailable/stale states remain coverage gaps.");
}

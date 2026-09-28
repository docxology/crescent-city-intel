#!/usr/bin/env bun
/**
 * CI evidence for the weekly alert cycle: run the alert batch and report what
 * each monitor honestly said about itself.
 *
 * The weekly workflow used to carry eight hand-written `bun run alerts:<x>`
 * steps. It fell behind the roster silently: the marine forecast, the USCG
 * broadcasts, and the five Phase-12 monitors were never exercised in CI, so a
 * change that broke them was invisible until the cycle published a degraded
 * source-health record nobody was watching. This replaced them.
 *
 * The first draft of this script tried to enumerate the monitors itself and
 * spawn each one. That is wrong twice over: the key-to-filename map does not
 * follow from the key (`tsunami` lives in `noaa_tsunami.ts`), so it is a second
 * hand-maintained copy of the roster that will drift exactly as the YAML did;
 * and it re-implements the batch, its timeouts, its locking and its
 * unavailable-reporting contract. So this delegates to the runner, which is the
 * canonical path, and only adds the part CI lacked: a readable per-monitor
 * verdict in the job log.
 *
 * A degraded monitor is NOT a failed run. These hit live government endpoints;
 * failing the build on someone else's downtime trains people to ignore the job.
 * The evidence is the source-health artifact, and the verdict is printed so a
 * reviewer sees it without opening the artifact.
 */
import { MONITOR_KEYS } from "../src/alerts/composite.ts";
import { ALERT_MONITOR_SOURCE_NAMES } from "../src/alerts/composite.ts";

/** The runner owns its own per-monitor bounds; this is only a backstop. */
const BATCH_TIMEOUT_MS = 22 * 60 * 1000;

console.log(`Running the alert batch (${MONITOR_KEYS.length} monitors) and reporting each verdict.\n`);

const proc = Bun.spawn(["bun", "run", "scripts/run-alerts.ts"], {
  cwd: process.cwd(),
  stdout: "inherit",
  stderr: "inherit",
  timeout: BATCH_TIMEOUT_MS,
  env: process.env,
});
const exitCode = await proc.exited;

// Read the artifact the runner wrote. Its per-monitor records are the honest
// report; a monitor that could not check says so, and that is the evidence this
// job exists to produce.
const healthFile = Bun.file("output/alerts/source-health.json");
if (!(await healthFile.exists())) {
  console.error(`\nNo output/alerts/source-health.json was written (runner exit ${exitCode}).`);
  console.error("The batch did not complete, so there is no per-monitor evidence to report.");
  process.exit(0); // still not a build failure — see the header
}

const health = await healthFile.json() as {
  sources?: Array<{ source?: string; status?: string; itemCount?: number; error?: string }>;
};
const byName = new Map((health.sources ?? []).map(s => [s.source ?? "", s]));

console.log("\n════ per-monitor verdict ════");
const counts = new Map<string, number>();
for (const name of ALERT_MONITOR_SOURCE_NAMES) {
  const record = byName.get(name);
  const status = record?.status ?? "MISSING";
  counts.set(status, (counts.get(status) ?? 0) + 1);
  const detail = record?.error
    ? ` — ${record.error}`
    : ` (${record?.itemCount ?? 0} item(s))`;
  console.log(`  ${status.padEnd(12)} ${name}${detail}`);
}

const missing = ALERT_MONITOR_SOURCE_NAMES.filter(name => !byName.has(name));
console.log(
  `\n${byName.size}/${ALERT_MONITOR_SOURCE_NAMES.length} monitors reported: ` +
  [...counts].map(([status, n]) => `${n} ${status}`).join(", "),
);

// A roster/report mismatch is NOT a live-feed outage — it is the same drift
// this script exists to prevent, and it deserves a louder signal than a plain
// line. Still not a build failure (the gate owns failures), but named clearly.
if (missing.length > 0) {
  console.log(`\n⚠️  ${missing.length} monitor(s) in the roster produced no health record: ${missing.join(", ")}`);
  console.log("   This is roster drift, not a feed outage — the runner and the roster disagree.");
}

console.log("\nMonitor cycle complete. `ok` and `empty` are both coverage; `unavailable` and `stale` are gaps.");
process.exit(0);

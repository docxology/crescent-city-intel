#!/usr/bin/env bun
/** Thin alert CLI; batch ownership and source-health policy live in src/alerts/batch.ts. */
import { runAllAlertMonitors } from "../src/alerts/batch.ts";
import type { MonitorKey } from "../src/alerts/composite.ts";
export { runAllAlertMonitors };
if (import.meta.main) {
  const flag = process.argv.find(arg => arg.startsWith("--only="));
  const only = flag ? flag.slice(7).split(",").map(value => value.trim()) as MonitorKey[] : undefined;
  await runAllAlertMonitors({ only, notifications: !process.argv.includes("--no-notifications") });
}

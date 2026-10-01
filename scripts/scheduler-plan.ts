#!/usr/bin/env bun
import { resolve } from "node:path";
import { renderSchedulerPlan, installScheduler, removeScheduler, rotateSchedulerLog } from "../src/scheduler.js";
const platform = process.platform;
if (platform !== "darwin" && platform !== "linux") throw new Error("Unsupported scheduling platform");
const plan = renderSchedulerPlan({ project: resolve(import.meta.dir, ".."), bun: process.execPath, platform });
const targetPath = Bun.argv.find(value => value.startsWith("--target="))?.slice("--target=".length);
const stateDirectory = Bun.argv.find(value => value.startsWith("--state="))?.slice("--state=".length);
const logPath = Bun.argv.find(value => value.startsWith("--rotate-log="))?.slice("--rotate-log=".length);
const producerLease = Bun.argv.find(value => value.startsWith("--producer-lease="))?.slice("--producer-lease=".length);
if (logPath && producerLease) console.log(JSON.stringify(await rotateSchedulerLog({ path: logPath, producerLease, maxBytes: Number(Bun.argv.find(value => value.startsWith("--max-bytes="))?.slice("--max-bytes=".length) ?? 5_000_000), keep: Number(Bun.argv.find(value => value.startsWith("--keep="))?.slice("--keep=".length) ?? 3) })));
else if (Bun.argv.includes("--dry-run")) { console.log(plan.instruction); console.log(plan.content); }
else if (targetPath && stateDirectory && Bun.argv.includes("--install")) console.log(JSON.stringify(await installScheduler({ job: { project: resolve(import.meta.dir, ".."), bun: process.execPath, platform }, targetPath, stateDirectory, activate: Bun.argv.includes("--activate") })));
else if (targetPath && stateDirectory && Bun.argv.includes("--remove")) console.log(JSON.stringify(await removeScheduler({ targetPath, stateDirectory, deactivate: Bun.argv.includes("--deactivate") })));
else throw new Error("Choose --dry-run or explicit --install/--remove with --target= and --state=. Native activation requires --activate/--deactivate.");

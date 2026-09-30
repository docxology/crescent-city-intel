#!/usr/bin/env bun
import { resolve } from "node:path";
import { renderSchedulerPlan } from "../src/scheduler.js";
if (!Bun.argv.includes("--dry-run")) throw new Error("Only --dry-run is supported; review and install the generated plan explicitly.");
const platform = process.platform;
if (platform !== "darwin" && platform !== "linux") throw new Error("Unsupported scheduling platform");
const plan = renderSchedulerPlan({ project: resolve(import.meta.dir, ".."), bun: process.execPath, platform });
console.log(plan.instruction);
console.log(plan.content);

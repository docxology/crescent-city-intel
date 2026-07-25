#!/usr/bin/env bun
/** Thin orchestrator for the durable cross-surface analytics overview. */
import { writeAnalyticsOverview } from "../src/analytics_backend.ts";

const summarize = !Bun.argv.includes("--no-llm");
const overview = await writeAnalyticsOverview({ summarize });
console.log(JSON.stringify({
  status: overview.status,
  headline: overview.headline,
  inputFingerprint: overview.inputFingerprint,
  llm: overview.llm,
  signals: overview.signals.length,
}, null, 2));

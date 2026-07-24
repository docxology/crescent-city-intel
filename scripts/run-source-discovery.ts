#!/usr/bin/env bun
/** Generate the canonical source inventory and optional bounded live probes. */
import { writeSourceDiscoveryArtifacts } from "../src/source_registry.js";

const report = await writeSourceDiscoveryArtifacts({ probe: Bun.argv.includes("--check") });
console.log(`Source discovery wrote ${report.sourceCount} sources (${report.monitoredCount} monitored, ${report.discoveryOnlyCount} discovery-only, ${report.referenceOnlyCount} reference-only).`);
console.log(`Registry fingerprint: ${report.registryFingerprint} (${report.changed ? "changed" : "unchanged"})`);
if (Bun.argv.includes("--check")) {
  const unavailable = report.sources.filter(source => source.operationalStatus === "unavailable");
  console.log(`Bounded probes: ${report.sources.length - report.sources.filter(source => source.operationalStatus === "not-checked").length} checked; ${unavailable.length} unavailable.`);
}

#!/usr/bin/env bun
/** Preserve evidence, quarantine unproven history times, label legacy summaries. */
import { repairGeneratedOutput, rollbackGeneratedOutput } from "../src/output_migrations.ts";
import { outputRoot } from "../src/shared/paths.ts";
if (import.meta.main) {
  const rollback = Bun.argv.find(value => value.startsWith("--rollback="))?.slice("--rollback=".length);
  (rollback ? rollbackGeneratedOutput(outputRoot(), rollback) : repairGeneratedOutput()).then(receipt => console.log(JSON.stringify(receipt, null, 2))).catch(error => { console.error(String(error)); process.exitCode = 1; });
}

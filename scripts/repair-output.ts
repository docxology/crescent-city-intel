#!/usr/bin/env bun
/** Preserve evidence, quarantine unproven history times, label legacy summaries. */
import { repairGeneratedOutput } from "../src/output_migrations.ts";
if (import.meta.main) repairGeneratedOutput().then(receipt => console.log(JSON.stringify(receipt, null, 2))).catch(error => { console.error(String(error)); process.exitCode = 1; });

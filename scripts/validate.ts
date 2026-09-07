#!/usr/bin/env bun
/** Authoritative deterministic release gate for the repository. */
import { runReleaseGate } from "../src/release_gate.ts";

await runReleaseGate();

#!/usr/bin/env bun
/** Generate the canonical source inventory and optional bounded live probes. */
import { runSourceDiscoveryCli } from "../src/source_registry.js";

await runSourceDiscoveryCli();

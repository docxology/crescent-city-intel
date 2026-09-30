#!/usr/bin/env bun
import { hydrateManuscript } from "../src/manuscript_hydration.js";
const result = await hydrateManuscript({ allowDraft: Bun.argv.includes("--allow-draft") });
console.log(`Hydrated ${result.fileCount} manuscript files from ${result.inputFingerprint}`);

#!/usr/bin/env bun
import { validateManuscript } from "../src/manuscript_document.js";
const hydrated = Bun.argv.includes("--hydrated");
const errors = await validateManuscript({ hydrated });
if (errors.length) { console.error(`Manuscript validation failed:\n${errors.map(error => `- ${error}`).join("\n")}`); process.exitCode = 1; }
else console.log(`Manuscript validation passed: ${hydrated ? "hydrated output" : "source contracts"}.`);

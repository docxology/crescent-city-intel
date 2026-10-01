#!/usr/bin/env bun
/** Thin authority-inventory command; all generation/check logic lives in src/. */
import { validateDocumentationInventory, writeDocumentationInventory } from "../src/doc_inventory.js";
if (process.argv.slice(2).some(arg => !["--check", "--write"].includes(arg))) throw new Error("Usage: bun run scripts/generate-docs.ts [--check|--write]");
if (process.argv.includes("--check")) {
  const errors = await validateDocumentationInventory(process.cwd());
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Generated configuration, exports and HTTP inventories match their authorities");
} else await writeDocumentationInventory(process.cwd());

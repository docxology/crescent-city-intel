#!/usr/bin/env bun
/** Validate a generated public Pages artifact without making network calls. */
import { resolve } from "path";
import { validatePagesArtifact } from "../src/pages_validation.ts";

const destination = resolve(Bun.argv.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? ".pages");
const errors = await validatePagesArtifact(destination);
if (errors.length) {
  console.error(errors.map(error => `✖ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Pages artifact valid: ${destination}`);

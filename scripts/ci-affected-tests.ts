#!/usr/bin/env bun
/** Run the conservative transitive test selection; uncertainty runs everything. */
import { readFileSync } from "node:fs";
import { selectAffectedTests } from "../src/ci_support.js";
let changed = process.env.CHANGED ?? "";
if (!changed.trim()) { try { changed = readFileSync(0, "utf8"); } catch { changed = ""; } }
const selection = selectAffectedTests(process.cwd(), changed.split(/\r?\n/).map(path => path.trim()).filter(Boolean));
console.log(selection.full ? `${selection.reason}: running the full suite rather than nothing` : `${selection.reason}: ${selection.files.length} test files`);
const child = Bun.spawn(["bun", "test", ...(selection.full ? ["tests/"] : selection.files), "--timeout", "30000"], { stdout: "inherit", stderr: "inherit", timeout: 20 * 60 * 1000 });
process.exitCode = await child.exited;

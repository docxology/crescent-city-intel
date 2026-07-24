#!/usr/bin/env bun
/** Validate a generated public Pages artifact without making network calls. */
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { validatePagesSource } from "../src/pages_snapshot.js";
import type { PagesSnapshot } from "../src/pages_snapshot.js";

const destination = resolve(Bun.argv.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? ".pages");
const errors: string[] = [];
const required = ["index.html", "404.html", ".nojekyll", "data/snapshot.json", "data/source-health.json"];

for (const relative of required) {
  try { await readFile(join(destination, relative)); }
  catch { errors.push(`missing required Pages asset: ${relative}`); }
}

const indexHtml = await readFile(join(destination, "index.html"), "utf8").catch(() => "");
errors.push(...validatePagesSource(indexHtml));

let snapshot: PagesSnapshot | null = null;
try {
  snapshot = JSON.parse(await readFile(join(destination, "data/snapshot.json"), "utf8")) as PagesSnapshot;
} catch { errors.push("data/snapshot.json is not valid JSON"); }

if (snapshot) {
  if (snapshot.schemaVersion !== "1.0.0") errors.push(`unsupported snapshot schema: ${String(snapshot.schemaVersion)}`);
  if (!Number.isFinite(Date.parse(snapshot.generatedAt))) errors.push("snapshot generatedAt is not an ISO timestamp");
  if (!["ok", "degraded", "unavailable"].includes(snapshot.status)) errors.push(`invalid snapshot status: ${String(snapshot.status)}`);
  if (!Array.isArray(snapshot.sourceHealth)) errors.push("snapshot sourceHealth is not an array");
  const hasUnavailable = snapshot.sourceHealth.some(source => source.status === "unavailable" || source.status === "stale");
  if (hasUnavailable && snapshot.status === "ok") errors.push("snapshot reports ok while a source is unavailable or stale");
  if (!snapshot.publicationPolicy || snapshot.publicationPolicy.triplicate !== "reference-citation-only") errors.push("Triplicate publication policy is missing or unsafe");
  if (snapshot.publicationPolicy?.curationInputs?.includes("triplicate")) errors.push("Triplicate is incorrectly listed as a curation input");
}

if (indexHtml.includes("__CC_API_KEY__") || indexHtml.includes("__CC_API_KEY_INJECT__")) errors.push("API key placeholder found in Pages HTML");
if (indexHtml.includes("localhost:") || indexHtml.includes("127.0.0.1")) errors.push("local-only endpoint found in Pages HTML");

if (errors.length) {
  console.error(errors.map(error => `✖ ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Pages artifact valid: ${destination}`);

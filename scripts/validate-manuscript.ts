#!/usr/bin/env bun
/** Structural and evidence-boundary validator for the source manuscript. */
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { MANUSCRIPT_VARIABLE_NAMES } from "../src/manuscript_variables.js";
import { paths } from "../src/shared/paths.js";

const root = process.cwd();
const sourceDir = join(root, "manuscript");
const hydrated = Bun.argv.includes("--hydrated");
const errors: string[] = [];

function finish(): void {
  if (errors.length > 0) {
    console.error(`Manuscript validation failed (${errors.length} issue${errors.length === 1 ? "" : "s"}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Manuscript validation passed: IMRAD, citations, labels, claim ledger, and ${hydrated ? "hydrated output" : "source tokens"}.`);
}

async function main(): Promise<void> {
  if (!existsSync(sourceDir)) errors.push("manuscript/ is missing");
  if (errors.length > 0) return finish();

  const files = (await readdir(sourceDir)).filter(file => /^\d{2}_.*\.md$/.test(file)).sort();
  const requiredHeadings = [
    "Abstract",
    "Introduction",
    "Methods",
    "Results",
    "Discussion",
    "Limitations, Ethics, and Threats to Validity",
    "Reproducibility and Artifact Specification",
    "Conclusion",
    "Appendix: Formal Contracts and Worked Records",
    "References",
  ];
  const foundHeadings = new Set<string>();
  const sectionLabels = new Set<string>();
  const equationLabels = new Set<string>();
  const tableLabels = new Set<string>();
  const bodyParts: string[] = [];

  if (files.length === 0) errors.push("manuscript has no numbered Markdown sections");
  for (const file of files) {
    const body = await readFile(join(sourceDir, file), "utf8");
    bodyParts.push(body);
    const firstContent = body.split(/\r?\n/).find(line => line.trim() !== "") ?? "";
    const firstHeading = firstContent.match(/^#\s+(.+?)\s+\{#sec:([a-z0-9_]+)\}\s*$/i);
    if (!firstHeading) errors.push(`${file} must begin with an H1 section label`);
    else {
      foundHeadings.add(firstHeading[1].trim());
      sectionLabels.add(firstHeading[2]);
    }

    let previousDepth = 0;
    for (const match of body.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
      const depth = match[1].length;
      if (previousDepth > 0 && depth > previousDepth + 1) errors.push(`${file} skips a heading level before ${match[2].trim()}`);
      previousDepth = depth;
      if (depth === 1) {
        const title = match[2].replace(/\s+\{#sec:[^}]+\}\s*$/, "").trim();
        foundHeadings.add(title);
      }
    }
    for (const match of body.matchAll(/\{#eq:([a-z0-9_]+)\}/gi)) equationLabels.add(match[1]);
    for (const match of body.matchAll(/\{#tbl:([a-z0-9_]+)\}/gi)) tableLabels.add(match[1]);
    for (const match of body.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)) {
      if (!MANUSCRIPT_VARIABLE_NAMES.has(match[1])) errors.push(`${file} contains unknown manuscript variable {{${match[1]}}}`);
    }
  }

  for (const heading of requiredHeadings) if (!foundHeadings.has(heading)) errors.push(`missing required section: ${heading}`);

  const sourceText = bodyParts.join("\n");
  const withoutCode = sourceText.replace(/~~~[\s\S]*?~~~/g, "");
  const referencedSections = new Set([...withoutCode.matchAll(/@sec:([a-z0-9_]+)/gi)].map(match => match[1]));
  const referencedEquations = new Set([...withoutCode.matchAll(/@eq:([a-z0-9_]+)/gi)].map(match => match[1]));
  const referencedTables = new Set([...withoutCode.matchAll(/@tbl:([a-z0-9_]+)/gi)].map(match => match[1]));
  for (const label of referencedSections) if (!sectionLabels.has(label)) errors.push(`reference targets missing section label: ${label}`);
  for (const label of equationLabels) if (!referencedEquations.has(label)) errors.push(`equation label is never referenced: ${label}`);
  for (const label of tableLabels) if (!referencedTables.has(label)) errors.push(`table label is never referenced: ${label}`);

  const bibliographyPath = join(sourceDir, "references.bib");
  const bibliography = existsSync(bibliographyPath) ? await readFile(bibliographyPath, "utf8") : "";
  if (!bibliography) errors.push("manuscript/references.bib is missing or empty");
  const bibliographyKeys = new Set([...bibliography.matchAll(/^@\w+\{([^,\s]+),/gm)].map(match => match[1].toLowerCase()));
  const citationKeys = new Set([...withoutCode.matchAll(/@([a-z][a-z0-9_]*)(?=$|[^a-z0-9_:])/gi)].map(match => match[1].toLowerCase()));
  for (const key of citationKeys) if (!bibliographyKeys.has(key)) errors.push(`citation has no bibliography entry: ${key}`);

  const ledgerPath = join(sourceDir, "claim_ledger.json");
  if (!existsSync(ledgerPath)) errors.push("manuscript/claim_ledger.json is missing");
  else {
    try {
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { schemaVersion?: string; claims?: unknown[] };
      if (ledger.schemaVersion !== "1.0.0" || !Array.isArray(ledger.claims) || ledger.claims.length < 4) errors.push("claim ledger must be schema 1.0.0 with at least four claims");
      for (const [index, claim] of (ledger.claims ?? []).entries()) {
        if (!claim || typeof claim !== "object") { errors.push(`claim ledger entry ${index} is not an object`); continue; }
        const record = claim as Record<string, unknown>;
        for (const field of ["id", "statement", "status", "scope", "notEstablished"]) if (typeof record[field] !== "string") errors.push(`claim ledger entry ${index} is missing ${field}`);
        if (!Array.isArray(record.evidence)) errors.push(`claim ledger entry ${index} is missing evidence`);
      }
    } catch (error) { errors.push(`claim ledger is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }

  if (hydrated) {
    if (!existsSync(paths.manuscriptVariables)) errors.push(`hydrated variables artifact is missing: ${paths.manuscriptVariables}`);
    if (existsSync(paths.manuscriptVariables) && existsSync(paths.analyticsOverview)) {
      try {
        const variables = JSON.parse(await readFile(paths.manuscriptVariables, "utf8")) as { inputFingerprint?: string };
        const overview = JSON.parse(await readFile(paths.analyticsOverview, "utf8")) as { inputFingerprint?: string };
        if (variables.inputFingerprint !== overview.inputFingerprint) errors.push("hydrated manuscript fingerprint differs from analytics overview");
      } catch (error) { errors.push(`hydrated manuscript metadata is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const outputFiles = existsSync(paths.manuscriptOutput) ? (await readdir(paths.manuscriptOutput)).filter(file => /^\d{2}_.*\.md$/.test(file)) : [];
    if (outputFiles.length !== files.length) errors.push(`hydrated manuscript has ${outputFiles.length} Markdown files; expected ${files.length}`);
    for (const file of outputFiles) {
      const output = await readFile(join(paths.manuscriptOutput, file), "utf8");
      if (/\{\{[A-Z][A-Z0-9_]*\}\}/.test(output)) errors.push(`hydrated output still contains a manuscript variable: ${file}`);
    }
  }
  finish();
}

await main();

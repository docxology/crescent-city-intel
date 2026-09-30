import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonemptyText);
}

/** Real YAML syntax and minimum runnable job/step shapes; not GitHub's compiler. */
export function validateGithubWorkflow(text: string, filename = "workflow"): string[] {
  let value: unknown;
  try { value = Bun.YAML.parse(text); }
  catch (error) { return [`${filename}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`]; }
  const errors: string[] = [];
  const fail = (path: string, message: string) => errors.push(`${filename}: ${path} ${message}`);
  if (!mapping(value)) return [`${filename}: workflow must be a mapping`];
  if (!(nonemptyText(value.on) || textList(value.on) || (mapping(value.on) && Object.keys(value.on).length > 0))) fail("on", "must declare an event string, list or mapping");
  if (!mapping(value.jobs) || Object.keys(value.jobs).length === 0) return [...errors, `${filename}: jobs must be a nonempty mapping`];
  const scalarMap = (candidate: unknown, path: string) => {
    if (candidate === undefined) return;
    if (!mapping(candidate) || Object.values(candidate).some(item => !["string", "number", "boolean"].includes(typeof item))) fail(path, "must map names to scalar values");
  };
  const optionalText = (candidate: unknown, path: string) => {
    if (candidate !== undefined && !nonemptyText(candidate)) fail(path, "must be a nonempty string");
  };
  const optionalTimeout = (candidate: unknown, path: string) => {
    if (candidate !== undefined && !(typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0)) fail(path, "must be a positive number");
  };
  scalarMap(value.env, "env");
  for (const [id, job] of Object.entries(value.jobs)) {
    const path = `jobs.${id}`;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) fail(path, "has an invalid job ID");
    if (!mapping(job)) { fail(path, "must be a mapping"); continue; }
    scalarMap(job.env, `${path}.env`);
    optionalText(job.name, `${path}.name`);
    optionalTimeout(job["timeout-minutes"], `${path}.timeout-minutes`);
    if (job.needs !== undefined) {
      const needs = nonemptyText(job.needs) ? [job.needs] : textList(job.needs) ? job.needs : [];
      if (!needs.length) fail(`${path}.needs`, "must be a job ID or nonempty list of job IDs");
      for (const dependency of needs) if (dependency === id || !Object.hasOwn(value.jobs, dependency)) fail(`${path}.needs`, `references an unknown or self-dependent job ${dependency}`);
    }
    // Reusable workflow jobs are runnable via uses, without local steps/runners.
    if (job.uses !== undefined) {
      optionalText(job.uses, `${path}.uses`);
      if (job.steps !== undefined || job["runs-on"] !== undefined) fail(path, "cannot combine reusable uses with steps or runs-on");
      scalarMap(job.with, `${path}.with`);
      continue;
    }
    const runner = job["runs-on"];
    const runnerGroup = mapping(runner) && (nonemptyText(runner.group) || nonemptyText(runner.labels) || textList(runner.labels));
    if (!(nonemptyText(runner) || textList(runner) || runnerGroup)) fail(`${path}.runs-on`, "must declare a runner string, labels or group");
    if (!Array.isArray(job.steps) || job.steps.length === 0) { fail(`${path}.steps`, "must be a nonempty list"); continue; }
    for (const [index, step] of job.steps.entries()) {
      const stepPath = `${path}.steps[${index}]`;
      if (!mapping(step)) { fail(stepPath, "must be a mapping"); continue; }
      const hasRun = step.run !== undefined, hasUses = step.uses !== undefined;
      if (hasRun === hasUses) fail(stepPath, "must declare exactly one of run or uses");
      if (hasRun && !nonemptyText(step.run)) fail(`${stepPath}.run`, "must be a nonempty string");
      if (hasUses && !nonemptyText(step.uses)) fail(`${stepPath}.uses`, "must be a nonempty string");
      for (const key of ["name", "id", "shell", "working-directory"]) optionalText(step[key], `${stepPath}.${key}`);
      scalarMap(step.env, `${stepPath}.env`);
      scalarMap(step.with, `${stepPath}.with`);
      optionalTimeout(step["timeout-minutes"], `${stepPath}.timeout-minutes`);
    }
  }
  return errors;
}

/** Include every YAML workflow, so a newly added file cannot bypass parsing. */
export function validateGithubWorkflows(root: string): string[] {
  const directory = join(root, ".github", "workflows");
  if (!existsSync(directory)) return [".github/workflows: directory is missing"];
  const names = readdirSync(directory).filter(name => /\.ya?ml$/i.test(name)).sort();
  if (!names.length) return [".github/workflows: no YAML workflows found"];
  return names.flatMap(name => validateGithubWorkflow(readFileSync(join(directory, name), "utf8"), `.github/workflows/${name}`));
}

export interface TestSelection { full: boolean; files: string[]; reason: string }
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

/** Recursive static dependency closure; uncertainty always broadens selection. */
export function selectAffectedTests(root: string, changed: string[]): TestSelection {
  const full = (reason: string): TestSelection => ({ full: true, files: [], reason });
  if (!changed.length) return full("No changed-file evidence");
  if (changed.some(path => path.startsWith("/") || path.split(/[\\/]/).includes(".."))) return full("Unsupported changed path");
  if (changed.some(path => !/^(?:src|tests)\/.*\.[cm]?[jt]sx?$/.test(path))) return full("Configuration, assets or unsupported source change");
  const files = [...filesUnder(join(root, "src")), ...filesUnder(join(root, "tests"))];
  const dependencies = new Map<string, Set<string>>();
  let uncertain = false;
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const deps = new Set<string>();
    const add = (specifier: string) => {
      if (!specifier.startsWith(".")) return;
      const base = resolve(dirname(file), specifier);
      const candidates = [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, `${base}.js`, join(base, "index.ts")];
      const target = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (!target) uncertain = true; else deps.add(relative(root, target).replace(/\\/g, "/"));
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) add(argument.text); else uncertain = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    dependencies.set(relative(root, file).replace(/\\/g, "/"), deps);
  }
  if (uncertain) return full("Unresolved or dynamic dependency");
  const impacted = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, deps] of dependencies) if (!impacted.has(file) && [...deps].some(dep => impacted.has(dep))) { impacted.add(file); grew = true; }
  }
  const selected = [...impacted].filter(file => /\.test\.[cm]?[jt]sx?$/.test(file) && dependencies.has(file)).sort();
  if (!selected.length || changed.some(file => !dependencies.has(file))) return full("No bounded affected test set or deleted source");
  return { full: false, files: selected, reason: "Transitive static dependency closure" };
}

/** Source outages are valid results; absent/old/duplicate records are code faults. */
export function validateMonitorCycle(value: unknown, names: readonly string[], startedAt: number, exitCode: number): string[] {
  const errors: string[] = [];
  if (exitCode !== 0) errors.push(`Alert runner exited ${exitCode}`);
  const report = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const sources = Array.isArray(report.sources) ? report.sources : [];
  const seen = new Set<string>();
  for (const item of sources) {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const name = String(source.source ?? "");
    if (seen.has(name)) errors.push(`Duplicate monitor ${name}`);
    seen.add(name);
    if (!names.includes(name)) errors.push(`Unexpected monitor ${name}`);
    if (!["ok", "empty", "unavailable", "stale"].includes(String(source.status))) errors.push(`Invalid status ${name}`);
    const checkedAt = Date.parse(String(source.checkedAt ?? ""));
    if (!Number.isFinite(checkedAt) || checkedAt < startedAt - 1000 || checkedAt > Date.now() + 1000) errors.push(`Not current-run evidence: ${name}`);
    if (!Number.isInteger(source.itemCount) || Number(source.itemCount) < 0) errors.push(`Invalid item count ${name}`);
  }
  for (const name of names) if (!seen.has(name)) errors.push(`Missing monitor ${name}`);
  return errors;
}

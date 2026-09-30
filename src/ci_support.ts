import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

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

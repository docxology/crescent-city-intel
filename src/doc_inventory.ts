import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

/** Read the architecture code block by directory context, retaining full paths. */
export function documentedSourcePaths(markdown: string): Set<string> {
  const paths = new Set<string>();
  let sourceBlock = false;
  let directory = "src";
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) { sourceBlock = false; continue; }
    const entry = /^\s*([^\s#]+)\s+#/.exec(line)?.[1];
    if (!entry) continue;
    if (entry === "src/") { sourceBlock = true; directory = "src"; continue; }
    if (!sourceBlock) continue;
    if (entry === "scripts/" || entry === "tests/" || entry === "docs/" || entry === "output/" || entry === "pages-data/") { sourceBlock = false; continue; }
    if (entry.endsWith("/")) { directory = entry.startsWith("src/") ? entry.slice(0, -1) : `src/${entry.slice(0, -1)}`; continue; }
    if (entry.endsWith(".ts")) paths.add(entry.startsWith("src/") ? entry : `${directory}/${entry}`);
  }
  return paths;
}

export interface SourceDocument { file: string; text: string }
export interface ConfigurationReference { name: string; file: string; line: number; expression: string; fallback: string | null }
export interface PublicExportReference { name: string; file: string; line: number; kind: string; declarationSha256: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const cell = (text: string) => text.replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " ").replace(/`/g, "&#96;");
const envObject = (node: ts.Node): boolean => ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isIdentifier(node.expression) && ["process", "Bun"].includes(node.expression.text);
const envRead = (node: ts.Node): boolean => (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && envObject(node.expression);
const exported = (node: ts.Node): boolean => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
const bindingNames = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));

/** Parse syntax without importing modules, evaluating defaults or reading actual environment values. */
export function configurationInventory(documents: SourceDocument[]): { references: ConfigurationReference[]; dynamicReads: Array<{ file: string; line: number; expression: string }> } {
  const sources = documents.map(document => ({ ...document, ast: ts.createSourceFile(document.file, document.text, ts.ScriptTarget.Latest, true) }));
  const references: ConfigurationReference[] = [], dynamicReads: Array<{ file: string; line: number; expression: string }> = [];
  // Discover literal-key wrappers from their actual env indexing parameter,
  // including arrow helpers. Ambiguous dynamic accesses remain disclosed below.
  for (const source of sources) {
    const helpers = new Map<string, Set<number>>();
    const bindings = new Map<string, number>();
    const countBindings = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) bindings.set(node.name.text, (bindings.get(node.name.text) ?? 0) + 1);
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) for (const name of bindingNames(node.name)) bindings.set(name, (bindings.get(name) ?? 0) + 1);
      if (ts.isImportSpecifier(node) || ts.isImportClause(node) && node.name) {
        const name = node.name!.text; bindings.set(name, (bindings.get(name) ?? 0) + 1);
      }
      ts.forEachChild(node, countBindings);
    }; countBindings(source.ast);
    const discover = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name || ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const fn = ts.isFunctionDeclaration(node) ? node : node.initializer as ts.ArrowFunction;
        const name = ts.isFunctionDeclaration(node) ? node.name!.text : (node.name as ts.Identifier).text;
        const positions = new Set<number>();
        const inside = (child: ts.Node): void => {
          if (ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) || ts.isArrowFunction(child)) return;
          if (ts.isElementAccessExpression(child) && envObject(child.expression) && child.argumentExpression && ts.isIdentifier(child.argumentExpression)) {
            const index = fn.parameters.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === (child.argumentExpression as ts.Identifier).text);
            if (index >= 0) positions.add(index);
          }
          ts.forEachChild(child, inside);
        };
        if (fn.body) inside(fn.body);
        // Textually equal names in another file, imported wrappers and shadowed
        // bindings are not authority for this call. Leave their env indexing
        // explicit in dynamicReads rather than inventing a literal key.
        if (positions.size && bindings.get(name) === 1) helpers.set(name, positions);
      }
      ts.forEachChild(node, discover);
    }; discover(source.ast);
    const literals = new Map<string, string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)
          && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) && bindings.get(node.name.text) === 1) literals.set(node.name.text, node.initializer.text);
      ts.forEachChild(node, collect);
    }; collect(source.ast);
    const literal = (node: ts.Node | undefined): string | null => !node ? null : ts.isStringLiteralLike(node) ? node.text : ts.isIdentifier(node) ? literals.get(node.text) ?? null : null;
    const record = (name: string, node: ts.Node, fallback: ts.Node | null): void => { if (/^[A-Z][A-Z0-9_]*$/.test(name)) references.push({ name, file: source.file, line: source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1, expression: node.getText(source.ast), fallback: fallback?.getText(source.ast) ?? null }); };
    const visit = (node: ts.Node): void => {
      if (envRead(node)) {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text : literal((node as ts.ElementAccessExpression).argumentExpression);
        const parent = node.parent;
        const fallback = ts.isBinaryExpression(parent) && parent.left === node && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind) ? parent.right : null;
        if (name) record(name, node, fallback); else dynamicReads.push({ file: source.file, line: source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1, expression: node.getText(source.ast) });
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) for (const index of helpers.get(node.expression.text) ?? []) {
        const name = literal(node.arguments[index]); if (name) record(name, node, node.arguments[index + 1] ?? null);
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && envObject(node.initializer)) for (const element of node.name.elements) {
        if (!element.dotDotDotToken && ts.isIdentifier(element.name)) record(element.propertyName?.getText(source.ast) ?? element.name.text, element, element.initializer ?? null);
      }
      ts.forEachChild(node, visit);
    }; visit(source.ast);
  }
  return { references: references.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line), dynamicReads: dynamicReads.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };
}

/** Every qualified export is listed; signatures/type bodies bind declaration drift. */
export function publicExportInventory(documents: SourceDocument[]): PublicExportReference[] {
  const rows: PublicExportReference[] = [];
  for (const document of documents) {
    const source = ts.createSourceFile(document.file, document.text, ts.ScriptTarget.Latest, true);
    const add = (name: string, node: ts.Node, kind: string, declaration = node.getText(source)): void => { rows.push({ name, file: document.file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, declarationSha256: hash(declaration) }); };
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) add(element.name.text, element, statement.isTypeOnly || element.isTypeOnly ? "type re-export" : "re-export", statement.getText(source));
        else add(statement.exportClause?.getText(source) ?? "*", statement, "module re-export");
      } else if (ts.isExportAssignment(statement)) add("default", statement, "default");
      else if (exported(statement)) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) add(name, declaration, "value");
        else if (ts.isFunctionDeclaration(statement)) add(statement.name?.text ?? "default", statement, "function", statement.body ? document.text.slice(statement.getStart(source), statement.body.getStart(source)).trim() : statement.getText(source));
        else if (ts.isClassDeclaration(statement)) add(statement.name?.text ?? "default", statement, "class");
        else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) add(statement.name.text, statement, "type");
        else if (ts.isEnumDeclaration(statement)) add(statement.name.text, statement, "enum");
      }
    }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/** Structural HTTP inventory: serialization layout is irrelevant; refs resolve from the same document. */
export function httpDocumentation(yaml: string): string {
  const spec = Bun.YAML.parse(yaml) as Record<string, any>;
  if (!spec || !spec.paths || typeof spec.paths !== "object") throw new Error("openapi.yaml has no paths authority");
  const resolve = (raw: Record<string, any>): Record<string, any> => {
    if (!raw?.$ref) return raw;
    if (!raw.$ref.startsWith("#/")) throw new Error("HTTP inventory rejects external schema references");
    return raw.$ref.slice(2).split("/").reduce((value: any, key: string) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
  };
  const rows: string[] = [];
  for (const path of Object.keys(spec.paths).sort()) for (const method of ["get", "head", "post", "put", "patch", "delete", "options"]) {
    const operation = spec.paths[path][method]; if (!operation) continue;
    const parameters = [...(spec.paths[path].parameters ?? []), ...(operation.parameters ?? [])].map(resolve).map(parameter => `${parameter.in}:${parameter.name}${parameter.required ? " (required)" : ""}`).join(", ") || "none";
    const body = operation.requestBody ? resolve(operation.requestBody)?.content ?? {} : {};
    const responses = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status)).map(([status, raw]) => `${status} ${Object.keys(resolve(raw as any)?.content ?? {}).join(", ") || "no body"}`).join("; ");
    rows.push(`| \`${method.toUpperCase()} ${cell(path)}\` | ${(operation.security ?? spec.security ?? []).length ? "API key" : "public"} | ${cell(parameters)} | ${cell(Object.keys(body).join(", ") || "none")} | ${cell(responses)} |`);
  }
  return `# Generated HTTP inventory\n\nGenerated from [openapi.yaml](../../openapi.yaml). GET also permits HEAD at runtime; the rows below are explicit spec operations. Auth and success bodies use the same structural authority as runtime contracts.\n\n| Operation | Auth | Parameters | Request body | Success responses |\n| :--- | :--- | :--- | :--- | :--- |\n${rows.join("\n")}\n`;
}

export const GENERATED_DOCUMENTS = ["docs/generated/configuration.md", "docs/generated/exports.md", "docs/generated/http.md"] as const;
async function sourceDocuments(root: string): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await walk(join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".ts")) { const path = join(directory, entry.name); documents.push({ file: relative(root, path).replaceAll("\\", "/"), text: await readFile(path, "utf8") }); }
    }
  };
  await walk(join(root, "src")); await walk(join(root, "scripts")); return documents;
}
export async function generatedDocumentation(root: string): Promise<Record<(typeof GENERATED_DOCUMENTS)[number], string>> {
  const sources = await sourceDocuments(root), config = configurationInventory(sources), exports = publicExportInventory(sources.filter(source => source.file.startsWith("src/")));
  const configuration = `# Generated configuration inventory\n\nParsed from TypeScript source without evaluating modules or reading environment values. These are source expressions, not validated setting values. Literal env reads and discovered literal-key wrappers are listed; dynamic key reads remain explicit. Runtime coercion, units and valid ranges belong to their declared consumer.\n\n| Variable | Consumer | Source expression | Fallback expression |\n| :--- | :--- | :--- | :--- |\n${config.references.map(row => `| \`${row.name}\` | [${row.file}:${row.line}](../../${row.file}#L${row.line}) | \`${cell(row.expression)}\` | ${row.fallback === null ? "not declared at this read" : `\`${cell(row.fallback)}\``} |`).join("\n")}\n\nDynamic reads (not an assertion of finite variable coverage):\n\n${config.dynamicReads.map(row => `- [${row.file}:${row.line}](../../${row.file}#L${row.line}): \`${cell(row.expression)}\``).join("\n") || "None."}\n`;
  const publicExports = `# Generated public module exports\n\nQualified source exports, independent of similarly named symbols in other modules. Declaration SHA-256 binds signatures/type declarations and exported value initializers; it is not an implementation or behavioral proof. Re-exports are declarations rather than evaluated imports.\n\n| Module | Export | Kind | Declaration SHA-256 |\n| :--- | :--- | :--- | :--- |\n${exports.map(row => `| [${row.file}:${row.line}](../../${row.file}#L${row.line}) | \`${cell(row.name)}\` | ${row.kind} | \`${row.declarationSha256}\` |`).join("\n")}\n`;
  return { "docs/generated/configuration.md": configuration, "docs/generated/exports.md": publicExports, "docs/generated/http.md": httpDocumentation(await readFile(join(root, "openapi.yaml"), "utf8")) };
}
/** Exact, filename-bearing drift failures; historical journals and frozen ISA are never rewritten. */
export async function validateDocumentationInventory(root: string): Promise<string[]> {
  const expected = await generatedDocumentation(root), errors: string[] = [];
  for (const file of GENERATED_DOCUMENTS) if (await readFile(join(root, file), "utf8").catch(() => null) !== expected[file]) errors.push(`${file}: generated authority drift; run bun run docs:generate`);
  errors.push(...await validateCurrentGuidanceCommands(root));
  return errors;
}
export async function writeDocumentationInventory(root: string): Promise<void> {
  for (const [file, text] of Object.entries(await generatedDocumentation(root))) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), text, "utf8"); }
}

/** Every current guide's literal Bun command names a shipped alias/file; history stays outside this check. */
export async function validateCurrentGuidanceCommands(root: string): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const guides: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; })) {
      const path = join(directory, entry.name), file = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory() && !/(?:^|\/)(?:node_modules|archive|archives|archived|fixtures|generated)(?:\/|$)/.test(file)) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md") && (file.startsWith("docs/") || ["README.md", "AGENTS.md"].includes(entry.name))) guides.push(file);
    }
  };
  for (const directory of ["docs", "src", "scripts", ".github"]) await walk(join(root, directory));
  for (const file of ["README.md", "AGENTS.md", "CONTRIBUTING.md"]) if (await stat(join(root, file)).catch(() => null)) guides.push(file);
  const errors: string[] = [];
  for (const file of [...new Set(guides)].sort()) {
    const text = await readFile(join(root, file), "utf8");
    for (const match of text.matchAll(/\bbun run ([A-Za-z0-9_][A-Za-z0-9_./:-]*)/g)) {
      const command = match[1]!.replace(/[.:]+$/, "");
      if (command === "src/" || command === "scripts/" || command === "tests/" || command.endsWith("/") || command.includes("<")) continue;
      const found = Object.hasOwn(pkg.scripts ?? {}, command) || command.includes("/") && (await stat(join(root, command)).catch(() => null))?.isFile();
      if (!found) errors.push(`${file}:${text.slice(0, match.index).split("\n").length}: unknown Bun command ${command}`);
    }
  }
  return errors;
}

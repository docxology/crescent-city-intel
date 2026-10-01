import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load } from "cheerio";
import { configurationInventory, publicExportInventory, httpDocumentation, githubReadmeDocumentation, validateCurrentGuidanceCommands, writeDocumentationInventory, validateDocumentationInventory } from "../src/doc_inventory.ts";
test("configuration inventory parses source, literal-key wrappers/aliases and discloses dynamic boundaries", () => {
  const documents = [{ file: "src/constants.ts", text: 'export function envInt(key:string,fallback:number){return Number(process.env[key]??fallback)}\nexport const DELAY=envInt("DELAY_MS", 2000);\nconst SECRET_NAME="FEED_COOKIE"; const cookie=process.env[SECRET_NAME] ?? "";' }, { file: "src/other.ts", text: 'const { PORT:port="3000" }=process.env;\nconst endpoint=process.env.ENDPOINT_URL ?? "https://example.test/";\nconst key=getKey(); const unknown=process.env[key];\nconst bun=Bun.env.MODE;' }];
  const inventory = configurationInventory(documents);
  expect(inventory.references.map(row => row.name)).toEqual(["DELAY_MS", "ENDPOINT_URL", "FEED_COOKIE", "MODE", "PORT"]);
  expect(inventory.references.find(row => row.name === "DELAY_MS")?.fallback).toBe("2000");
  expect(inventory.references.find(row => row.name === "PORT")?.fallback).toBe('"3000"');
  expect(inventory.dynamicReads.map(row => row.file)).toEqual(["src/constants.ts", "src/other.ts"]);
  expect(inventory.references.every(row => row.file && row.line > 0)).toBe(true);
});
test("qualified public exports bind signatures while keeping same basenames independent", () => {
  const first = [{ file: "src/a/index.ts", text: 'export function shared(value:number):string{return String(value)}\nexport interface Row{id:string}\nexport const COUNT=2;' }, { file: "src/b/index.ts", text: 'export function shared(value:string):string{return value}\nexport { shared as other } from "../a/index";' }];
  const rows = publicExportInventory(first);
  expect(rows.filter(row => row.name === "shared").map(row => row.file)).toEqual(["src/a/index.ts", "src/b/index.ts"]);
  expect(rows.find(row => row.name === "other")?.kind).toBe("re-export");
  const changedBody = publicExportInventory([{ ...first[0]!, text: first[0]!.text.replace("String(value)", '"changed body"') }]);
  expect(changedBody.find(row => row.name === "shared")?.declarationSha256).toBe(rows.find(row => row.name === "shared")?.declarationSha256);
  const changedSignature = publicExportInventory([{ ...first[0]!, text: first[0]!.text.replace("value:number", "value:string") }]);
  expect(changedSignature.find(row => row.name === "shared")?.declarationSha256).not.toBe(rows.find(row => row.name === "shared")?.declarationSha256);
});
test("configuration wrappers are file scoped and ambiguous shadowed names stay unresolved", () => {
  const inventory = configurationInventory([
    { file: "src/a.ts", text: 'function setting(name:string){return process.env[name]} setting("REAL_ENV");' },
    { file: "src/b.ts", text: 'function setting(name:string){return name} setting("NOT_AN_ENV_READ");' },
    { file: "src/c.ts", text: 'import {setting} from "./a"; setting("UNRESOLVED_IMPORTED_KEY");' },
    { file: "src/d.ts", text: 'function setting(name:string){return process.env[name]} function other(){const setting=(name:string)=>name; return setting("SHADOWED_KEY")} setting("AMBIGUOUS_KEY");' },
    { file: "src/e.ts", text: 'const KEY="OUTER_SECRET"; function dynamic(KEY:string){return process.env[KEY]}' },
    { file: "src/f.ts", text: 'let KEY="MUTABLE_KEY"; KEY=runtimeKey(); const value=process.env[KEY];' },
  ]);
  expect(inventory.references.map(row => row.name)).toEqual(["REAL_ENV"]);
  expect(inventory.references[0]?.file).toBe("src/a.ts");
  expect(inventory.dynamicReads.map(row => row.file)).toEqual(["src/a.ts", "src/d.ts", "src/e.ts", "src/f.ts"]);
});
test("HTTP inventory is structural and captures method/auth/parameter/content authority", () => {
  const spec = { openapi: "3.0.3", security: [{ apiKey: [] }], paths: { "/api/example": { parameters: [{ in: "query", name: "limit", schema: { type: "integer" } }], get: { security: [], responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } }, post: { requestBody: { content: { "application/json": {} } }, responses: { "202": {} } } } } };
  const first = httpDocumentation(Bun.YAML.stringify(spec));
  expect(first).toContain("GET /api/example"); expect(first).toContain("POST /api/example"); expect(first).toContain("query:limit"); expect(first).toContain("public"); expect(first).toContain("API key");
  expect(httpDocumentation(JSON.stringify(spec))).toBe(first);
});
test("GitHub README preserves rendered file destinations across Markdown, reference images and raw HTML", () => {
  const markdown = [
    "# Civic evidence", "", '[![Local image](assets/picture.svg "Map")](docs/start.md?raw=1#part "Guide")',
    "[Escaped](docs/a\\(b\\).md#part)", "[Balanced](docs/a(b).md)", "[Angle](<docs/a b.md?raw=1#part>)",
    "[Reference][guide] and [guide][] and [guide] and ![Reference image][photo]", "", '[guide]: ./docs/start.md#part "Guide"', '[photo]: <assets/picture.svg> "Map"',
    "", '<a href="docs/start.md?raw=1&amp;view=source#part"><img src=\'assets/picture.svg\' alt="Map"></a>', '<img alt="href=\'docs/literal.md\'" src="assets/picture.svg">',
    "[Anchor](#civic-evidence) [External](https://example.test/path) [Mail](mailto:reader@example.test) [Absolute](/absolute) [Query](?raw=1)",
    "", "`[Inline code](docs/unchanged.md)`", "", "    [Indented code](docs/unchanged.md)", '    <a href="docs/unchanged.md">Indented HTML</a>', "", "````markdown", '[Fenced code](docs/unchanged.md) <img src="assets/unchanged.svg">', "```", "````",
    "", "~~~html", '<a href="docs/unchanged.md">Example</a>', "~~~", "", '<!-- [Comment](docs/unchanged.md) <img src="assets/unchanged.svg"> -->',
    "", '<pre><code>[Literal HTML code](docs/unchanged.md)</code></pre>', "",
  ].join("\n");
  const generated = githubReadmeDocumentation(markdown);
  const links = (text: string): string[] => {
    const document = load(Bun.markdown.html(text));
    return document("a[href], img[src]").toArray().map(element => document(element).attr(element.tagName === "img" ? "src" : "href")!);
  };
  const sourceUrls = links(markdown), publishedUrls = links(generated);
  expect(sourceUrls.length).toBeGreaterThan(10);
  expect(publishedUrls).toHaveLength(sourceUrls.length);
  for (const [index, url] of sourceUrls.entries()) {
    if (url.startsWith("#") || url.startsWith("?")) expect(publishedUrls[index]).toBe(url);
    else expect(new URL(publishedUrls[index]!, "https://example.test/repository/.github/README.md").href).toBe(new URL(url, "https://example.test/repository/README.md").href);
  }
  expect(generated).toContain('[![Local image](../assets/picture.svg "Map")](../docs/start.md?raw=1#part "Guide")');
  expect(generated).toContain("[Escaped](../docs/a\\(b\\).md#part)");
  expect(generated).toContain('[guide]: .././docs/start.md#part "Guide"');
  expect(generated).toContain('<a href="../docs/start.md?raw=1&amp;view=source#part"><img src=\'../assets/picture.svg\' alt="Map"></a>');
  expect(generated).toContain('<img alt="href=\'docs/literal.md\'" src="../assets/picture.svg">');
  for (const literal of ["`[Inline code](docs/unchanged.md)`", "    [Indented code](docs/unchanged.md)", '    <a href="docs/unchanged.md">Indented HTML</a>', '[Fenced code](docs/unchanged.md) <img src="assets/unchanged.svg">', '<a href="docs/unchanged.md">Example</a>', '<!-- [Comment](docs/unchanged.md) <img src="assets/unchanged.svg"> -->', '<pre><code>[Literal HTML code](docs/unchanged.md)</code></pre>']) expect(generated).toContain(literal);
});
test("GitHub README projection refuses destination syntax it cannot preserve", () => {
  expect(() => githubReadmeDocumentation('<a href=docs/start.md>Unquoted local URL</a>')).toThrow("unsupported destination syntax");
  expect(githubReadmeDocumentation("    [Indented code](docs/unchanged.md)\n")).toContain("    [Indented code](docs/unchanged.md)\n");
  for (const url of [" https://example.test/path", "docs/start.md ", "\\docs/start.md", "https:\\example.test/path", "https://example.test/\tpath", "&#x20;https://example.test/path"]) expect(() => githubReadmeDocumentation(`<a href="${url}">Ambiguous URL</a>`)).toThrow("unsupported destination syntax");
});
test("GitHub README keeps Markdown fences inside comments and comment markers inside code literal", () => {
  const literals = ['`[Inline](docs/unchanged.md) <!-- comment marker`', '<!--\n```\n[Comment](docs/unchanged.md)\n-->', '```html\n<!-- unclosed comment marker\n```'];
  const markdown = `${literals.join("\n\n")}\n\n[Actual](docs/start.md)\n`;
  const generated = githubReadmeDocumentation(markdown);
  for (const literal of literals) expect(generated).toContain(literal);
  expect(generated).toContain("[Actual](../docs/start.md)");
});
test("generated authority drift names the affected document and never rewrites history", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-doc-authority-"));
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "scripts"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { "docs:generate": "bun run scripts/generate-docs.ts" } }));
    await writeFile(join(root, "src/example.ts"), 'export const LIMIT=Number(process.env.LIMIT ?? "2");');
    await writeFile(join(root, "README.md"), "# Fixture\n\n[Source](src/example.ts)\n");
    await writeFile(join(root, "openapi.yaml"), Bun.YAML.stringify({ paths: { "/api/example": { get: { responses: { "200": {} } } } } }));
    await writeFile(join(root, "CHANGELOG.md"), "Historical LIMIT=1\n"); await writeFile(join(root, "ISA.md"), "Frozen LIMIT=1\n");
    await writeDocumentationInventory(root);
    expect(await validateDocumentationInventory(root)).toEqual([]);
    expect(await readFile(join(root, ".github/README.md"), "utf8")).toContain("[Source](../src/example.ts)");
    await writeFile(join(root, ".github/README.md"), "Stale GitHub-facing overview\n");
    expect(await validateDocumentationInventory(root)).toEqual([".github/README.md: generated authority drift; run bun run docs:generate"]);
    await writeDocumentationInventory(root);
    await writeFile(join(root, "README.md"), "# Updated fixture\n\n[Source](src/example.ts)\n");
    expect(await validateDocumentationInventory(root)).toEqual([".github/README.md: generated authority drift; run bun run docs:generate"]);
    await writeDocumentationInventory(root);
    await writeFile(join(root, "src/example.ts"), 'export const LIMIT=Number(process.env.LIMIT ?? "3");');
    expect(await validateDocumentationInventory(root)).toEqual(["docs/generated/configuration.md: generated authority drift; run bun run docs:generate", "docs/generated/exports.md: generated authority drift; run bun run docs:generate"]);
    await writeDocumentationInventory(root);
    await writeFile(join(root, "docs/current.md"), "Run bun run obsolete-alias\n");
    expect(await validateCurrentGuidanceCommands(root)).toEqual(["docs/current.md:1: unknown Bun command obsolete-alias"]);
    await writeFile(join(root, "CHANGELOG.md"), "Historical bun run obsolete-alias\n");
    await writeFile(join(root, "docs/current.md"), "Run bun run docs:generate\n");
    expect(await validateCurrentGuidanceCommands(root)).toEqual([]);
    await writeFile(join(root, "CHANGELOG.md"), "Historical LIMIT=1\n");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("Historical LIMIT=1\n");
    expect(await readFile(join(root, "ISA.md"), "utf8")).toBe("Frozen LIMIT=1\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

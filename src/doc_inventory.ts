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

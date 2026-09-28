/**
 * Docs/modules dashboard derivation (Phase 14).
 *
 * Pure and offline-testable: given a repository root, it derives the
 * module roster from the source tree and the docs surfaces from the docs
 * directory — it never restates a hand-maintained list (the repo's
 * "rosters derived, not restated" principle). Sync status per module is
 * "which docs surfaces name this file"; per docs surface it is "which
 * named source files no longer exist". Absent backing data (a root with
 * no `src/` or no docs surfaces) is an explicit empty state (`empty:
 * true`), never a fabricated roster.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export interface DocsDashboardModule {
  file: string;
  documentedBy: string[];
}

export interface DocsDashboardSurface {
  file: string;
  namesModules: number;
  missingFiles: string[];
}

export interface DocsDashboardReport {
  generatedAt: string;
  empty: boolean;
  counts: {
    modules: number;
    documented: number;
    undocumented: number;
    docsSurfaces: number;
  };
  modules: DocsDashboardModule[];
  docsSurfaces: DocsDashboardSurface[];
}

const TS_FILE_PATTERN = /[A-Za-z0-9_./-]+\.ts\b/g;

/**
 * A named `.ts` file is stale only if it exists nowhere the docs could mean:
 * a bare basename is looked up under src/, scripts/ and tests/ (docs name
 * script and test files too); a path with a directory part is resolved from
 * the repo root and from src/ (e.g. `alerts/composite.ts`).
 */
function resolveSourceFile(root: string, name: string, moduleBasenames: Set<string>): boolean {
  if (moduleBasenames.has(name.split("/").pop()!)) return true;
  const candidates = name.includes("/")
    ? [join(root, name), join(root, "src", name)]
    : [join(root, "src", name), join(root, "scripts", name), join(root, "tests", name), join(root, name)];
  return candidates.some(c => existsSync(c));
}

export function listSourceModules(root: string, dir: string, out: string[] = []): string[] {
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      listSourceModules(root, rel, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

export function listDocsSurfaces(root: string, docsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, docsDir));
  } catch {
    return [];
  }
  return names
    .filter(n => n.endsWith(".md"))
    .sort()
    .map(n => `${docsDir}/${n}`);
}

export function buildDocsModuleIndex(root: string): DocsDashboardReport {
  const modules = listSourceModules(root, "src").sort();
  const surfaces = listDocsSurfaces(root, "docs/modules");
  // docs/architecture.md is also a module-naming surface (the AGENTS.md
  // module map); include it when present.
  if (existsSync(join(root, "docs/architecture.md"))) surfaces.push("docs/architecture.md");

  const surfaceText = new Map<string, string>();
  for (const surface of surfaces) {
    try {
      surfaceText.set(surface, readFileSync(join(root, surface), "utf-8"));
    } catch {
      surfaceText.set(surface, "");
    }
  }

  const moduleRows: DocsDashboardModule[] = modules.map(file => {
    const basename = file.split("/").pop()!;
    const documentedBy = surfaces.filter(s => (surfaceText.get(s) ?? "").includes(basename));
    return { file, documentedBy };
  });

  const moduleBasenames = new Set(modules.map(file => file.split("/").pop()!));
  const surfaceRows: DocsDashboardSurface[] = surfaces.map(surface => {
    const text = surfaceText.get(surface) ?? "";
    const named = [...new Set([...text.matchAll(TS_FILE_PATTERN)].map(m => m[0]!).filter(n => !n.startsWith(".")))];
    return {
      file: surface,
      namesModules: named.length,
      missingFiles: named.filter(name => !resolveSourceFile(root, name, moduleBasenames)),
    };
  });

  const documented = moduleRows.filter(m => m.documentedBy.length > 0).length;
  return {
    generatedAt: new Date().toISOString(),
    empty: moduleRows.length === 0,
    counts: {
      modules: moduleRows.length,
      documented,
      undocumented: moduleRows.length - documented,
      docsSurfaces: surfaces.length,
    },
    modules: moduleRows,
    docsSurfaces: surfaceRows,
  };
}

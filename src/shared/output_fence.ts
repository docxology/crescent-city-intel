/**
 * The output fence: proof that running the test suite did not modify the real
 * artifact corpus.
 *
 * `output/` is gitignored, so `git status` and the gate's `git diff --check` are
 * both blind to it — which is how one test's fixture accumulated 381 fabricated
 * government-meeting batches in the corpus, and how the Pages export came to
 * publish a fabricated city council meeting as a real record. A test that writes
 * into the corpus is a mock on a path reachable from a reported result; the only
 * reliable way to find the next one is to measure the tree before and after.
 *
 * The fence is deliberately cheap and total: every regular file's size and
 * modification time. A test that writes the same bytes back still moves mtime,
 * which is correct — save/restore-in-finally is exactly the pattern that failed,
 * and it should be reported rather than tolerated.
 */
import { readdir, stat } from "fs/promises";
import { join, relative } from "path";

/** Relative path -> "size:mtimeMs" for every regular file under a tree. */
export type TreeSnapshot = Record<string, string>;

/** What changed between two snapshots of the same tree. */
export interface TreeDrift {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Snapshot every regular file under `root`. A missing root is an empty
 * snapshot, not an error: a clean clone has no output tree yet.
 */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const snapshot: TreeSnapshot = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (info) snapshot[relative(root, full)] = `${info.size}:${info.mtimeMs}`;
    }
  };
  await walk(root);
  return snapshot;
}

/** Compare two snapshots of the same tree, newest second. */
export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeDrift {
  const added = Object.keys(after).filter(path => !(path in before)).sort();
  const removed = Object.keys(before).filter(path => !(path in after)).sort();
  const changed = Object.keys(after).filter(path => path in before && before[path] !== after[path]).sort();
  return { added, removed, changed };
}

/** True when nothing about the tree moved. */
export function isUnchanged(drift: TreeDrift): boolean {
  return drift.added.length === 0 && drift.removed.length === 0 && drift.changed.length === 0;
}

/**
 * A one-line-per-path report, capped so a runaway diff cannot bury the console.
 * The cap is reported rather than silently applied.
 */
export function describeDrift(drift: TreeDrift, limit = 12): string[] {
  const lines: string[] = [];
  for (const [label, paths] of [["added", drift.added], ["removed", drift.removed], ["modified", drift.changed]] as Array<[string, string[]]>) {
    for (const path of paths.slice(0, limit)) lines.push(`  ${label}: ${path}`);
    if (paths.length > limit) lines.push(`  ${label}: … and ${paths.length - limit} more`);
  }
  return lines;
}

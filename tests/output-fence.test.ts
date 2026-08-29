/**
 * The output fence's own controls (src/shared/output_fence.ts).
 *
 * The fence exists because `output/` is gitignored: nothing in the gate could
 * see a test writing into the real artifact corpus, so one test's fixture
 * accumulated 381 fabricated meeting batches there and the published calendar
 * carried a fabricated council meeting. A fence that cannot report drift would
 * be the same blindness with a reassuring name, so every drift shape it claims
 * to catch is exercised here against real temp trees.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describeDrift, diffTrees, isUnchanged, snapshotTree } from "../src/shared/output_fence.ts";

async function withTree(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cci-fence-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("output fence: drift is detected", () => {
  test("a file added anywhere under the tree is reported", async () => {
    await withTree(async root => {
      await mkdir(join(root, "gov_meetings"), { recursive: true });
      await writeFile(join(root, "gov_meetings", "real.json"), "{}");
      const before = await snapshotTree(root);

      await writeFile(join(root, "gov_meetings", "gov_meetings-fixture.json"), '{"items":[]}');
      const drift = diffTrees(before, await snapshotTree(root));

      expect(isUnchanged(drift)).toBe(false);
      expect(drift.added).toEqual(["gov_meetings/gov_meetings-fixture.json"]);
      expect(describeDrift(drift).join("\n")).toContain("added: gov_meetings/gov_meetings-fixture.json");
    });
  });

  test("a file whose CONTENT changed is reported even if its size is identical", async () => {
    await withTree(async root => {
      await writeFile(join(root, "manifest.json"), '{"articles":{"a":1}}');
      const before = await snapshotTree(root);
      // Same byte count, different bytes — the save/restore pattern's signature.
      await writeFile(join(root, "manifest.json"), '{"articles":{"b":2}}');
      const drift = diffTrees(before, await snapshotTree(root));
      expect(drift.changed).toEqual(["manifest.json"]);
    });
  });

  test("a file restored to its original bytes is still reported, because the write happened", async () => {
    await withTree(async root => {
      const file = join(root, "manifest.json");
      await writeFile(file, '{"articles":{}}');
      const before = await snapshotTree(root);
      await writeFile(file, '{"fixture":true}');
      await writeFile(file, '{"articles":{}}');
      const drift = diffTrees(before, await snapshotTree(root));
      // Identical content, moved mtime: save/restore-in-finally is the pattern
      // that raced and corrupted the corpus, so it must not read as "clean".
      expect(drift.changed).toEqual(["manifest.json"]);
    });
  });

  test("a deleted file is reported", async () => {
    await withTree(async root => {
      await writeFile(join(root, "toc.json"), "[]");
      const before = await snapshotTree(root);
      await rm(join(root, "toc.json"));
      const drift = diffTrees(before, await snapshotTree(root));
      expect(drift.removed).toEqual(["toc.json"]);
    });
  });

  test("an append to a log is reported", async () => {
    await withTree(async root => {
      const log = join(root, "search-queries.jsonl");
      await writeFile(log, '{"query":"harbor"}\n');
      const before = await snapshotTree(root);
      await writeFile(log, '{"query":"harbor"}\n{"query":"zoning"}\n');
      expect(diffTrees(before, await snapshotTree(root)).changed).toEqual(["search-queries.jsonl"]);
    });
  });
});

describe("output fence: a quiet run is not reported as drift", () => {
  test("reading a tree twice with no writes is unchanged", async () => {
    await withTree(async root => {
      await mkdir(join(root, "news"), { recursive: true });
      await writeFile(join(root, "news", "news-1.json"), '{"items":[]}');
      await writeFile(join(root, "toc.json"), "[]");
      const before = await snapshotTree(root);
      const drift = diffTrees(before, await snapshotTree(root));
      expect(isUnchanged(drift)).toBe(true);
      expect(describeDrift(drift)).toEqual([]);
    });
  });

  test("an unchanged file with a rewound mtime is still not drift when size and time match", async () => {
    await withTree(async root => {
      const file = join(root, "stable.json");
      await writeFile(file, "{}");
      const stamp = new Date(1_700_000_000_000);
      await utimes(file, stamp, stamp);
      const before = await snapshotTree(root);
      await utimes(file, stamp, stamp);
      expect(isUnchanged(diffTrees(before, await snapshotTree(root)))).toBe(true);
    });
  });

  test("a missing tree snapshots as empty rather than throwing", async () => {
    const snapshot = await snapshotTree(join(tmpdir(), "cci-fence-does-not-exist-30d1f"));
    expect(snapshot).toEqual({});
  });

  test("the report caps its listing and says how many it dropped", async () => {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) after[`gov_meetings/batch-${index}.json`] = "1:1";
    const lines = describeDrift(diffTrees(before, after), 5);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain("and 15 more");
  });
});

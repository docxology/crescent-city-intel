/**
 * Scoped redirection of the artifact root for tests that must WRITE.
 *
 * A test that writes into the real `output/` corpus is a mock on a path
 * reachable from a reported result: one such test left 381 fabricated meeting
 * batches there, and the published calendar carried one of them as a real
 * council meeting. `output/` is gitignored, so nothing noticed for months.
 *
 * `withCorpusCopy` gives the test a throwaway copy of the corpus and points
 * `CC_OUTPUT_DIR` at it, so reads still see real data while every write lands in
 * the copy. `withEmptyCorpus` is the same seam over an empty tree, for tests
 * that want the artifact-less edition. Both restore the environment afterwards,
 * and `scripts/validate.ts` fences the real corpus around the whole suite, so a
 * test that forgets to use them is caught rather than trusted.
 */
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Run `body` with the artifact root pointed at a copy of the real corpus. */
export async function withCorpusCopy<T>(body: (root: string) => Promise<T>): Promise<T> {
  return await withRedirectedRoot(body, { seedFrom: join(process.cwd(), "output") });
}

/** Run `body` with the artifact root pointed at an empty tree. */
export async function withEmptyCorpus<T>(body: (root: string) => Promise<T>): Promise<T> {
  return await withRedirectedRoot(body, {});
}

async function withRedirectedRoot<T>(body: (root: string) => Promise<T>, options: { seedFrom?: string }): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "cci-corpus-"));
  const previous = process.env.CC_OUTPUT_DIR;
  if (options.seedFrom && existsSync(options.seedFrom)) {
    await cp(options.seedFrom, root, { recursive: true });
  }
  process.env.CC_OUTPUT_DIR = root;
  try {
    return await body(root);
  } finally {
    if (previous === undefined) delete process.env.CC_OUTPUT_DIR;
    else process.env.CC_OUTPUT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * File-scoped variant for suites whose writes are spread across many tests:
 * call `beginCorpusCopy()` in beforeAll and `endCorpusCopy()` in afterAll.
 *
 * Note for callers: modules that freeze a path in a module-level constant read
 * the root at import time, before beforeAll runs. Those call sites must resolve
 * through `outputRoot()` (or an injected parameter) to follow the seam.
 */
let activeRoot: string | null = null;
let previousEnv: string | undefined;

export async function beginCorpusCopy(options: { seed?: boolean } = {}): Promise<string> {
  if (activeRoot) throw new Error("a corpus copy is already active for this test file");
  const root = await mkdtemp(join(tmpdir(), "cci-corpus-"));
  const source = join(process.cwd(), "output");
  if (options.seed !== false && existsSync(source)) {
    // Internal-SSD staging cache: the corpus lives on a slow external drive,
    // and each suite re-copying 40+ MB from it under parallel IO blew the
    // hook timeouts (2026-08-31). The cache is refreshed once per process
    // when the source's newest mtime moves ahead of the cached snapshot.
    if (!corpusCacheRoot) await ensureCorpusCache(source);
    if (corpusCacheRoot) await cp(corpusCacheRoot, root, { recursive: true });
    else await cp(source, root, { recursive: true });
  }
  previousEnv = process.env.CC_OUTPUT_DIR;
  process.env.CC_OUTPUT_DIR = root;
  activeRoot = root;
  return root;
}

let corpusCacheRoot: string | null = null;
let corpusCacheStamp = "";

async function ensureCorpusCache(source: string): Promise<void> {
  try {
    // Stamp = newest mtime in the corpus tree (cheap-enough single walk).
    let newest = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        const st = await stat(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    };
    await walk(source);
    const stamp = String(Math.floor(newest));
    const cacheBase = join(tmpdir(), "cci-corpus-cache");
    const cacheDir = join(cacheBase, stamp);
    if (existsSync(cacheDir)) {
      corpusCacheRoot = cacheDir;
      corpusCacheStamp = stamp;
      return;
    }
    await mkdir(cacheBase, { recursive: true });
    await cp(source, cacheDir, { recursive: true });
    corpusCacheRoot = cacheDir;
    corpusCacheStamp = stamp;
    // Best-effort: drop stale stamps so the cache stays bounded.
    for (const entry of await readdir(cacheBase)) {
      if (entry !== stamp) await rm(join(cacheBase, entry), { recursive: true, force: true });
    }
  } catch {
    corpusCacheRoot = null; // fall back to direct copy
  }
}


export async function endCorpusCopy(): Promise<void> {
  if (!activeRoot) return;
  if (previousEnv === undefined) delete process.env.CC_OUTPUT_DIR;
  else process.env.CC_OUTPUT_DIR = previousEnv;
  const root = activeRoot;
  activeRoot = null;
  await rm(root, { recursive: true, force: true });
}

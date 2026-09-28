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
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Run `body` with the artifact root pointed at a copy of the real corpus. */
export async function withCorpusCopy<T>(body: (root: string) => Promise<T>): Promise<T> {
  return await withRedirectedRoot(body, { seedFrom: join(process.cwd(), "output") });
}

/**
 * Run `body` against a copy of the corpus carrying only `articleCount` articles.
 *
 * `withCorpusCopy` copies every article, and `getCodeStats` reads all of them
 * through `loadAllArticles()`. That made the analytics-overview tests the
 * slowest thing in the suite by an order of magnitude: one built three full
 * overviews over the real 2,206-section corpus and missed its timeout under
 * full-suite parallelism while passing in isolation. Both were timing failures,
 * never real ones.
 *
 * Those tests assert FINGERPRINT properties (`first == repeat`,
 * `changed != first`) and signal-shape contracts, not corpus statistics — the
 * real corpus was never what they were checking. A handful of articles produces
 * the same code-stat shape in a fraction of the time.
 *
 * Everything EXCEPT `articles/` is copied in full, because the small artifacts
 * are what the fingerprint is actually computed over: `search-queries.jsonl`,
 * the alert and feed source-health records, the curation and pipeline
 * envelopes. Dropping any of them would change what the test measures rather
 * than how long it takes.
 */
export async function withMinimalCorpus<T>(articleCount: number, body: (root: string) => Promise<T>): Promise<T> {
  const source = join(process.cwd(), "output");
  if (!existsSync(source)) return await withEmptyCorpus(body);
  const root = await mkdtemp(join(tmpdir(), "cci-minimal-"));
  const previous = process.env.CC_OUTPUT_DIR;
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name === "articles") continue;
      await cp(join(source, entry.name), join(root, entry.name), { recursive: true });
    }
    const articlesDir = join(source, "articles");
    if (existsSync(articlesDir)) {
      await mkdir(join(root, "articles"), { recursive: true });
      const files = (await readdir(articlesDir)).filter(f => f.endsWith(".json")).sort();
      for (const file of files.slice(0, Math.max(0, articleCount))) {
        await cp(join(articlesDir, file), join(root, "articles", file));
      }
    }
    process.env.CC_OUTPUT_DIR = root;
    return await body(root);
  } finally {
    if (previous === undefined) delete process.env.CC_OUTPUT_DIR;
    else process.env.CC_OUTPUT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
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

/**
 * File-scoped corpus from the REAL tracked pages seed, not the local `output/`
 * tree. `beginCorpusCopy` seeds from `output/`, which is gitignored — on a
 * clean clone or in CI it does not exist, so any test seeded that way silently
 * saw an empty corpus and corpus-dependent assertions failed (the five
 * release-gate failures of 2026-09-28). `pages-data/crescent-city-code.json`
 * is the reviewed, committed municipal-code seed: materializing it into the
 * redirected root makes the contract corpus-independent without fabricating
 * data — same ethos as tests/laneD-search-perf.test.ts, which reads the same
 * seed directly.
 *
 * Pair with `endCorpusCopy()` in afterAll (it restores the env and removes the
 * tree), and rebuild any in-memory index that predates the seeding (e.g.
 * `reloadSearch()`, `invalidateSectionsCache()`).
 */
export async function beginSeedCorpus(): Promise<string> {
  if (activeRoot) throw new Error("a corpus copy is already active for this test file");
  const root = await mkdtemp(join(tmpdir(), "cci-seed-corpus-"));
  const seed = JSON.parse(
    await readFile(join(process.cwd(), "pages-data", "crescent-city-code.json"), "utf-8"),
  ) as { articles?: Array<{ guid?: string; title?: string }> };
  const articlesDir = join(root, "articles");
  await mkdir(articlesDir, { recursive: true });
  for (const article of seed.articles ?? []) {
    if (!article?.guid) continue;
    await Bun.write(join(articlesDir, `${article.guid}.json`), JSON.stringify(article));
  }
  previousEnv = process.env.CC_OUTPUT_DIR;
  process.env.CC_OUTPUT_DIR = root;
  activeRoot = root;
  return root;
}

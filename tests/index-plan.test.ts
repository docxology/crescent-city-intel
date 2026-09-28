/**
 * Per-article incremental index planning (`src/llm/index_plan.ts`).
 *
 * The TODO item this closes: `indexAllSections` skipped the rebuild only when
 * the WHOLE-corpus chunk fingerprint was unchanged, so a one-section edit
 * re-embedded all ~3,100 chunks. These tests pin the decision logic — which
 * articles to re-embed, which chunks to delete — with fixtures, so the
 * behaviour is verified without a live embedder or vector store.
 *
 * The load-bearing cases are the ones where being *almost* incremental is worse
 * than not being incremental at all: an embedding-model swap leaves every
 * per-article fingerprint valid while every stored vector is meaningless, and
 * an article that shrinks leaves trailing chunks nothing will ever overwrite.
 */
import { describe, expect, test } from "bun:test";
import {
  buildIndexManifest,
  chunksForArticle,
  fingerprintChunks,
  indexConfigSignature,
  planIncrementalIndex,
  INDEX_MANIFEST_SCHEMA,
  type ArticleChunkSet,
  type IndexManifest,
} from "../src/llm/index_plan.ts";
import type { FlatSection } from "../src/types.ts";

const CONFIG = { embeddingModel: "nomic-embed-text", chunkSize: 100, chunkOverlap: 20 };
const SIG = indexConfigSignature(CONFIG);

/** Build one article's chunk set from plain text, bypassing section shape. */
async function article(articleGuid: string, ...texts: string[]): Promise<ArticleChunkSet> {
  const chunks = texts.map((text, i) => ({ id: `${articleGuid}_s${i}_${i}`, text, metadata: {} }));
  return { articleGuid, chunks, fingerprint: await fingerprintChunks(chunks) };
}

const section = (over: Partial<FlatSection> & Pick<FlatSection, "guid" | "text">): FlatSection => ({
  number: "8.04.010",
  title: "Rates",
  history: "",
  articleGuid: "a1",
  articleTitle: "SEWER CHARGES",
  articleNumber: "8.04",
  ...over,
});

describe("indexConfigSignature", () => {
  test("changes when the model, chunk size, or overlap changes", () => {
    const base = indexConfigSignature(CONFIG);
    expect(indexConfigSignature({ ...CONFIG, embeddingModel: "mxbai-embed-large" })).not.toBe(base);
    expect(indexConfigSignature({ ...CONFIG, chunkSize: 200 })).not.toBe(base);
    expect(indexConfigSignature({ ...CONFIG, chunkOverlap: 40 })).not.toBe(base);
  });

  test("is stable for identical configuration", () => {
    expect(indexConfigSignature({ ...CONFIG })).toBe(SIG);
  });
});

describe("chunksForArticle", () => {
  test("embeds the number and title alongside the body", () => {
    // Capture what the chunker is handed: the composed header+body is the
    // embedder's input, and the header is what makes a bare "Rates" chunk
    // match a title query.
    let seen = "";
    const chunks = chunksForArticle(section({ guid: "g1", text: "Body text." }), text => {
      seen = text;
      return ["chunked"];
    });
    expect(seen).toBe("8.04.010: Rates\nBody text.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("chunked");
    expect(chunks[0]!.id).toBe("g1_0");
  });

  test("ids are namespaced per section and index", () => {
    const chunks = chunksForArticle(section({ guid: "g1", text: "x" }), t => [t, t, t]);
    expect(chunks.map(c => c.id)).toEqual(["g1_0", "g1_1", "g1_2"]);
    expect(chunks[2]!.metadata.chunkIndex).toBe("2");
  });

  test("metadata carries the section and article identity the retriever filters on", () => {
    const chunks = chunksForArticle(
      section({ guid: "g1", number: "12.08.010", title: "Harbor", text: "Berths", articleGuid: "art-9", articleTitle: "HARBOR" }),
      t => [t],
    );
    expect(chunks[0]!.metadata).toEqual({
      sectionGuid: "g1",
      sectionNumber: "12.08.010",
      sectionTitle: "Harbor",
      articleGuid: "art-9",
      articleTitle: "HARBOR",
      chunkIndex: "0",
    });
  });
});

describe("planIncrementalIndex — the incremental win", () => {
  test("a one-article edit re-embeds only that article", async () => {
    const before = [await article("a1", "one", "two"), await article("a2", "three"), await article("a3", "four")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });

    // a2 gains a chunk; a1 and a3 are untouched.
    const after = [await article("a1", "one", "two"), await article("a2", "three", "three-extra"), await article("a3", "four")];
    const plan = planIncrementalIndex(after, manifest, SIG);

    expect(plan.unchanged.sort()).toEqual(["a1", "a3"]);
    expect(plan.changed).toEqual(["a2"]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
    // The whole point: only a2's two chunks are embedded, not all five. The old
    // whole-corpus fingerprint would have re-embedded every chunk in the code.
    expect(plan.chunksToEmbed).toBe(2);
    expect(plan.totalChunks).toBe(5);
    expect(plan.noop).toBe(false);
  });

  test("an edit that does not change chunk count still re-embeds only that article", async () => {
    // The real municipal-code case: a re-scrape rewrites an article's text in
    // place, so the chunk COUNT is identical and only the text moves — exactly
    // the shape a whole-corpus fingerprint cannot distinguish cheaply.
    const before = [await article("a1", "stable", "stable"), await article("a2", "old", "old"), await article("a3", "stable")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const after = [await article("a1", "stable", "stable"), await article("a2", "new", "new"), await article("a3", "stable")];
    const plan = planIncrementalIndex(after, manifest, SIG);

    expect(plan.chunksToEmbed).toBe(2);
    expect(plan.totalChunks).toBe(5);
    expect(plan.unchanged.sort()).toEqual(["a1", "a3"]);
    // Same chunk ids, so nothing is orphaned.
    expect(plan.staleChunkIds).toEqual([]);
  });

  test("an unchanged corpus plans no work at all", async () => {
    const articles = [await article("a1", "one"), await article("a2", "two")];
    const manifest = await buildIndexManifest({ articles, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const plan = planIncrementalIndex(articles, manifest, SIG);
    expect(plan.noop).toBe(true);
    expect(plan.chunksToEmbed).toBe(0);
    expect(plan.staleChunkIds).toEqual([]);
    expect(plan.unchanged.sort()).toEqual(["a1", "a2"]);
  });

  test("a new article is added without disturbing the rest", async () => {
    const before = [await article("a1", "one")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const after = [await article("a1", "one"), await article("a9", "brand", "new")];
    const plan = planIncrementalIndex(after, manifest, SIG);
    expect(plan.added).toEqual(["a9"]);
    expect(plan.unchanged).toEqual(["a1"]);
    expect(plan.chunksToEmbed).toBe(2);
  });

  test("a removed article contributes every one of its chunk ids for deletion", async () => {
    const before = [await article("a1", "one"), await article("gone", "x", "y", "z")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const plan = planIncrementalIndex([await article("a1", "one")], manifest, SIG);
    expect(plan.removed).toEqual(["gone"]);
    expect(plan.staleChunkIds.sort()).toEqual(["gone_s0_0", "gone_s1_1", "gone_s2_2"].sort());
    // Nothing to embed — the removal is a pure delete.
    expect(plan.chunksToEmbed).toBe(0);
    expect(plan.noop).toBe(false);
  });
});

describe("planIncrementalIndex — the failure modes that matter", () => {
  test("changing the embedding model forces a full re-embed, not a no-op", async () => {
    // THE correctness case. Every article's text is identical, so every
    // fingerprint matches — but the stored vectors came from a different model.
    // Without the config signature this would be a silent no-op and the
    // collection would hold two models' geometry in one cosine space.
    const articles = [await article("a1", "one"), await article("a2", "two")];
    const manifest = await buildIndexManifest({ articles, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });

    const otherSig = indexConfigSignature({ ...CONFIG, embeddingModel: "mxbai-embed-large" });
    const plan = planIncrementalIndex(articles, manifest, otherSig);

    expect(plan.noop).toBe(false);
    expect(plan.fullRebuildReason).toContain("embedding model");
    expect(plan.unchanged).toEqual([]);
    expect(plan.added.sort()).toEqual(["a1", "a2"]);
    expect(plan.chunksToEmbed).toBe(plan.totalChunks);
  });

  test("changing the chunk size also invalidates every article", async () => {
    // A different chunk size produces different chunks from identical text.
    const articles = [await article("a1", "one")];
    const manifest = await buildIndexManifest({ articles, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const plan = planIncrementalIndex(articles, manifest, indexConfigSignature({ ...CONFIG, chunkSize: 250 }));
    expect(plan.fullRebuildReason).toContain("chunking parameters");
    expect(plan.chunksToEmbed).toBe(1);
  });

  test("a shrunk article's trailing chunk ids are deleted, not left orphaned", async () => {
    // The article went from three chunks to one. Ids 1 and 2 no longer exist in
    // the desired state, and nothing will ever upsert over them, so they must be
    // deleted or they hold stale text forever.
    const before = [await article("a1", "x", "y", "z")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const after = [await article("a1", "x")];
    const plan = planIncrementalIndex(after, manifest, SIG);

    expect(plan.changed).toEqual(["a1"]);
    expect(plan.staleChunkIds.sort()).toEqual(["a1_s1_1", "a1_s2_2"].sort());
    expect(plan.chunksToEmbed).toBe(1);
  });

  test("a v1 manifest is honoured as a full rebuild, and its chunk ids are not trusted", async () => {
    // The shipped manifest before this change had no per-article map. It must
    // produce a clean full re-embed, and it must NOT try to delete ids from a
    // map it does not have.
    const legacy = {
      schemaVersion: 1,
      generatedAt: "2026-08-25T00:00:00.000Z",
      fingerprint: "deadbeef",
      chunkCount: 3105,
      source: "municipal-code",
      embeddingModel: CONFIG.embeddingModel,
    } as unknown as IndexManifest;

    const articles = [await article("a1", "one"), await article("a2", "two")];
    const plan = planIncrementalIndex(articles, legacy, SIG);
    expect(plan.fullRebuildReason).toContain("predates per-article indexing");
    expect(plan.chunksToEmbed).toBe(2);
    expect(plan.staleChunkIds).toEqual([]);
  });

  test("no prior manifest embeds everything", async () => {
    const plan = planIncrementalIndex([await article("a1", "one")], null, SIG);
    expect(plan.fullRebuildReason).toBe("no prior index manifest");
    expect(plan.chunksToEmbed).toBe(1);
    expect(plan.noop).toBe(false);
  });

  test("a manifest whose per-article map is missing is rejected, not trusted", async () => {
    const broken = {
      schemaVersion: INDEX_MANIFEST_SCHEMA,
      generatedAt: "2026-09-01T00:00:00.000Z",
      fingerprint: "x",
      chunkCount: 1,
      source: "test",
      embeddingModel: CONFIG.embeddingModel,
      configSignature: SIG,
    } as unknown as IndexManifest;
    const plan = planIncrementalIndex([await article("a1", "one")], broken, SIG);
    expect(plan.fullRebuildReason).toContain("no per-article map");
    expect(plan.chunksToEmbed).toBe(1);
  });
});

describe("planIncrementalIndex — store reconciliation", () => {
  test("deletion candidates already absent from the store are dropped", async () => {
    const before = [await article("a1", "one"), await article("gone", "x")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    // The store already lost "gone_s0_0" — a redundant delete is a no-op in
    // Chroma, but skipping it keeps the log honest about what it removed.
    const plan = planIncrementalIndex([await article("a1", "one")], manifest, SIG, new Set(["a1_s0_0"]));
    expect(plan.removed).toEqual(["gone"]);
    expect(plan.staleChunkIds).toEqual([]);
  });

  test("stale ids are deduplicated", async () => {
    // An article that shrank and was also removed cannot both be true in one
    // run, but a manifest with duplicated ids must not produce a doubled delete.
    const before = [await article("a1", "x", "y")];
    const manifest = await buildIndexManifest({ articles: before, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test" });
    const plan = planIncrementalIndex([await article("a1", "x")], manifest, SIG);
    expect(plan.staleChunkIds).toEqual([...new Set(plan.staleChunkIds)]);
  });
});

describe("buildIndexManifest", () => {
  test("records every article's fingerprint and chunk ids", async () => {
    const articles = [await article("a1", "one", "two"), await article("a2", "three")];
    const manifest = await buildIndexManifest({
      articles, configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "municipal-code", generatedAt: "2026-09-28T00:00:00.000Z",
    });
    expect(manifest.schemaVersion).toBe(INDEX_MANIFEST_SCHEMA);
    expect(manifest.chunkCount).toBe(3);
    expect(manifest.generatedAt).toBe("2026-09-28T00:00:00.000Z");
    expect(Object.keys(manifest.articles).sort()).toEqual(["a1", "a2"]);
    expect(manifest.articles.a1!.chunkIds).toHaveLength(2);
    expect(manifest.articles.a1!.fingerprint).toBe(articles[0]!.fingerprint);
  });

  test("is deterministic for identical input", async () => {
    const build = async () => buildIndexManifest({
      articles: [await article("a1", "one", "two"), await article("a2", "three")],
      configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test", generatedAt: "fixed",
    });
    expect((await build()).fingerprint).toBe((await build()).fingerprint);
  });

  test("round-trips through JSON unchanged", async () => {
    // The manifest is written to disk and read back on the next run; a shape
    // that survives `JSON.parse(JSON.stringify(...))` is what makes the
    // incremental path work at all.
    const manifest = await buildIndexManifest({
      articles: [await article("a1", "one")], configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test",
    });
    const round = JSON.parse(JSON.stringify(manifest)) as IndexManifest;
    const plan = planIncrementalIndex([await article("a1", "one")], round, SIG);
    expect(plan.noop).toBe(true);
  });

  test("the corpus fingerprint moves when any article's text moves", async () => {
    const before = await buildIndexManifest({
      articles: [await article("a1", "one"), await article("a2", "two")],
      configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test",
    });
    const after = await buildIndexManifest({
      articles: [await article("a1", "one"), await article("a2", "TWO")],
      configSignature: SIG, embeddingModel: CONFIG.embeddingModel, source: "test",
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // ...while the untouched article's own fingerprint does not.
    expect(after.articles.a1!.fingerprint).toBe(before.articles.a1!.fingerprint);
  });
});

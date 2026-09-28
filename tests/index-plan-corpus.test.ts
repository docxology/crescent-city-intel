/**
 * The incremental-index claim, measured on the REAL scraped corpus.
 *
 * `tests/index-plan.test.ts` proves the planner is correct on fixtures. This
 * proves the win is real: it runs the same grouping and fingerprinting that
 * `indexAllSections` performs over the actual `output/articles/*.json` and
 * compares what the old whole-corpus check would have decided against what the
 * per-article plan decides for a realistic one-article edit.
 *
 * Without this, "1 section edit no longer re-embeds 3,105 chunks" would be an
 * assertion about arithmetic rather than about this corpus. It also degrades to
 * a no-op on a host with no scraped corpus, rather than failing.
 */
import { describe, expect, test } from "bun:test";
import { loadAllSections } from "../src/shared/data.ts";
import { chunkText } from "../src/llm/embeddings.ts";
import {
  buildIndexManifest,
  chunksForArticle,
  fingerprintChunks,
  indexConfigSignature,
  planIncrementalIndex,
  type ArticleChunkSet,
} from "../src/llm/index_plan.ts";
import { llmConfig } from "../src/llm/config.ts";
import { computeSha256 } from "../src/utils.ts";

const SIG = indexConfigSignature({
  embeddingModel: llmConfig.embeddingModel,
  chunkSize: llmConfig.chunkSize,
  chunkOverlap: llmConfig.chunkOverlap,
});

async function corpus(): Promise<ArticleChunkSet[]> {
  const sections = await loadAllSections();
  const byArticle = new Map<string, Planned[]>();
  for (const section of sections) {
    const chunks = chunksForArticle(section, chunkText);
    const existing = byArticle.get(section.articleGuid);
    if (existing) existing.push(...chunks);
    else byArticle.set(section.articleGuid, [...chunks]);
  }
  type Planned = ReturnType<typeof chunksForArticle>[number];
  const articles: ArticleChunkSet[] = [];
  for (const [articleGuid, chunks] of byArticle) {
    articles.push({ articleGuid, chunks, fingerprint: await fingerprintChunks(chunks) });
  }
  return articles;
}

describe("incremental indexing over the real municipal code", () => {
  test("a one-article edit re-embeds a small fraction of the corpus", async () => {
    const before = await corpus();
    if (before.length === 0) return; // no scraped corpus on this host
    const manifest = await buildIndexManifest({
      articles: before, configSignature: SIG, embeddingModel: llmConfig.embeddingModel, source: "municipal-code",
    });

    // Pick the article with the most chunks, so the measured saving is the most
    // generous case an editor could actually produce.
    const target = [...before].sort((a, b) => b.chunks.length - a.chunks.length)[0]!;
    const edited = before.map(article =>
      article.articleGuid === target.articleGuid
        ? { ...article, chunks: article.chunks.map((c, i) => (i === 0 ? { ...c, text: `${c.text} (amended)` } : c)) }
        : article,
    );
    for (const article of edited) {
      if (article.articleGuid === target.articleGuid) article.fingerprint = await fingerprintChunks(article.chunks);
    }

    const plan = planIncrementalIndex(edited, manifest, SIG);

    // The old behaviour: any text change moved the whole-corpus fingerprint,
    // so every chunk in the code was re-embedded.
    const wholeCorpusFingerprint = await computeSha256(edited.flatMap(a => a.chunks).map(c => `${c.id}\0${c.text}`).join("\n"));
    expect(wholeCorpusFingerprint).not.toBe(manifest.fingerprint);

    expect(plan.changed).toEqual([target.articleGuid]);
    expect(plan.unchanged.length).toBe(before.length - 1);
    expect(plan.chunksToEmbed).toBe(target.chunks.length);
    expect(plan.chunksToEmbed).toBeLessThan(plan.totalChunks);
    // The saving is the whole point: well under a third of the corpus.
    expect(plan.chunksToEmbed / plan.totalChunks).toBeLessThan(0.34);
  }, 120000);

  test("an untouched corpus is a no-op, so a re-run costs nothing", async () => {
    const articles = await corpus();
    if (articles.length === 0) return;
    const manifest = await buildIndexManifest({
      articles, configSignature: SIG, embeddingModel: llmConfig.embeddingModel, source: "municipal-code",
    });
    const plan = planIncrementalIndex(articles, manifest, SIG);
    expect(plan.noop).toBe(true);
    expect(plan.chunksToEmbed).toBe(0);
    expect(plan.staleChunkIds).toEqual([]);
  }, 120000);

  test("changing the embedding model invalidates the whole real corpus", async () => {
    const articles = await corpus();
    if (articles.length === 0) return;
    const manifest = await buildIndexManifest({
      articles, configSignature: SIG, embeddingModel: llmConfig.embeddingModel, source: "municipal-code",
    });
    const swapped = indexConfigSignature({ ...SIG_PARTS, embeddingModel: `${llmConfig.embeddingModel}-v2` });
    const plan = planIncrementalIndex(articles, manifest, swapped);
    expect(plan.fullRebuildReason).toContain("embedding model");
    expect(plan.chunksToEmbed).toBe(plan.totalChunks);
    expect(plan.totalChunks).toBeGreaterThan(0);
  }, 120000);
});

const SIG_PARTS = {
  embeddingModel: llmConfig.embeddingModel,
  chunkSize: llmConfig.chunkSize,
  chunkOverlap: llmConfig.chunkOverlap,
};

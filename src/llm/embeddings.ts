/** Indexing pipeline — loads sections, chunks, embeds, and stores in ChromaDB */
import { loadAllSections } from "../shared/data.js";
import { embed, embedBatch } from "./ollama.js";
import { addDocuments, deleteDocuments, getDocumentIds, getStats } from "./chroma.js";
import { llmConfig } from "./config.js";
import { EMBED_BATCH_SIZE } from "../constants.js";
import { createLogger } from "../logger.js";
import type { FlatSection } from "../types.js";
import { paths } from "../shared/paths.js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { writeJsonAtomic } from "../shared/source_health.js";
import {
  buildIndexManifest,
  chunksForArticle,
  fingerprintChunks,
  indexConfigSignature,
  planIncrementalIndex,
  type ArticleChunkSet,
  type IndexManifest,
  type PlannedChunk,
} from "./index_plan.js";

const log = createLogger("embeddings");

/** Split text into overlapping chunks */
export function chunkText(
  text: string,
  chunkSize = llmConfig.chunkSize,
  overlap = llmConfig.chunkOverlap
): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks;
}

/** Check if the collection already has the expected number of documents */
export async function isIndexed(): Promise<boolean> {
  try {
    const stats = await getStats();
    return stats.count > 0;
  } catch {
    return false;
  }
}

/**
 * Index all sections into ChromaDB.
 *
 * Incremental at ARTICLE granularity (see `index_plan.ts`): a one-section edit
 * re-embeds that article's chunks and nothing else, where the previous
 * whole-corpus fingerprint check re-embedded all ~3,100. The plan also carries
 * the embedding model and chunking parameters, so a model swap forces a full
 * re-embed rather than silently mixing two models' vectors in one cosine space.
 */
export async function indexAllSections(): Promise<void> {
  log.info("Loading all sections...");
  const sections = await loadAllSections();
  log.info(`Found ${sections.length} sections to index`);

  const stats = await getStats();
  const existingCount = stats.count;
  if (existingCount > 0) {
    log.info(`Collection already has ${existingCount} documents`);
  }

  // Group chunks by article. Order is the corpus order, so the manifest and the
  // logs are reproducible for identical input.
  const byArticle = new Map<string, ArticleChunkSet>();
  for (const section of sections) {
    const chunks = chunksForArticle(section, chunkText);
    const entry = byArticle.get(section.articleGuid);
    if (entry) {
      entry.chunks.push(...chunks);
    } else {
      byArticle.set(section.articleGuid, { articleGuid: section.articleGuid, chunks: [...chunks], fingerprint: "" });
    }
  }
  const articles: ArticleChunkSet[] = [...byArticle.values()];
  for (const article of articles) {
    article.fingerprint = await fingerprintChunks(article.chunks);
  }

  const configSignature = indexConfigSignature({
    embeddingModel: llmConfig.embeddingModel,
    chunkSize: llmConfig.chunkSize,
    chunkOverlap: llmConfig.chunkOverlap,
  });

  let previous: IndexManifest | null = null;
  if (existsSync(paths.indexManifest)) {
    try {
      previous = JSON.parse(await readFile(paths.indexManifest, "utf-8")) as IndexManifest;
    } catch {
      log.warn("Ignoring unreadable index manifest; rebuilding deterministically");
    }
  }

  // Only sweep the store for ids when a plan might need to delete something —
  // it is a full collection read.
  const existingIds = existingCount > 0 ? new Set(await getDocumentIds()) : undefined;
  const plan = planIncrementalIndex(articles, previous, configSignature, existingIds);

  if (plan.fullRebuildReason) {
    log.info(`Full re-embed required: ${plan.fullRebuildReason}`);
  }
  if (plan.removed.length > 0) log.info(`${plan.removed.length} article(s) no longer in the corpus`);
  if (plan.unchanged.length > 0) {
    log.info(`${plan.unchanged.length}/${articles.length} article(s) unchanged; skipping their chunks`);
  }
  if (plan.changed.length > 0) log.info(`${plan.changed.length} article(s) changed; re-embedding them`);
  if (plan.added.length > 0) log.info(`${plan.added.length} new article(s) to embed`);

  // Delete BEFORE embedding. A changed article is upserted by id, so an article
  // that shrank would otherwise leave its trailing chunks holding stale text
  // that nothing will ever overwrite. Deleting the union of recorded stale ids
  // and the changed articles' own current ids is the safe order: the upsert
  // re-adds them with fresh vectors.
  const deleteIds = new Set(plan.staleChunkIds);
  for (const articleGuid of [...plan.changed, ...plan.added]) {
    for (const chunk of byArticle.get(articleGuid)!.chunks) deleteIds.add(chunk.id);
  }
  const toDelete = [...deleteIds].filter(id => !existingIds || existingIds.has(id));
  if (toDelete.length > 0) {
    await deleteDocuments(toDelete);
    log.info(`Removed ${toDelete.length} index chunk(s) before re-embedding`);
  }

  if (plan.noop) {
    log.info("Index already current; nothing to embed");
    return;
  }

  const toEmbed: PlannedChunk[] = [];
  for (const articleGuid of [...plan.changed, ...plan.added]) {
    toEmbed.push(...byArticle.get(articleGuid)!.chunks);
  }
  log.info(`Total chunks to embed: ${toEmbed.length} of ${plan.totalChunks}`);

  let indexed = 0;
  const failedIds: string[] = [];

  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    try {
      const embeddings = await embedBatch(texts);

      await addDocuments({
        ids: batch.map((c) => c.id),
        embeddings,
        documents: texts,
        metadatas: batch.map((c) => c.metadata),
      });

      indexed += batch.length;
      if (indexed % 100 === 0 || indexed === toEmbed.length) {
        log.info(`Indexed ${indexed}/${toEmbed.length} chunks...`);
      }
    } catch (err: any) {
      log.error(`Error indexing batch at ${i}`, { error: err.message });
      // Try one at a time as fallback
      for (const chunk of batch) {
        try {
          const embedding = await embed(chunk.text);
          await addDocuments({
            ids: [chunk.id],
            embeddings: [embedding],
            documents: [chunk.text],
            metadatas: [chunk.metadata],
          });
          indexed++;
        } catch (e: any) {
          log.error(`Failed to index chunk ${chunk.id}`, { error: e.message });
          failedIds.push(chunk.id);
        }
      }
    }
  }

  if (failedIds.length > 0) {
    throw new Error(`Indexing failed for ${failedIds.length} chunk(s): ${failedIds.slice(0, 5).join(", ")}`);
  }

  // Write the manifest only after every chunk succeeded, so a failed run leaves
  // the previous state intact and the next run re-does the work rather than
  // trusting a manifest describing chunks that were never written.
  const manifest = await buildIndexManifest({
    articles,
    configSignature,
    embeddingModel: llmConfig.embeddingModel,
    source: "municipal-code",
  });
  await writeJsonAtomic(paths.indexManifest, manifest);

  const finalStats = await getStats();
  log.info(`Indexing complete: ${finalStats.count} documents in collection (${indexed} embedded this run)`);
}

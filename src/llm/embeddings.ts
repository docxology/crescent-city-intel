/** Indexing pipeline — loads sections, chunks, embeds, and stores in ChromaDB */
import { loadAllArticles } from "../shared/data.js";
import { embedBatch } from "./ollama.js";
import { addDocuments, getDocuments, getDocumentIds, discardCollection, servingCollectionName } from "./chroma.js";
import { withFileLease } from "../shared/storage.js";
import { join } from "path";
import { boundedSignal } from "./runtime.js";
import { llmConfig } from "./config.js";
import { EMBED_BATCH_SIZE } from "../constants.js";
import { createLogger } from "../logger.js";
import type { FlatSection } from "../types.js";
import { paths } from "../shared/paths.js";
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
} from "./index_plan.js";

const log = createLogger("embeddings");

/** Split text into overlapping chunks */
export function chunkText(
  text: string,
  chunkSize = llmConfig.chunkSize,
  overlap = llmConfig.chunkOverlap
): string[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || !Number.isSafeInteger(overlap) || overlap < 0 || overlap >= chunkSize) throw new Error("Invalid chunk size/overlap");
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

/** A serving receipt must match configuration and every owned ID actually stored. */
export async function isIndexed(options: { signal?: AbortSignal } = {}): Promise<boolean> {
  try {
    options.signal?.throwIfAborted();
    const manifest = JSON.parse(await readFile(paths.indexManifest, "utf8")) as IndexManifest;
    options.signal?.throwIfAborted();
    if (manifest.schemaVersion !== 2 || manifest.configSignature !== indexConfigSignature(llmConfig) || !manifest.articles) return false;
    const corpusManifest = await readFile(paths.manifest, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    options.signal?.throwIfAborted();
    if (corpusManifest !== null && manifest.corpusManifestSha256 !== sourceHash(corpusManifest)) return false;
    const ids = new Set(await getDocumentIds({ signal: options.signal, collection: manifest.servingCollection }));
    options.signal?.throwIfAborted();
    const owned = Object.values(manifest.articles).flatMap(article => article.chunkIds);
    return owned.length > 0 && owned.length === manifest.chunkCount && owned.every(id => ids.has(id));
  } catch { options.signal?.throwIfAborted(); return false; }
}

/**
 * Index all sections into ChromaDB.
 *
 * Incremental at ARTICLE granularity (see `index_plan.ts`): a one-section edit
 * re-embeds that article's chunks. The plan also carries
 * the embedding model and chunking parameters, so a model swap forces a full
 * re-embed rather than silently mixing two models' vectors in one cosine space.
 */
export async function indexAllSections(options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<void> {
  const manifest = await readFile(paths.manifest, "utf8"), corpusManifestSha256 = sourceHash(manifest);
  const articles = await loadAllArticles();
  const sections: FlatSection[] = articles.flatMap(article => article.sections.map(section => ({ guid: section.guid, number: section.number, title: section.title, text: section.text, history: section.history, articleGuid: article.guid, articleTitle: article.title, articleNumber: article.number })));
  if (sourceHash(await readFile(paths.manifest, "utf8")) !== corpusManifestSha256) throw new Error("Source corpus changed during indexing; retry the complete edition");
  await indexSections(sections, { ...options, corpusManifestSha256 });
}

function sourceHash(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }

/** Stage a complete edition; the old serving collection is never modified. */
export async function indexSections(sections: FlatSection[], options: { signal?: AbortSignal; deadlineMs?: number; corpusManifestSha256?: string } = {}): Promise<void> {
  if (options.corpusManifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.corpusManifestSha256)) throw new Error("Invalid corpus manifest hash");
  const deadlineMs = options.deadlineMs ?? 300_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_600_000) throw new Error("Index deadline must be an integer from 1 to 3600000 ms");
  const signal = boundedSignal(options.signal, deadlineMs);
  await withFileLease(join(paths.state, "index-writer.lock"), async () => {
    signal.throwIfAborted();
    const byArticle = new Map<string, ArticleChunkSet>();
    for (const section of sections) {
      const entry = byArticle.get(section.articleGuid) ?? { articleGuid: section.articleGuid, chunks: [], fingerprint: "" };
      entry.chunks.push(...chunksForArticle(section, chunkText)); byArticle.set(section.articleGuid, entry);
    }
    const articles = [...byArticle.values()];
    for (const article of articles) article.fingerprint = await fingerprintChunks(article.chunks);
    const configSignature = indexConfigSignature(llmConfig);
    let previous: IndexManifest | null = null;
    try { previous = JSON.parse(await readFile(paths.indexManifest, "utf8")); } catch { /* first index or unreadable receipt */ }
    const priorCollection = await servingCollectionName();
    const existingIds = new Set(await getDocumentIds({ signal, collection: priorCollection }));
    const plan = planIncrementalIndex(articles, previous, configSignature, existingIds);
    const desiredIds = new Set(articles.flatMap(article => article.chunks.map(chunk => chunk.id)));
    const canKeepTranscripts = previous?.configSignature === configSignature;
    if (plan.noop && previous?.corpusManifestSha256 === options.corpusManifestSha256 && [...existingIds].every(id => desiredIds.has(id) || canKeepTranscripts && id.startsWith("youtube_"))) return;
    const staged = `${llmConfig.collectionName}-stage-${crypto.randomUUID()}`;
    try {
      // Copy only known unchanged code IDs and same-geometry transcript records.
      const unchanged = new Set(articles.filter(article => plan.unchanged.includes(article.articleGuid)).flatMap(article => article.chunks.map(chunk => chunk.id)));
      const copyIds = [...existingIds].filter(id => unchanged.has(id) || (canKeepTranscripts && id.startsWith("youtube_")));
      for (let offset = 0; offset < copyIds.length; offset += EMBED_BATCH_SIZE) {
        const batch = await getDocuments(copyIds.slice(offset, offset + EMBED_BATCH_SIZE), { signal, collection: priorCollection });
        if (batch.ids.length !== Math.min(EMBED_BATCH_SIZE, copyIds.length - offset)) throw new Error("Serving vectors changed during rebuild");
        await addDocuments(batch, { signal, collection: staged });
      }
      const toEmbed = articles.filter(article => !plan.unchanged.includes(article.articleGuid)).flatMap(article => article.chunks);
      for (let offset = 0; offset < toEmbed.length; offset += EMBED_BATCH_SIZE) {
        signal.throwIfAborted();
        const chunks = toEmbed.slice(offset, offset + EMBED_BATCH_SIZE);
        await addDocuments({ ids: chunks.map(chunk => chunk.id), embeddings: await embedBatch(chunks.map(chunk => chunk.text), { signal }), documents: chunks.map(chunk => chunk.text), metadatas: chunks.map(chunk => chunk.metadata) }, { signal, collection: staged });
      }
      const expected = new Set([...articles.flatMap(article => article.chunks.map(chunk => chunk.id)), ...copyIds.filter(id => !unchanged.has(id))]);
      const actual = new Set(await getDocumentIds({ signal, collection: staged }));
      if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) throw new Error("Staged index is incomplete; serving edition retained");
      const manifest = await buildIndexManifest({ articles, configSignature, embeddingModel: llmConfig.embeddingModel, source: "municipal-code" });
      signal.throwIfAborted();
      if (options.corpusManifestSha256 && sourceHash(await readFile(paths.manifest, "utf8")) !== options.corpusManifestSha256) throw new Error("Source corpus changed before activation; serving edition retained");
      // One atomic receipt activates both collection identity and corpus identity.
      await writeJsonAtomic(paths.indexManifest, { ...manifest, ...(options.corpusManifestSha256 ? { corpusManifestSha256: options.corpusManifestSha256 } : {}), servingCollection: staged, previousCollection: priorCollection, transcriptReindexRequired: !canKeepTranscripts && [...existingIds].some(id => id.startsWith("youtube_")) });
      log.info("Complete staged index activated", { chunkCount: String(manifest.chunkCount), collection: staged });
    } catch (error) {
      await discardCollection(staged).catch(() => undefined);
      throw error;
    }
  }, { waitMs: 1000, staleMs: 30_000 });
}

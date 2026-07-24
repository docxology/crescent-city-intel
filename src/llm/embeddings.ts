/** Indexing pipeline — loads sections, chunks, embeds, and stores in ChromaDB */
import { loadAllSections } from "../shared/data.js";
import { embed, embedBatch } from "./ollama.js";
import { addDocuments, deleteDocuments, getDocumentIds, getStats } from "./chroma.js";
import { llmConfig } from "./config.js";
import { EMBED_BATCH_SIZE } from "../constants.js";
import { createLogger } from "../logger.js";
import type { FlatSection } from "../types.js";
import { computeSha256 } from "../utils.js";
import { paths } from "../shared/paths.js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { writeJsonAtomic } from "../shared/source_health.js";

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

/** Index all sections into ChromaDB (incremental — skips unchanged sections) */
export async function indexAllSections(): Promise<void> {
  log.info("Loading all sections...");
  const sections = await loadAllSections();
  log.info(`Found ${sections.length} sections to index`);

  // Check existing index
  const stats = await getStats();
  const existingCount = stats.count;
  if (existingCount > 0) {
    log.info(`Collection already has ${existingCount} documents`);
  }

  // Prepare chunks with metadata
  const allChunks: {
    id: string;
    text: string;
    metadata: Record<string, string>;
  }[] = [];

  for (const section of sections) {
    const text = `${section.number}: ${section.title}\n${section.text}`;
    const chunks = chunkText(text);

    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        id: `${section.guid}_${i}`,
        text: chunks[i],
        metadata: {
          sectionGuid: section.guid,
          sectionNumber: section.number,
          sectionTitle: section.title,
          articleGuid: section.articleGuid,
          articleTitle: section.articleTitle,
          chunkIndex: String(i),
        },
      });
    }
  }

  const fingerprint = await computeSha256(allChunks.map(chunk => `${chunk.id}\0${chunk.text}`).join("\n"));
  if (existsSync(paths.indexManifest)) {
    try {
      const previous = JSON.parse(await readFile(paths.indexManifest, "utf-8")) as { fingerprint?: string; chunkCount?: number };
      if (previous.fingerprint === fingerprint && previous.chunkCount === allChunks.length && existingCount === allChunks.length) {
        log.info(`Index fingerprint ${fingerprint.slice(0, 12)} unchanged — skipping rebuild`);
        return;
      }
    } catch {
      log.warn("Ignoring unreadable index manifest; rebuilding deterministically");
    }
  }

  if (existingCount > 0) {
    const existingIds = await getDocumentIds();
    const desiredIds = new Set(allChunks.map(chunk => chunk.id));
    const staleIds = existingIds.filter(id => !desiredIds.has(id));
    if (staleIds.length > 0) {
      await deleteDocuments(staleIds);
      log.info(`Removed ${staleIds.length} stale index chunks`);
    }
    log.info(`Rebuilding index: ${existingCount} existing chunks, ${allChunks.length} desired chunks`);
  }

  log.info(`Total chunks to embed: ${allChunks.length}`);

  // Process in batches
  let indexed = 0;
  const failedIds: string[] = [];

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
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
      if (indexed % 100 === 0 || indexed === allChunks.length) {
        log.info(`Indexed ${indexed}/${allChunks.length} chunks...`);
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

  const finalStats = await getStats();
  if (failedIds.length > 0) {
    throw new Error(`Indexing failed for ${failedIds.length} chunk(s): ${failedIds.slice(0, 5).join(", ")}`);
  }
  await writeJsonAtomic(paths.indexManifest, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fingerprint,
    chunkCount: allChunks.length,
    source: "municipal-code",
    embeddingModel: llmConfig.embeddingModel,
  });
  log.info(`Indexing complete: ${finalStats.count} documents in collection`);
}

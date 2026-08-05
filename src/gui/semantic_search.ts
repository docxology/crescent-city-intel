/**
 * Semantic search — embed the query with Ollama, query ChromaDB, and map the
 * retrieved chunks to the same result shape as BM25. When the vector stack is
 * unavailable (Ollama/ChromaDB not running, or any embed/query failure) it
 * degrades to the in-memory BM25 index and reports mode:"bm25-fallback", so
 * the endpoint never hard-fails on a missing vector store.
 *
 * Preflight uses SHORT health checks (2s Ollama, heartbeat Chroma) before
 * committing to full embed/query, so a down stack fails fast instead of
 * stalling the search UX for the 30s embed timeout.
 */
import { initSearch, search, type PagedSearchResult } from "./search.js";
import { llmConfig } from "../llm/config.js";
import { createLogger } from "../logger.js";

const log = createLogger("semantic-search");

export interface SemanticHit {
  guid: string;
  number: string;
  title: string;
  snippet: string;
  /** Normalized relevance 0..1 (1 = most relevant) */
  score: number;
}

export interface SemanticSearchResult {
  mode: "semantic" | "bm25-fallback";
  query: string;
  total: number;
  count: number;
  results: SemanticHit[];
  vectorStoreAvailable: boolean;
  reason: string | null;
}

/** Normalize a BM25 hit (section + snippet + matchCount) into the shared shape. */
function toHit(section: { guid: string; number: string; title: string }, snippet: string, score: number): SemanticHit {
  return { guid: section.guid, number: section.number, title: section.title, snippet, score };
}

/** Deterministic BM25 fallback path — exported for direct testing. */
export async function bm25Fallback(
  query: string,
  options: { limit?: number; offset?: number } = {},
  reason: string,
): Promise<SemanticSearchResult> {
  await initSearch();
  const { limit = 20, offset = 0 } = options;
  const paged: PagedSearchResult = search(query, { limit, offset });
  const results: SemanticHit[] = paged.results.map(r => toHit(r.section, r.snippet, r.matchCount));
  return {
    mode: "bm25-fallback",
    query,
    total: paged.total,
    count: results.length,
    results,
    vectorStoreAvailable: false,
    reason,
  };
}

/**
 * Semantic search with graceful degradation. `options.forceFallback` is a test
 * hook to exercise the fallback deterministically without a vector stack.
 */
export async function semanticSearch(
  query: string,
  options: { limit?: number; offset?: number; forceFallback?: boolean } = {},
): Promise<SemanticSearchResult> {
  const { limit = 20, offset = 0, forceFallback = false } = options;
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "bm25-fallback", query, total: 0, count: 0, results: [], vectorStoreAvailable: false, reason: "Empty query" };
  }

  try {
    if (forceFallback) throw new Error("forced fallback (test hook)");
    const { isOllamaRunning } = await import("../llm/ollama.js");
    const { isChromaRunning } = await import("../llm/chroma.js");
    const [ollamaOk, chromaOk] = await Promise.all([
      isOllamaRunning(2000),
      isChromaRunning(),
    ]);
    if (!ollamaOk || !chromaOk) {
      return bm25Fallback(trimmed, { limit, offset }, "Vector store unavailable (Ollama/ChromaDB not running)");
    }

    const { embed } = await import("../llm/ollama.js");
    const { query: chromaQuery } = await import("../llm/chroma.js");
    const embedding = await embed(trimmed);
    const hits = await chromaQuery(embedding, Math.max(limit, llmConfig.topK));
    if (!hits.ids.length) {
      return bm25Fallback(trimmed, { limit, offset }, "Vector store returned no results; BM25 fallback");
    }

    const all: SemanticHit[] = hits.ids.map((id, i) => {
      const meta = hits.metadatas[i] ?? {};
      return {
        guid: meta.sectionGuid ?? id,
        number: meta.sectionNumber ?? "",
        title: meta.sectionTitle ?? "",
        snippet: (hits.documents[i] ?? "").substring(0, 200),
        score: Math.max(0, Math.min(1, Math.round((1 - (hits.distances[i] ?? 1)) * 1000) / 1000)),
      };
    });
    const results = all.slice(offset, offset + limit);
    return {
      mode: "semantic",
      query: trimmed,
      total: all.length,
      count: results.length,
      results,
      vectorStoreAvailable: true,
      reason: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Semantic search degraded to BM25", { error: message });
    return bm25Fallback(trimmed, { limit, offset }, message);
  }
}

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
import { createLogger } from "../logger.js";
import { boundedSignal } from "../llm/runtime.js";

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
  totalKind?: "exact-bm25" | "bounded-candidates";
  truncated?: boolean;
  scoreSemantics?: string;
}

/** Normalize a BM25 hit (section + snippet + matchCount) into the shared shape. */
function toHit(section: { guid: string; number: string; title: string }, snippet: string, score: number): SemanticHit {
  return { guid: section.guid, number: section.number, title: section.title, snippet, score };
}

/** Deterministic BM25 fallback path — exported for direct testing. */
export async function bm25Fallback(
  query: string,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
  reason: string,
): Promise<SemanticSearchResult> {
  options.signal?.throwIfAborted();
  await initSearch();
  options.signal?.throwIfAborted();
  const { limit = 20, offset = 0 } = options;
  const paged: PagedSearchResult = search(query, { limit, offset });
  const results: SemanticHit[] = paged.results.map(r => toHit(r.section, r.snippet, Math.max(0, r.matchCount) / (1 + Math.max(0, r.matchCount))));
  return {
    mode: "bm25-fallback",
    query,
    total: paged.total,
    count: results.length,
    results,
    vectorStoreAvailable: false,
    reason,
    totalKind: "exact-bm25", truncated: false, scoreSemantics: "BM25 score/(1+score); ranking strength, not probability",
  };
}

/**
 * Semantic search with graceful degradation. `options.forceFallback` is a test
 * hook to exercise the fallback deterministically without a vector stack.
 */
export async function semanticSearch(
  query: string,
  options: { limit?: number; offset?: number; forceFallback?: boolean; signal?: AbortSignal } = {},
): Promise<SemanticSearchResult> {
  const { limit = 20, offset = 0, forceFallback = false } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new Error("Invalid search pagination");
  const signal = boundedSignal(options.signal, 15_000);
  signal.throwIfAborted();
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "bm25-fallback", query, total: 0, count: 0, results: [], vectorStoreAvailable: false, reason: "Empty query" };
  }

  try {
    if (forceFallback) throw new Error("forced fallback (test hook)");
    const { isOllamaRunning } = await import("../llm/ollama.js");
    const { isChromaRunning } = await import("../llm/chroma.js");
    const [ollamaOk, chromaOk] = await Promise.all([
      isOllamaRunning(2000, signal),
      isChromaRunning(2000, signal),
    ]);
    signal.throwIfAborted();
    if (!ollamaOk || !chromaOk) {
      return bm25Fallback(trimmed, { limit, offset, signal }, "Vector store unavailable (Ollama/ChromaDB not running)");
    }

    const { embed } = await import("../llm/ollama.js");
    const { query: chromaQuery, getStats, servingCollectionName } = await import("../llm/chroma.js");
    const collection = await servingCollectionName();
    const stats = await getStats({ signal, collection });
    const candidateLimit = Math.min(1000, stats.count);
    if (!candidateLimit) return bm25Fallback(trimmed, { limit, offset, signal }, "No vector candidates; lexical search used");
    const embedding = await embed(trimmed, { signal });
    // Read a fixed bounded candidate set so pagination does not change its universe.
    const hits = await chromaQuery(embedding, candidateLimit, { signal, collection });
    if (!hits.ids.length) {
      return bm25Fallback(trimmed, { limit, offset, signal }, "Vector store returned no results; BM25 fallback");
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
    }).filter((hit, i) => hits.metadatas[i]?.sourceType !== "youtube_transcript" && !!hit.guid && !!hit.number);
    all.sort((a, b) => b.score - a.score || a.guid.localeCompare(b.guid));
    const seen = new Set<string>();
    const unique = all.filter(hit => { if (seen.has(hit.guid)) return false; seen.add(hit.guid); return true; });
    const results = unique.slice(offset, offset + limit);
    return {
      mode: "semantic",
      query: trimmed,
      total: unique.length,
      count: results.length,
      results,
      vectorStoreAvailable: true,
      reason: null,
      totalKind: "bounded-candidates", truncated: stats.count > candidateLimit,
      scoreSemantics: "Clamped cosine similarity; ranking strength, not probability",
    };
  } catch (error) {
    signal.throwIfAborted();
    log.warn("Semantic search degraded to lexical search");
    return bm25Fallback(trimmed, { limit, offset, signal }, "Vector retrieval unavailable; lexical search used");
  }
}

/** RAG pipeline — retrieval-augmented generation for municipal code Q&A */
import type { ChatMessage, RagResponse, RagSource } from "../types.js";
import { embed } from "./ollama.js";
import { chatWithProvider, configuredChatModel, configuredChatProvider } from "./provider.js";
import { query } from "./chroma.js";
import { llmConfig } from "./config.js";
import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { computeSha256 } from "../utils.js";

// ─── Query logging ────────────────────────────────────────────────

const RAG_LOG_PATH = "output/rag-queries.jsonl";
const CHAT_HISTORY_DIR = "output/chat-history";

async function logRagQuery(
  question: string,
  answer: string,
  sources: RagSource[],
  latencyMs: number,
  model: string,
  queryId: string,
  provider: string,
): Promise<void> {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    question,
    answerSnippet: answer.substring(0, 200),
    sourceCount: sources.length,
    topSource: sources[0]?.sectionNumber ?? null,
    latencyMs,
    model,
    provider,
    queryId,
  });
  try {
    if (!existsSync("output")) await mkdir("output", { recursive: true });
    await appendFile(RAG_LOG_PATH, entry + "\n");

    // Also persist to chat history (one file per day)
    if (!existsSync(CHAT_HISTORY_DIR)) await mkdir(CHAT_HISTORY_DIR, { recursive: true });
    const today = new Date().toISOString().substring(0, 10);
    const historyEntry = JSON.stringify({
      ts: new Date().toISOString(),
      role: "user",
      content: question,
    }) + "\n" + JSON.stringify({
      ts: new Date().toISOString(),
      role: "assistant",
      content: answer,
      sources: sources.slice(0, 5).map(s => s.sectionNumber),
      model,
      latencyMs,
    }) + "\n";
    await appendFile(join(CHAT_HISTORY_DIR, `${today}.jsonl`), historyEntry);
  } catch {
    // Non-fatal — log path may not exist before first scrape
  }
}

// ─── Adaptive topK ────────────────────────────────────────────────

/** Estimate query complexity and return appropriate topK value */
function adaptiveTopK(question: string): number {
  const wordCount = question.split(/\s+/).filter(Boolean).length;
  if (wordCount <= llmConfig.shortQueryThreshold) {
    return llmConfig.adaptiveTopKMin;
  }
  return llmConfig.adaptiveTopKMax;
}

// ─── Query expansion ──────────────────────────────────────────────

/** CA municipal law synonym map for query expansion before embedding */
const QUERY_SYNONYMS: Record<string, string[]> = {
  "zoning": ["land use", "district", "overlay", "permitted use"],
  "permit": ["license", "authorization", "approval"],
  "parking": ["vehicle", "parking space", "off-street"],
  "building": ["structure", "construction", "building code"],
  "noise": ["sound", "amplified", "decibel"],
  "tsunami": ["tidal wave", "inundation", "evacuation"],
  "harbor": ["port", "marina", "waterfront"],
  "fishing": ["crab", "dungeness", "commercial fishing"],
  "business": ["commercial", "business license", "trade"],
  "housing": ["residential", "dwelling", "affordable"],
  "homeless": ["shelter", "vehicle dwelling", "transitional"],
  "evacuation": ["emergency", "tsunami", " evacuation route"],
};

/** Expand a query with synonyms for better retrieval recall */
function expandQuery(question: string): string {
  const lower = question.toLowerCase();
  const expansions: string[] = [];
  for (const [term, syns] of Object.entries(QUERY_SYNONYMS)) {
    if (lower.includes(term)) {
      expansions.push(...syns);
    }
  }
  if (expansions.length === 0) return question;
  return `${question} ${expansions.slice(0, 5).join(" ")}`;
}

// ─── RagSource construction ──────────────────────────────────────

/**
 * Build a RagSource from a retrieved chunk's document text + metadata,
 * branching on `sourceType` so a YouTube transcript chunk and a municipal
 * code chunk produce distinctly-shaped citations. This is the single
 * construction site for RagSource objects — the streaming chat endpoint
 * (`gui/routes.ts`) imports and reuses this rather than re-deriving the
 * same mapping a second time (that duplication was itself a latent bug:
 * the prior inline version there read `.guid`/`.number`/`.title`/`.text`
 * off `chromaResult.documents[i]`, which is a plain string per
 * `chroma.ts`'s own `query()` return type, not an object — every one of
 * those property reads silently evaluated to `undefined`).
 */
export function buildRagSource(doc: string, meta: Record<string, string>, distance: number): RagSource {
  const score = Math.max(0, Math.min(1, Math.round((1 - distance) * 1000) / 1000));
  const snippet = doc.substring(0, 200);

  if (meta.sourceType === "youtube_transcript") {
    return {
      sourceType: "youtube_transcript",
      sectionGuid: meta.videoId ?? "",
      sectionNumber: meta.timestamp ?? "",
      sectionTitle: meta.videoTitle ?? "",
      snippet,
      score,
      videoId: meta.videoId,
      timestamp: meta.timestamp,
    };
  }

  return {
    sourceType: "municipal_code",
    sectionGuid: meta.sectionGuid ?? "",
    sectionNumber: meta.sectionNumber ?? "",
    sectionTitle: meta.sectionTitle ?? "",
    snippet,
    score,
  };
}

// ─── Reranking (lexical-hybrid) ──────────────────────────────────────

export interface RerankCandidate {
  document: string;
  distance: number;
}

/**
 * Pure post-retrieval rerank: reorder retrieved chunks by a hybrid score of
 * lexical query-term overlap (normalized 0..1) and vector similarity
 * (1 - distance, 0..1), keeping the top `topN`. This is a real, deterministic
 * improvement over raw vector order when the query's own terms discriminate
 * between chunks (the original task's "cross-encode top-20 → top-5" needs an
 * external cross-encoder, which the local stack does not provide; this hybrid
 * is the zero-dependency equivalent and is what `rerankEnabled` turns on).
 * Returns the candidate indices in the new order.
 */
export function rerankByQueryOverlap(query: string, candidates: RerankCandidate[], topN: number): number[] {
  const terms = new Set(query.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  if (terms.size === 0 || candidates.length === 0) {
    return candidates.map((_, i) => i).slice(0, Math.max(0, Math.min(topN, candidates.length)));
  }
  const scored = candidates.map((candidate, index) => {
    const docLower = candidate.document.toLowerCase();
    let overlap = 0;
    for (const term of terms) {
      if (docLower.includes(term)) overlap += 1;
    }
    const lexical = overlap / terms.size;
    const vector = Math.max(0, Math.min(1, 1 - (candidate.distance ?? 1)));
    return { index, score: lexical * 0.5 + vector * 0.5 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, Math.min(topN, candidates.length))).map(entry => entry.index);
}

// ─── Conversation history ──────────────────────────────────────────

export const MAX_HISTORY_TURNS = 6;

/**
 * Pure message-list builder for multi-turn chat: appends the current user
 * question to a bounded, non-empty tail of prior turns. The system/context
 * message is composed by the provider layer (chatWithProvider), so only the
 * conversation turns are built here. Exported for direct unit testing.
 */
export function buildChatMessages(
  userQuestion: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): ChatMessage[] {
  const bounded = (history ?? [])
    .filter(turn => turn && typeof turn.content === "string" && turn.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS);
  return [...bounded, { role: "user", content: userQuestion }];
}

// ─── RAG pipeline ─────────────────────────────────────────────────

/** Retryable dependency error used when retrieval produced no usable evidence. */
export class NoRetrievedContextError extends Error {
  constructor() {
    super("No retrieved context is available for this question");
    this.name = "NoRetrievedContextError";
  }
}

/** Query the RAG pipeline with a user question */
export async function ragQuery(
  userQuestion: string,
  modelOverride?: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<RagResponse> {
  const start = Date.now();
  const model = configuredChatModel(modelOverride);
  const queryId = `rag-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // Adaptive topK based on query complexity
  const topK = adaptiveTopK(userQuestion);

  // Query expansion with CA municipal law synonyms
  const expandedQuery = expandQuery(userQuestion);

  // Step 1: Embed the (expanded) question
  const questionEmbedding = await embed(expandedQuery);

  // Step 2: Search ChromaDB for similar chunks with adaptive topK
  const results = await query(questionEmbedding, topK);

  // Step 2.5: optional post-retrieval rerank (RERANK_ENABLED). When off, the
  // natural retrieval order is preserved exactly.
  const reranked = llmConfig.rerankEnabled
    ? rerankByQueryOverlap(
        userQuestion,
        results.ids.map((_, i) => ({ document: results.documents[i] ?? "", distance: results.distances[i] ?? 1 })),
        llmConfig.rerankTopN,
      )
    : null;
  const order = reranked ?? results.ids.map((_, i) => i);

  // Step 3: Build context from retrieved chunks with citation deep-links
  const sources: RagSource[] = [];
  const contextParts: string[] = [];

  for (const i of order) {
    const doc = results.documents[i] ?? "";
    const meta = results.metadatas[i] ?? {};
    const distance = results.distances[i] ?? 1;
    if (!doc.trim()) continue;

    const label =
      meta.sourceType === "youtube_transcript"
        ? `[YouTube: ${meta.videoTitle} @ ${meta.timestamp}]`
        : `[${meta.sectionNumber}: ${meta.sectionTitle}]`;
    contextParts.push(`${label}\n${doc}\n`);

    sources.push(buildRagSource(doc, meta, distance));
  }

  const context = contextParts.join("\n---\n");
  const contextFingerprint = await computeSha256(context);
  const baseMetadata = {
    generatedAt: new Date().toISOString(),
    latencyMs: Date.now() - start,
    retrievalCount: sources.length,
    requestedTopK: topK,
    ...(reranked ? { reranked: true, rerankTopN: llmConfig.rerankTopN } : {}),
    contextFingerprint,
    grounded: sources.length > 0 && !!context.trim(),
    embeddingProvider: "ollama" as const,
    embeddingModel: llmConfig.embeddingModel,
    vectorStore: "chroma" as const,
    collection: llmConfig.collectionName,
  };

  if (sources.length === 0 || !context.trim()) {
    throw new NoRetrievedContextError();
  }

  // Step 4: Generate answer with context (multi-turn history appended when provided)
  const messages = buildChatMessages(userQuestion, history);

  const answer = await chatWithProvider(messages, context, model);
  const latencyMs = Date.now() - start;

  // Log the query asynchronously (non-blocking)
  void logRagQuery(userQuestion, answer, sources, latencyMs, model, queryId, configuredChatProvider());

  return {
    answer,
    sources,
    model,
    provider: configuredChatProvider(),
    queryId,
    metadata: {
      ...baseMetadata,
      generatedAt: new Date().toISOString(),
      latencyMs,
      grounded: true,
    },
  };
}

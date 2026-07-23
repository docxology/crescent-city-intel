/** RAG pipeline — retrieval-augmented generation for municipal code Q&A */
import type { ChatMessage, RagResponse, RagSource } from "../types.js";
import { embed, chat } from "./ollama.js";
import { query } from "./chroma.js";
import { llmConfig } from "./config.js";
import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// ─── Query logging ────────────────────────────────────────────────

const RAG_LOG_PATH = "output/rag-queries.jsonl";
const CHAT_HISTORY_DIR = "output/chat-history";

async function logRagQuery(
  question: string,
  answer: string,
  sources: RagSource[],
  latencyMs: number,
  model: string
): Promise<void> {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    question,
    answerSnippet: answer.substring(0, 200),
    sourceCount: sources.length,
    topSource: sources[0]?.sectionNumber ?? null,
    latencyMs,
    model,
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

// ─── Citation deep-links ──────────────────────────────────────────

/** Build ecode360 deep-link URL for a section GUID */
function buildCitationUrl(guid: string): string {
  return `https://ecode360.com/${guid}`;
}

// ─── RAG pipeline ─────────────────────────────────────────────────

/** Query the RAG pipeline with a user question */
export async function ragQuery(userQuestion: string, modelOverride?: string): Promise<RagResponse> {
  const start = Date.now();
  const model = modelOverride ?? llmConfig.chatModel;

  // Adaptive topK based on query complexity
  const topK = adaptiveTopK(userQuestion);

  // Query expansion with CA municipal law synonyms
  const expandedQuery = expandQuery(userQuestion);

  // Step 1: Embed the (expanded) question
  const questionEmbedding = await embed(expandedQuery);

  // Step 2: Search ChromaDB for similar chunks with adaptive topK
  const results = await query(questionEmbedding, topK);

  // Step 3: Build context from retrieved chunks with citation deep-links
  const sources: RagSource[] = [];
  const contextParts: string[] = [];

  for (let i = 0; i < results.ids.length; i++) {
    const doc = results.documents[i];
    const meta = results.metadatas[i];
    const distance = results.distances[i];

    contextParts.push(
      `[${meta.sectionNumber}: ${meta.sectionTitle}]\n${doc}\n`
    );

    sources.push({
      sectionGuid: meta.sectionGuid,
      sectionNumber: meta.sectionNumber,
      sectionTitle: meta.sectionTitle,
      snippet: doc.substring(0, 200),
      score: Math.round((1 - distance) * 1000) / 1000,
    });
  }

  const context = contextParts.join("\n---\n");

  // Step 4: Generate answer with context
  const messages: ChatMessage[] = [
    { role: "user", content: userQuestion },
  ];

  const answer = await chat(messages, context, model);
  const latencyMs = Date.now() - start;

  // Log the query asynchronously (non-blocking)
  void logRagQuery(userQuestion, answer, sources, latencyMs, model);

  return {
    answer,
    sources,
    model: llmConfig.chatModel,
  };
}

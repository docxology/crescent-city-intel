/** Configuration for the LLM/RAG module */

const requestedProvider = (process.env.LLM_PROVIDER ?? "ollama").toLowerCase();
const provider = requestedProvider === "openrouter" ? "openrouter" : "ollama";

if (requestedProvider && requestedProvider !== "ollama" && requestedProvider !== "openrouter") {
  console.warn(`[llm-config] Unrecognized LLM_PROVIDER "${requestedProvider}" — falling back to "ollama". Valid values: ollama, openrouter.`);
}

export const llmConfig = {
  /** LLM provider selection for chat */
  provider: provider as "ollama" | "openrouter",

  /** Ollama server base URL */
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",

  /** Embedding model name */
  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",

  /** Chat model name */
  chatModel: process.env.CHAT_MODEL ?? "gemma3:4b",

  /** OpenRouter API base URL */
  openrouterUrl: process.env.OPENROUTER_URL ?? "https://openrouter.ai/api/v1",

  /** OpenRouter chat model name — defaults to a free-tier model so an unset
   *  OPENROUTER_MODEL never silently incurs cost. */
  openrouterModel: process.env.OPENROUTER_MODEL ?? "inclusionai/ling-3.0-flash:free",

  /** Maximum OpenRouter completion tokens */
  openrouterMaxTokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? "1024"),

  /** Maximum OpenRouter requests allowed per run */
  openrouterMaxRequestsPerRun: Number(process.env.OPENROUTER_MAX_REQUESTS ?? "100"),

  /** OpenRouter HTTP timeout in milliseconds */
  openrouterTimeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS ?? "120000"),

  /** Short dependency preflight timeout used by provider health checks */
  providerPreflightTimeoutMs: Number(process.env.LLM_PREFLIGHT_TIMEOUT_MS ?? "5000"),

  /** Minimum spacing between sequential OpenRouter requests within one curation
   *  run. The free-tier default model caps at ~20 req/min account-wide; a
   *  batch of new items curated back-to-back with no spacing burns through
   *  that in seconds (confirmed live 2026-07-24: a 34-item batch got a 429
   *  "Rate limit exceeded: free-models-per-min" on nearly every item after
   *  the first). Ollama has no such external limit, so this only matters
   *  when provider=openrouter. */
  openrouterMinRequestIntervalMs: Number(process.env.OPENROUTER_MIN_REQUEST_INTERVAL_MS ?? "3100"),

  /** ChromaDB server URL */
  chromaUrl: process.env.CHROMA_URL ?? "http://localhost:8001",

  /** ChromaDB collection name */
  collectionName: "crescent-city-code",

  /** Chunk size in characters for text splitting */
  chunkSize: 1500,

  /** Overlap between chunks in characters */
  chunkOverlap: 150,

  /** Number of top results to retrieve for RAG */
  topK: 10,

  /** Minimum topK for adaptive retrieval (short/specific queries) */
  adaptiveTopKMin: 5,

  /** Maximum topK for adaptive retrieval (broad queries) */
  adaptiveTopKMax: 15,

  /** Word count threshold below which a query is considered "short/specific" */
  shortQueryThreshold: 3,
};

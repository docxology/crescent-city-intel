/** Configuration for the LLM/RAG module */

export const llmConfig = {
  /** LLM provider selection for chat */
  provider: (process.env.LLM_PROVIDER ?? "ollama") as "ollama" | "openrouter",

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

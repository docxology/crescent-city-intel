# LLM Module

## `src/llm/config.ts` — Configuration

Centralized configuration for LLM services, with environment variable overrides.

| Property | Default | Env Var | Description |
|----------|---------|---------|-------------|
| `provider` | `ollama` | `LLM_PROVIDER` | Chat provider (`ollama` or `openrouter`) |
| `ollamaUrl` | `http://localhost:11434` | `OLLAMA_URL` | Ollama embedding/chat API base URL |
| `embeddingModel` | `nomic-embed-text` | `EMBEDDING_MODEL` | Model for embeddings |
| `chatModel` | `gemma3:4b` | `CHAT_MODEL` | Model for chat/summarization |
| `openrouterUrl` | `https://openrouter.ai/api/v1` | `OPENROUTER_URL` | OpenRouter API base URL |
| `openrouterModel` | `inclusionai/ling-3.0-flash:free` | `OPENROUTER_MODEL` | OpenRouter chat model |
| `providerPreflightTimeoutMs` | `5000` | `LLM_PREFLIGHT_TIMEOUT_MS` | Bounded provider health check |
| `chromaUrl` | `http://localhost:8001` | `CHROMA_URL` | ChromaDB server URL |
| `collectionName` | `crescent-city-code` | — | ChromaDB collection name |
| `chunkSize` | `1500` | — | Characters per text chunk |
| `chunkOverlap` | `150` | — | Overlap between chunks |
| `topK` | `10` | — | Top results for RAG retrieval |

---

## `src/llm/ollama.ts` — Ollama API Wrapper

| Function | Signature | Description |
|----------|-----------|-------------|
| `embed` | `(text) → Promise<number[]>` | Generate embedding for single text via `/api/embed` |
| `embedBatch` | `(texts) → Promise<number[][]>` | Batch embedding via `/api/embed` with multiple inputs |
| `chat` | `(messages, context?) → Promise<string>` | Chat completion via `/api/chat` (non-streaming). Injects system prompt with optional context. |
| `listModels` | `() → Promise<string[]>` | List available models via `/api/tags` |
| `isOllamaRunning` | `(timeoutMs?) → Promise<boolean>` | Bounded health check via `/api/tags` |

---

## Provider behavior

Ollama is the default local chat provider. Setting `LLM_PROVIDER=openrouter`
routes chat, section summarization, and curation through OpenRouter while
Ollama remains required for embeddings. The GUI and CLI report the selected
provider/model separately from the embedding dependency. The OpenRouter
preflight checks the non-generative `/models` endpoint without consuming a chat
completion; an unset key or unreachable endpoint is an explicit unavailable
state, not a silent fallback.

## `src/llm/chroma.ts` — ChromaDB Client

| Function | Signature | Description |
|----------|-----------|-------------|
| `getOrCreateCollection` | `() → Promise<Collection>` | Returns singleton collection (cosine similarity). |
| `addDocuments` | `(docs) → Promise<void>` | Upsert documents with embeddings and metadata. |
| `query` | `(embedding, topK?) → Promise<{ids, documents, metadatas, distances}>` | Query by embedding vector. |
| `getStats` | `() → Promise<{count, name}>` | Collection document count and name. |
| `isChromaRunning` | `() → Promise<boolean>` | Health check via heartbeat. |

---

## `src/llm/embeddings.ts` — Indexing Pipeline

| Function | Signature | Description |
|----------|-----------|-------------|
| `isIndexed` | `() → Promise<boolean>` | Check if collection has documents. |
| `indexAllSections` | `() → Promise<void>` | Load all sections, fingerprint content, remove stale chunks, embed, and store in ChromaDB. |

### Chunking Strategy

- Chunk size: 1500 characters
- Overlap: 150 characters
- Each chunk prefixed with `{sectionNumber}: {sectionTitle}`
- Metadata includes: `sectionGuid`, `sectionNumber`, `sectionTitle`, `articleGuid`, `articleTitle`, `chunkIndex`
- Batch size: 32 chunks per embedding request, with single-chunk fallback on failure

---

## `src/llm/rag.ts` — RAG Pipeline

| Function | Signature | Description |
|----------|-----------|-------------|
| `ragQuery` | `(userQuestion) → Promise<RagResponse>` | Full RAG pipeline: embed → retrieve → generate. |

### Pipeline Steps

1. **Embed** question via `embed()`
2. **Retrieve** top-K similar chunks from ChromaDB via `query()`
3. **Build context** from retrieved documents with section citations
4. **Generate** answer via the configured provider with injected context
5. **Return** answer + sources (with similarity scores) plus provider/model,
   query ID, context fingerprint, latency, retrieval count, embedding model,
   Chroma collection, and a `grounded` flag. Empty or malformed retrieval
   raises a retryable `NoRetrievedContextError`; it is never returned as a
   successful answer.

Streaming responses emit the same lineage at the final `done` event and accept
cancellation through the request signal. The local GUI exposes a Cancel
control, so a user can stop a slow Ollama/OpenRouter request without leaving
the interface in a false “thinking” state.

### Curation evidence contract

Each curated item includes an `inputFingerprint` (SHA-256 of the stable source
ID, title, source text, provider, model, and prompt version), `promptVersion`,
source `citations`, provider and model metadata, `summaryStatus`, `retryable`,
and bounded source provenance. Curation uses a dedicated source-grounded
editor prompt, a bounded excerpt/output contract, and an abortable
`CURATION_SUMMARY_TIMEOUT_MS`; it never silently treats a source-only fallback
as a completed LLM summary. Triplicate is excluded before this pipeline begins
and cannot become a curation or embedding input through the public snapshot path.

---

## `src/llm/index.ts` — CLI Entry Point

| Command | Description |
|---------|-------------|
| `bun run index` | Index all sections into ChromaDB |
| `bun run chat` | Interactive REPL chat |
| `bun run query "..."` | Single RAG query |
| `bun run status` | Show Ollama/ChromaDB status and stats |

### RAG additions

- **Rerank** (`RERANK_ENABLED=true`): `rerankByQueryOverlap` reorders the post-retrieval
  chunks by a lexical-hybrid score (query-term overlap ⊕ vector similarity), keeping
  `RERANK_TOP_N`. Off by default so retrieval order is unchanged.
- **Conversation history**: `chatWithProvider`/`streamChat` accept prior turns via
  `buildChatMessages` (last 6), enabling multi-turn context on POST `/api/chat` and
  `/api/chat/stream`.

---

## `src/llm/provider.ts` — Automatic fallback chain

`chatWithProviderFallback(messages, context?, modelOverride?, options?)` never
returns without an answer:

1. **Primary provider** (per `LLM_PROVIDER`) — preflighted via the non-generative
   health check first so a dead endpoint costs no generation timeout.
2. **Secondary provider** — when the primary is openrouter and it is unconfigured
   or unreachable, Ollama is attempted next.
3. **Deterministic extract** — when every provider is down, `deterministicExtract`
   returns a clearly labeled extract built ONLY from the supplied retrieved
   context (or an explicit "unable to answer" note when no context exists). It
   never fabricates content.

The result object carries `outcome` (`primary` | `secondary` | `deterministic`),
`providerUsed`, `model`, and any preflight/error strings for observability.

## `src/llm/structured.ts` — Structured output

```bash
# From TypeScript:
# const { value, source } = await queryStructured<T>(prompt, {
#   schemaHint: '{"section": string, "topic": string}',
# }, isMyType);
```

`queryStructured<T>(prompt, options, validate?)` requests strict JSON, extracts
the outermost JSON object/array (tolerating prose and markdown fences), parses
it, optionally type-guards with `validate`, retries once on malformed output
with a repair prompt, and returns `{ value: null }` otherwise so callers can
fall back deterministically. Usage example: see
`tests/llm-live-integration.test.ts`.

## `src/llm/usage.ts` — Token-usage accounting

Every `chat()` call in `ollama.ts` / `openrouter.ts` records provider, model,
prompt/completion tokens (`prompt_eval_count`/`eval_count` or OpenRouter
`usage`; character-estimated with an `estimated` flag when a provider omits
counts) into a bounded in-memory window (5000 requests). The GUI server exposes:

```bash
curl -s http://localhost:8080/api/llm/usage | jq .
```

Response shape: `{ schemaVersion, generatedAt, totals: {requests,
promptTokens, completionTokens, totalTokens}, providers: [...], lastRecordAt }`.
Counters reset on process restart; batch scripts keep their own window per run.

## Verification commands

```bash
bun test tests/llm-usage-and-fallback.test.ts   # deterministic accounting/parse/fallback tests
bun test tests/llm-live-integration.test.ts     # live Ollama integration (skips if Ollama down)
bun run index                                   # refresh RAG index (fingerprint-gated)
bun run query "tsunami hazard zone regulations" # end-to-end semantic search check
ollama pull nomic-embed-text && ollama pull gemma3:4b && ollama pull qwen2.5:3b  # models used locally
```

RAG verification on this checkout (2026-08-27): index fingerprint unchanged at
3105 stored chunks over 2206 sections; semantic search for tsunami/flood topics
returned § 17.84G.050 and related coastal/flood sections as top hits with
scores ≥ 0.69.

# Agents Guide — `src/llm/`

## Overview

RAG (Retrieval-Augmented Generation) pipeline using Ollama for embeddings,
Ollama or OpenRouter for chat, and ChromaDB for vector storage. Includes SSE
streaming and explicit provider/freshness diagnostics.

## Files

| File | Purpose | Tests |
|---|---|---|
| `config.ts` | Centralized LLM/RAG configuration constants | `tests/llm-config.test.ts` |
| `ollama.ts` | Ollama API wrapper (embeddings, local chat, models, bounded health check) | Manual only (requires Ollama) |
| `openrouter.ts` | OpenRouter chat, native SSE, rate cap, and non-generative preflight | `tests/llm-openrouter.test.ts` |
| `provider.ts` | Explicit selected chat-provider routing and model/preflight metadata | `tests/llm-provider.test.ts`, `tests/llm-openrouter.test.ts` |
| `chroma.ts` | ChromaDB client wrapper (add, query, stats) | Manual only (requires ChromaDB) |
| `embeddings.ts` | Chunking pipeline + bulk indexing into ChromaDB | `tests/embeddings.test.ts` |
| `rag.ts` | RAG pipeline: Ollama embedding → query ChromaDB → configured-provider chat | Manual only |
| `streaming_rag.ts` | Provider-native SSE streaming RAG with citations and cancellation | Manual only |
| `index.ts` | CLI entry point: `index`, `chat`, `query`, `status` commands | Manual only |

## Prerequisites

- **Ollama** running at `localhost:11434` with models `nomic-embed-text` and `gemma3:4b`
- **ChromaDB** running at `localhost:8001` locally (Docker uses internal port 8000)

## Key Patterns

- `llmConfig` object centralizes all tunable parameters (URLs, model names, chunk size, overlap, topK).
- `indexAllSections()` uses a content fingerprint and removes stale chunks before skipping an unchanged index.
- `ragQuery()` returns both the answer text and source documents with relevance scores, plus query ID, context fingerprint, grounding flag, and provider/model lineage.
- `checkChatProvider()` verifies the selected chat provider; OpenRouter uses a
  bounded `/models` preflight without consuming a chat completion, while Ollama
  uses a bounded `/api/tags` check.
- `createStreamingRagResponse()` returns a `Response` with `text/event-stream` content type.

## v2.0 New Module: `streaming_rag.ts`

Server-Sent Events for provider-native RAG answer streaming.

### Event Structure
1. `event: sources` — JSON array of source sections
2. `event: token` — each token of the generated answer
3. `event: done` — final metadata (answer, sources, model, latencyMs)
4. `event: error` — on failure

### API Endpoint

`POST /api/chat/stream` — accepts `{q: "question"}` body, returns SSE stream

### Usage

```bash
# Start Ollama + ChromaDB first
curl -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"q": "What are the tsunami evacuation requirements?"}'
```

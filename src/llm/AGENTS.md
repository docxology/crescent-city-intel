# Agents Guide — `src/llm/`

## Overview

RAG (Retrieval-Augmented Generation) pipeline using Ollama for
embeddings/chat and ChromaDB for vector storage. Includes SSE streaming
for real-time answer generation.

## Files

| File | Purpose | Tests |
|---|---|---|
| `config.ts` | Centralized LLM/RAG configuration constants | `tests/llm-config.test.ts` |
| `ollama.ts` | Ollama API wrapper (embed, chat, list models, health check) | Manual only (requires Ollama) |
| `chroma.ts` | ChromaDB client wrapper (add, query, stats) | Manual only (requires ChromaDB) |
| `embeddings.ts` | Chunking pipeline + bulk indexing into ChromaDB | `tests/embeddings.test.ts` |
| `rag.ts` | RAG pipeline: embed question → query ChromaDB → Ollama chat | Manual only |
| `streaming_rag.ts` | SSE streaming RAG: word-by-word answer via Server-Sent Events | Manual only |
| `index.ts` | CLI entry point: `index`, `chat`, `query`, `status` commands | Manual only |

## Prerequisites

- **Ollama** running at `localhost:11434` with models `nomic-embed-text` and `gemma3:4b`
- **ChromaDB** running at `localhost:8000`

## Key Patterns

- `llmConfig` object centralizes all tunable parameters (URLs, model names, chunk size, overlap, topK).
- `indexAllSections()` skips re-indexing if the collection already contains documents.
- `ragQuery()` returns both the answer text and source documents with relevance scores.
- `createStreamingRagResponse()` returns a `Response` with `text/event-stream` content type.

## v2.0 New Module: `streaming_rag.ts`

Server-Sent Events for word-by-word RAG answer streaming.

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

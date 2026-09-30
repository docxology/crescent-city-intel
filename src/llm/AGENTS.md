# Agents Guide — `src/llm/`

## Overview

RAG (Retrieval-Augmented Generation) pipeline using Ollama for embeddings,
Ollama or OpenRouter for chat, and ChromaDB for vector storage. Includes SSE
streaming and explicit provider/freshness diagnostics.

## Files

| File | Purpose | Tests |
|---|---|---|
| `config.ts` | Centralized LLM/RAG configuration constants | `tests/llm-config.test.ts` |
| `ollama.ts` | Ollama API wrapper (embeddings, local chat, models, bounded health check) | `tests/llm-reliability.test.ts`, `tests/llm-native.acceptance.ts` |
| `openrouter.ts` | OpenRouter chat, native SSE, rate cap, and non-generative preflight | `tests/llm-openrouter.test.ts` |
| `provider.ts` | Explicit selected chat-provider routing and model/preflight metadata | `tests/llm-provider.test.ts`, `tests/llm-openrouter.test.ts` |
| `chroma.ts` | Deadline-bound ChromaDB requests and receipt-selected serving collections | `tests/llm-reliability.test.ts`, `tests/llm-native.acceptance.ts` |
| `embeddings.ts` | Chunking pipeline + per-article incremental indexing into ChromaDB | `tests/embeddings.test.ts`, `tests/index-plan.test.ts`, `tests/index-plan-corpus.test.ts` |
| `index_plan.ts` | Pure per-article index planner: what to re-embed, what to delete, and when a full re-embed is mandatory | `tests/index-plan.test.ts`, `tests/index-plan-corpus.test.ts` |
| `rag.ts` | RAG pipeline and explicit citation-identity assessment | `tests/llm-reliability.test.ts`, `tests/llm-boundaries.test.ts` |
| `streaming_rag.ts` | Provider-native SSE streaming RAG with citations and cancellation | `tests/llm-boundaries.test.ts` |
| `index.ts` | CLI entry point: `index`, `chat`, `query`, `status` commands | Manual only |
| `runtime.ts` | Model/vector admission, finite signals, byte caps, and streamed lines | `tests/llm-reliability.test.ts`, `tests/llm-boundaries.test.ts` |
| `privacy.ts` | Opt-in allowlisted content-free private receipts and deletion | `tests/llm-reliability.test.ts` |
| `evidence.ts` | Citation identity and unverified/abstained outcomes | `tests/llm-reliability.test.ts`, `tests/rag-benchmark.test.ts` |
| `benchmark.ts` | Bounded versioned evaluation with corpus/index/model identities | `tests/rag-benchmark.test.ts` |
| `validate.ts` | Literal quote diagnostics; semantic support and source independence unassessed | `tests/llm-validate.test.ts` |

## Prerequisites

- **Ollama** running at `localhost:11434` with models `nomic-embed-text` and `gemma3:4b`
- **ChromaDB** running at `localhost:8001` locally (Docker uses internal port 8000)

## Key Patterns

- `llmConfig` object centralizes all tunable parameters (URLs, model names, chunk size, overlap, topK).
- **Incremental indexing is per ARTICLE, not per corpus.** `index_plan.ts` holds
  the decision logic and is pure — no filesystem, no network, no vector store —
  so it is testable with fixtures. `indexAllSections()` delegates to it.
  - The unit of work is the article because a re-scrape rewrites an article's
    sections as a group, and chunk ids are already namespaced per section.
  - A single-article edit re-embeds that article's chunks. Corpus measurements
    are derived by `tests/index-plan-corpus.test.ts`, not fixed in this guide.
  - `configSignature` covers the embedding model and the chunking parameters.
    **A model swap is a correctness matter, not a performance one:** a
    per-article fingerprint only records that the *text* is unchanged, so
    without the signature a model change would be a silent no-op and the
    collection would hold two models' geometry in one cosine space.
  - A schema-1 manifest (the pre-per-article format) is honoured as a full
    re-embed, and its chunk ids are not trusted for deletion.
  - Reconcile actual stored IDs even when content fingerprints match. Build a
    separate collection, verify the complete expected ID set, and recheck the
    source manifest before atomically activating the serving receipt. A failed
    run retains the prior serving edition.
- `ragQuery()` returns source records and generation lineage with `grounded:
  false`. Citation identity is checked; generated answers remain unverified or
  abstain. Quote matches do not establish semantic support or source independence.
- Request diagnostics are disabled by default. `CC_QUERY_LOGGING=metadata`
  enables bounded content-free private receipts, with explicit retention and
  deletion. Private data never enters public Pages projections.
- `checkChatProvider()` verifies the selected chat provider; OpenRouter uses a
  bounded `/models` preflight without consuming a chat completion, while Ollama
  uses a bounded `/api/tags` check.
- `createStreamingRagResponse()` returns a `Response` with `text/event-stream` content type.

## `streaming_rag.ts`

Server-Sent Events for provider-native RAG answer streaming.

### Event Structure
1. `event: sources` — JSON array of source sections
2. `event: token` — each token of the generated answer
3. `event: done` — final metadata (answer, sources, model, latencyMs, evidence)
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

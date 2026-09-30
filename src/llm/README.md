# LLM / RAG Pipeline — `src/llm/`

Ollama-powered embeddings, configurable Ollama/OpenRouter chat, ChromaDB vector store, and RAG chat for the Crescent City municipal code.

## Prerequisites

```bash
# Start Ollama
ollama serve &
ollama pull nomic-embed-text
ollama pull gemma3:4b

# Start ChromaDB
chroma run --path chroma_data --port 8001 &
```

## Modules

| File | Purpose |
| :--- | :--- |
| `config.ts` | All tunable parameters (URLs, models, chunk size, topK) |
| `ollama.ts` | Ollama REST wrapper: `embed()`, `chat()`, `listModels()` |
| `chroma.ts` | ChromaDB client: `getOrCreateCollection()`, `addDocuments()`, `query()` |
| `embeddings.ts` | Chunking and per-article incremental `indexAllSections()` into ChromaDB |
| `index_plan.ts` | Pure planner for changed-article embeddings, obsolete chunk deletion, and configuration changes |
| `rag.ts` | Full RAG pipeline: embed question → retrieve top-K → `ragQuery()` |
| `streaming_rag.ts` | SSE tokens, cancellation, and final citation/evidence receipt |
| `runtime.ts` | Bounded admission, deadlines, response bytes, and streamed lines |
| `privacy.ts` | Opt-in content-free diagnostics and explicit deletion |
| `evidence.ts` | Citation-identity checks with unverified/abstained outcomes |
| `benchmark.ts` | Versioned retrieval and citation/abstention diagnostics with input identities |
| `validate.ts` | Literal quote-presence diagnostics; claim support remains unassessed |
| `index.ts` | CLI entry: `index`, `chat`, `query`, `status` commands |

## RAG Flow

```text
input question
    → nomic-embed-text (embed)
    → ChromaDB (top-K nearest chunks)
    → configured chat provider/model (generate answer with cited sources)
    → citation-identity check
    → { answer, sources[], provider, model, evidence, metadata }
```

## Commands

```bash
bun run index        # embed changed articles; skip unchanged work
bun run chat         # interactive RAG conversation
bun run query "..."  # single-shot RAG query
bun run status       # show ChromaDB collection stats + Ollama models
```

The first index embeds the corpus. Later runs use article fingerprints and the
`index_plan.ts` planner to re-embed changed articles and remove obsolete chunks.
Actual stored IDs are reconciled with the desired chunks. An embedding-model or
chunking-configuration change requires a full re-embed. The writer builds a
separate complete collection, checks its expected IDs and source manifest, and
atomically activates the serving receipt; failure retains the prior edition.

## Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `CHAT_MODEL` | `gemma3:4b` | Chat model |
| `LLM_PROVIDER` | `ollama` | Chat provider (`ollama` or `openrouter`) |
| `OPENROUTER_API_KEY` | unset | Required when using OpenRouter |
| `OPENROUTER_MODEL` | `inclusionai/ling-3.0-flash:free` | OpenRouter chat model |
| `CHROMA_URL` | `http://localhost:8001` | ChromaDB server |

Embeddings remain an explicit Ollama dependency even when `LLM_PROVIDER=openrouter`.
OpenRouter is used for chat, summarization, curation, and native SSE streaming only;
there is no implicit hosted embedding fallback. Provider failures return a clear
unavailable/degraded state, and RAG refuses to return a successful answer without
valid retrieved context.

Generated answers carry `grounded: false`: recognized citations identify
retrieved records, while semantic support and legal currency remain unassessed.
Missing or invalid citations produce an explicit abstention. Questions, answers,
and history are not persisted; `CC_QUERY_LOGGING=metadata` opts into bounded
content-free private diagnostics. `bun run rag:benchmark` records bounded
retrieval/citation diagnostics, and `bun run test:llm-native` requires real
Ollama/Chroma services for a separate backend acceptance run.

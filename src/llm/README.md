# LLM / RAG Pipeline — `src/llm/`

Ollama-powered embeddings, configurable Ollama/OpenRouter chat, ChromaDB vector store, and RAG chat for the Crescent City municipal code.

## Prerequisites

```bash
# Start Ollama
ollama serve &
ollama pull nomic-embed-text
ollama pull gemma3:4b

# Start ChromaDB
chroma run --path chroma_data &
```

## Modules

| File | Purpose |
| :--- | :--- |
| `config.ts` | All tunable parameters (URLs, models, chunk size, topK) |
| `ollama.ts` | Ollama REST wrapper: `embed()`, `chat()`, `listModels()` |
| `chroma.ts` | ChromaDB client: `getOrCreateCollection()`, `addDocuments()`, `query()` |
| `embeddings.ts` | Chunking pipeline + bulk `indexAllSections()` into ChromaDB |
| `rag.ts` | Full RAG pipeline: embed question → retrieve top-K → `ragQuery()` |
| `index.ts` | CLI entry: `index`, `chat`, `query`, `status` commands |

## RAG Flow

```text
input question
    → nomic-embed-text (embed)
    → ChromaDB (top-K nearest chunks)
    → configured chat provider/model (generate answer with cited sources)
    → { answer, sources[], provider, model }
```

## Commands

```bash
bun run index        # chunk + embed all sections into ChromaDB
bun run chat         # interactive RAG conversation
bun run query "..."  # single-shot RAG query
bun run status       # show ChromaDB collection stats + Ollama models
```

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

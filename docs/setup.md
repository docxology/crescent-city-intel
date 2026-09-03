# Start Here — The Quadruplicate

Complete setup guide to get the scraper, web viewer, RAG chat, and 14 alert monitors running.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | v1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Ollama](https://ollama.ai) | Latest | `brew install ollama` or [download](https://ollama.ai/download) |
| [ChromaDB](https://www.trychroma.com) | Latest | `pip install chromadb` |
| Python 3 | 3.9+ | Required for ChromaDB |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Recent (updated within ~90 days) | `pip install -U yt-dlp` |

> **Note**: Ollama + ChromaDB are only needed for LLM/RAG features. `yt-dlp` is only
> needed for `bun run youtube`. The scraper, web viewer, and all alert monitors
> work without any of them.
> For air quality alerts, set `AIRNOW_API_KEY` env var (free at [airnowapi.org](https://airnowapi.org)).
> For OpenRouter (optional, paid, alternative to local Ollama for chat/curation),
> set `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY` — see Environment Variables below.

---

## Step 1: Install Dependencies

```bash
cd crescent-city-intel
bun install
```

This installs Playwright (browser automation) and ChromaDB client.

---

## Step 2: Scrape the Municipal Code

```bash
bun run scrape
```

This launches a visible Chromium browser, bypasses Cloudflare Turnstile, and downloads the current article/section manifest from [ecode360.com/CR4919](https://ecode360.com/CR4919). Takes ~10–15 minutes.

**Resume support**: If interrupted, run `bun run scrape` again — it picks up where it left off.
The default run refreshes the live TOC. If ecode360 is temporarily unavailable,
the last validated TOC may be used as a fallback; for a deliberate offline
resume, run `bun run scrape -- --cached-toc`. Only complete, hash-matching
article artifacts are skipped.

Output: `output/articles/*.json` + `output/toc.json` + `output/manifest.json`

---

## Step 3: Verify Integrity

```bash
bun run verify
```

Re-computes SHA-256 hashes and cross-references every section against the official TOC. It also re-fetches the configured verification sample from the live site to confirm data freshness.

Output: `output/verification-report.json`

---

## Step 4: Export

```bash
bun run export
```

Generates four formats:

| Format | Output |
|--------|--------|
| JSON | `output/crescent-city-code.json` |
| Markdown | `output/markdown/` (organized by Title) |
| Text | `output/crescent-city-code.txt` |
| CSV | `output/section-index.csv` |

### Optional: build the public Pages snapshot

```bash
bun run pages:seed
bun run pages:export -- --source output --seed pages-data --output .pages
bun run pages:validate -- .pages
```

This produces a static, bounded dashboard. It does not expose the local GUI
API, credentials, logs, Chroma index, or Triplicate article content.

---

## Step 5: Launch Web Viewer

```bash
bun run gui
```

Open **<http://localhost:3000>** in your browser. Features:

- 📋 Collapsible TOC tree navigation
- 📖 Formatted section viewer
- 🔍 Instant full-text search
- 🌗 Dark / Light mode
- 📊 Analytics dashboard (bar charts, PCA scatter plot, word loadings)
- ✨ Per-section AI summaries (uses Ollama by default or OpenRouter when selected)
- 💬 RAG chat with source citations (requires Ollama + ChromaDB)

---

## Step 6: Set Up LLM / RAG Chat (Optional)

### 6a. Start Ollama

```bash
# In a separate terminal:
ollama serve

# Pull required models:
ollama pull nomic-embed-text
ollama pull gemma3:4b
```

### 6b. Start ChromaDB

```bash
# In another terminal:
chroma run --path chroma_data
```

### 6c. Index Sections

```bash
bun run index
```

Chunks all sections, generates embeddings via Ollama, and stores them in ChromaDB.

### 6d. Use RAG Chat

```bash
# Interactive mode:
bun run chat

# Single query:
bun run query "What are the zoning regulations for residential areas?"

# Check status:
bun run status
```

The web viewer's chat panel (💬 button) also connects to the RAG pipeline once services are running.

---

## Quick Reference

| Command | What It Does |
|---------|-------------|
| `bun install` | Install dependencies |
| `bun run scrape` | Scrape municipal code (resumable) |
| `bun run verify` | Verify data integrity |
| `bun run export` | Export JSON, Markdown, TXT, CSV |
| `bun run all` | Run scrape → verify → export |
| `bun run gui` | Web viewer on <http://localhost:3000> |
| `bun run index` | Index sections into ChromaDB |
| `bun run chat` | Interactive RAG chat |
| `bun run query "..."` | Single RAG query |
| `bun run status` | Check Ollama/ChromaDB/index status |
| `bun test` | Run the deterministic test suite |
| `bun run validate` | Strict TypeScript, tests, contract, and generated-output gate |
| `bun run monitor` | Detect municipal code changes |
| `bun run news` | Fetch current North Coast news/civic sources with API, RSS, and bounded HTML fallbacks |
| `bun run youtube` | Pull YouTube meeting transcripts (requires `yt-dlp` on PATH) |
| `bun run curate` | LLM-summarize + domain-tag new items across news/meetings/YouTube |

---

## Environment Variables

All optional — defaults work out of the box.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `ollama` | Chat provider selection (`ollama` or `openrouter`) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API server |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `CHAT_MODEL` | `gemma3:4b` | Chat model |
| `OPENROUTER_API_KEY` | `(unset)` | Required only when `LLM_PROVIDER=openrouter` |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base URL |
| `OPENROUTER_MODEL` | `inclusionai/ling-3.0-flash:free` | OpenRouter chat model |
| `OPENROUTER_MAX_TOKENS` | `1024` | Maximum tokens per OpenRouter completion |
| `OPENROUTER_MAX_REQUESTS` | `100` | Max OpenRouter chat requests allowed per run |
| `OPENROUTER_MIN_REQUEST_INTERVAL_MS` | `3100` | Minimum spacing between OpenRouter requests |
| `OPENROUTER_TIMEOUT_MS` | `120000` | OpenRouter request timeout |
| `LLM_PREFLIGHT_TIMEOUT_MS` | `5000` | Bounded selected-provider health-check timeout |
| `CURATION_SUMMARY_TIMEOUT_MS` | `15000` | Maximum time for one curation summary before source-only fallback |
| `SOURCE_FRESHNESS_WINDOW_MS` | `86400000` | Maximum age before a fetched source is marked stale |
| `CHROMA_URL` | `http://localhost:8001` | ChromaDB server |
| `PORT` | `3000` | GUI server port |
| `LOG_LEVEL` | `info` | Logger verbosity (debug/info/warn/error) |

---

## Troubleshooting

**Scraper gets stuck on Cloudflare**: The browser window should show a brief "Just a moment..." page then resolve. If it hangs, close the browser and re-run — the manifest and atomic artifacts ensure safe resume. If the live TOC endpoint is unavailable, use `bun run scrape -- --cached-toc` only when the cached TOC is known to be current; follow with `bun run verify` when live access returns.

**ChromaDB won't start**: Make sure Python 3.9+ is installed and `pip install chromadb` completed. Run `chroma run --path chroma_data` from the project root.

**Ollama models not found**: Run `ollama list` to check installed models. If missing, `ollama pull nomic-embed-text && ollama pull gemma3:4b`.

**Tests fail**: Run `bun install` first. Tests require scraped data in `output/` for data-dependent test files (`shared-data.test.ts`, `search.test.ts`).

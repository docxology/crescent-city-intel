# Start Here — The Quadruplicate

Complete setup guide to get the scraper, web viewer, RAG chat, and 20 alert monitors running.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Bun](https://bun.sh) | 1.4.2 (CI pin) | `curl -fsSL https://bun.sh/install \| bash` |
| [Docker](https://docs.docker.com/get-docker/) + Compose | Optional container services | GUI image builds from the locked Bun dependencies |
| [Ollama](https://github.com/ollama/ollama/releases/tag/v0.34.2) | Compose pin 0.34.2 | Local installation or the optional `llm` Compose profile |
| [ChromaDB](https://github.com/chroma-core/chroma/releases/tag/1.5.9) | Container pin 1.5.9 | `chromadb/chroma:1.5.9`; published locally on port 8001 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) | Optional external executable | Follow upstream installation instructions for transcript collection |

> **Note**: Ollama + ChromaDB are only needed for LLM/RAG features. `yt-dlp` is only
> needed for `bun run youtube`. The scraper, web viewer, and all alert monitors
> work without any of them.
> Air quality uses public AirNow observations by default; `AIRNOW_API_KEY` enables the optional keyed API.
> For OpenRouter (optional, paid, alternative to local Ollama for chat/curation),
> set `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY` — see Environment Variables below.

Project logic and tests run in Bun/TypeScript. Optional ChromaDB and yt-dlp are
external tools; a thin Python adapter delegates to Bun when the shared manuscript
renderer is used. See [the manuscript workflow](manuscript.md) for that integration.

---

## Step 1: Install Dependencies

```bash
cd crescent-city-intel
bun install --frozen-lockfile
bunx playwright install chromium
bun run source-discovery
```

The dependency install adds the Playwright library and ChromaDB client. Chromium
is a separate installation required by the scraper and exported-page render tests;
on Linux use `bunx playwright install --with-deps chromium` when system libraries
are needed. Source discovery writes a deterministic registry and joins stored health.
The gate validates those artifacts when present; repeat discovery after changing
the source registry. Absent generated evidence is reported explicitly.

Run `bun run validate` to check the checkout before collecting live data. The
deterministic suite supports both empty and populated `output/` trees.

---

## Step 2: Scrape the Municipal Code

```bash
bun run scrape
```

This launches a visible Chromium browser, bypasses Cloudflare Turnstile, and downloads the current article/section manifest from [ecode360.com/CR4919](https://ecode360.com/CR4919). Its duration depends on source latency, deep articles, and challenge retries; use a finite job budget for unattended collection.

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

Re-computes SHA-256 hashes and cross-references every section against the official TOC. It separately records local custody, current live TOC, and bounded live sample planes. Fresh publication requires all required planes to pass; offline verification records local consistency and remains ineligible for current-source publication.

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
# In another terminal (optional Docker service):
docker run --rm --name cci-chroma -p 127.0.0.1:8001:8000 -v cci-chroma:/data chromadb/chroma:1.5.9
```

Check the real service and model prerequisites before indexing:

```bash
bun run scripts/stack-readiness.ts
```

The bounded readiness receipt distinguishes an HTTP service from installed
embedding/chat models. `CHAT_MODEL` is the shared runtime and Compose override.

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
| `bun install --frozen-lockfile` | Install locked dependencies |
| `bunx playwright install chromium` | Install the browser used by scraping and render tests |
| `bun run source-discovery` | Refresh the deterministic registry and stored health joins |
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
| `bun run validate` | Source + test strict types, fenced plain/coverage suites, contracts and generated-output gate |
| `bun run test:typecheck` | Separate strict TypeScript check including the tests |
| `bun run test:gui-journeys` | Real local Chromium interaction and security journeys |
| `bun run test:llm-native` | Optional real Ollama/Chroma acceptance |
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

**ChromaDB won't start**: Check the pinned container and port mapping, matching the
default `CHROMA_URL=http://localhost:8001`.

**Ollama models not found**: Run `ollama list` to check installed models. If missing, `ollama pull nomic-embed-text && ollama pull gemma3:4b`.

**Tests fail**: Install locked dependencies and Chromium, then run
`bun run source-discovery` if generated registry evidence is stale, then
`bun run validate`. Tests use offline fixtures
and support an empty `output/`; a live scrape and optional LLM services are not
required for the deterministic suite.


## Container and scheduling boundaries

`docker compose up --build gui` starts the GUI with a real HTTP healthcheck. The
optional backend profile uses pinned Chroma/Ollama images, persisted volumes,
model bootstrap, and a separate readiness service:

```bash
docker compose --profile llm up --build -d ollama chroma ollama-models
docker compose --profile llm run --rm readiness
```

The GUI can serve deterministic data while optional models are unavailable.
A successful image build does not establish model readiness, source acceptance,
or deployment; record each receipt separately. Model names and installed model
bytes remain an external prerequisite even with pinned service images.

`bun run cron-setup -- --dry-run` prints the host's launchd or cron plan. It
installs nothing. The plan uses explicit argument arrays/XML escaping on macOS,
POSIX quoting plus percent escaping for cron, and Sunday 07:00 Pacific scheduling.
Confirm the macOS host timezone and review the generated paths before any manual
installation. Scheduled source runs require finite execution budgets and explicit
unavailable/stale records.

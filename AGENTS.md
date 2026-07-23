# AGENTS.md — Crescent City Intelligence Platform

## Project Overview

The most comprehensive local intelligence platform for Crescent City, CA.
Built with TypeScript/Bun. Scrapes, verifies, exports, views, queries, and
analyzes the Crescent City municipal code from ecode360.com, plus monitors
8 real-time alert streams (tsunami, earthquake, weather, tides, fishing, air
quality, wildfire, marine) and provides RAG chat with streaming SSE.

## Architecture

```
ecode360.com/CR4919
        |
    [Scraper] --- Playwright + Cloudflare bypass
        |
   output/articles/*.json (242 articles, 2194 sections)
        |
   [Verifier] --- SHA-256 + TOC cross-reference + live re-fetch
        |
   [Exporter] --- JSON, Markdown, plain text, CSV
        |
   +----+----+----+----+
   |         |        |
 [GUI]    [LLM]   [Structured Queries]
 Bun.serve  Ollama   History/Compare/Similar
 port 3000  + Chroma  Citations/Glossary
 RAG+SSE    RAG       Cross-refs
        |
 [Intelligence Layer — 8 monitors]
   NOAA Tsunami · USGS Earthquake · NWS Weather · NOAA Tides
   CDFW Fishing · EPA AirNow · CAL FIRE Wildfire · NDBC Marine
        |
 [Alert Analytics — unified timeline + per-type stats]
```

## Directory Structure

```
src/
  types.ts              # All TypeScript interfaces
  constants.ts          # Centralized constants (env-overridable)
  utils.ts              # Shared utilities (SHA-256, flatten, chunk, etc.)
  logger.ts             # Structured logger
  browser.ts            # Playwright lifecycle + Cloudflare bypass
  toc.ts                # TOC fetcher + tree utilities
  content.ts            # Page scraper + section extraction
  scrape.ts             # Scraper orchestrator with resume
  verify.ts             # Verification engine
  export.ts             # Multi-format exporter (JSON, MD, TXT, CSV)
  domains.ts            # 9 civic intelligence domains with code cross-refs
  monitor.ts            # Municipal code change detection
  news_monitor.ts       # RSS news aggregator (4 sources + dedup)
  gov_meeting_monitor.ts # City Council/Planning/Harbor meeting tracker
  monthly_report.ts     # Monthly civic health report generator
  structured_queries.ts # Legislative history, section compare, semantic similarity
  legal_parser.ts       # Citation extractor, glossary builder, ordinance parser
  alert_analytics.ts    # Unified alert timeline + per-type statistics
  alerts/
    severity.ts         # Composite 8-monitor alert severity scoring
    noaa_tsunami.ts     # NOAA CAP tsunami warning monitor
    noaa_tides.ts       # NOAA CO-OPS tides (station 9419750)
    usgs_earthquake.ts  # USGS earthquake monitor (M4.0+, 200 km)
    nws_weather.ts      # NWS Del Norte coastal zone CAZ006 alerts
    cdfw_fishing.ts     # CDFW Dungeness crab season monitor
    epa_airnow.ts       # EPA AirNow air quality (PM2.5, ozone, PM10)
    calfire_wildfire.ts # CAL FIRE wildfire incident monitor
    ndbc_marine.ts      # NDBC buoy marine weather (wave, wind, temp)
  api/
    middleware.ts       # Sliding-window rate limiter + API key auth
  domains/
    coverage.ts         # Domain coverage % with prefix matching
  shared/
    paths.ts            # Centralized output path constants
    data.ts             # Data loading layer (60s TTL cache)
    porter_stem.ts      # Zero-dep Porter stemmer for BM25
    readability.ts      # Flesch-Kincaid + Gunning Fog scoring
    fuzzy.ts            # Levenshtein fuzzy matching + typo correction
  gui/
    server.ts           # Bun.serve() HTTP server (port 3000)
    routes.ts           # 30+ API route handlers
    search.ts           # In-memory BM25 full-text search
    analytics.ts        # PCA, K-Means, word loadings
    static/index.html   # Single-page app (no framework)
  llm/
    config.ts           # LLM configuration
    ollama.ts           # Ollama API wrapper
    chroma.ts           # ChromaDB client
    embeddings.ts       # Chunking + indexing pipeline
    rag.ts              # RAG pipeline (embed → retrieve → generate)
    streaming_rag.ts     # SSE streaming RAG (word-by-word)
    index.ts            # CLI entry point
scripts/
  weekly-check.ts       # Weekly health check orchestrator
  run-alerts.ts         # Alert monitor runner (concurrent)
  run-monitor.ts        # Change detection runner
  run-news.ts           # News monitor runner
  run-meetings.ts       # Meeting monitor runner
  run-coverage.ts       # Domain coverage orchestrator
  run-readability.ts    # Readability scoring orchestrator
  cron-setup.sh         # macOS Launchd / Linux cron installer
tests/                  # 329 tests · 25 files · zero-mock policy
docs/                   # Full module documentation suite
output/                 # Scraped data + reports (gitignored)
openapi.yaml            # OpenAPI 3.0.3 spec (v2.0.0)
```

## What's New in v2.0.0

### New Alert Monitors (3)
- **EPA AirNow** — Real-time AQI for PM2.5, ozone, PM10 with health advisories
- **CAL FIRE Wildfire** — Active fire incidents in Del Norte + surrounding counties
- **NDBC Marine** — Buoy observations (wave height, wind, water temp) from 3 stations

### Structured Query Engine
- `GET /api/history/:guid` — Legislative ordinance chain for any section
- `GET /api/compare?guid1=&guid2=` — Word-level diff between two sections
- `GET /api/similar/:guid` — Semantic similarity search (cosine + title boost)
- `GET /api/citations/:guid` — Extract CA Code, U.S.C., case law citations
- `GET /api/glossary` — Definition glossary from entire code corpus

### Legal Citation Parser
- California code citations (Government Code, Health & Safety, Penal, etc.)
- Federal law citations (U.S.C.)
- Case law citations (X v. Y pattern)
- Ordinance amendment extraction with dates

### Fuzzy Search
- Levenshtein edit distance for typo-tolerant queries
- `GET /api/fuzzy?q=harbr` → corrections with similarity scores
- Integrates with BM25 search as fallback

### Streaming RAG
- `POST /api/chat/stream` — Server-Sent Events for word-by-word streaming
- Sources → tokens → done event structure
- Same RAG pipeline (Ollama + ChromaDB) with streaming output

### Alert Analytics
- `GET /api/alerts/timeline` — Unified chronological timeline across all 8 monitors
- `GET /api/alerts/recent?limit=N` — Most recent alert events
- Per-type statistics (counts, severity distribution, frequency)

### Enhanced Composite Severity
- 8-monitor composite (up from 5)
- Air quality, wildfire, and marine integrated into severity scoring
- Priority-ordered severity levels: CALM → WATCH → WARNING → EMERGENCY

## Development Commands

```bash
bun install                  # Install dependencies
bun run scrape               # Scrape municipal code
bun run verify               # Verify scraped data integrity
bun run export               # Export to JSON/Markdown/text/CSV
bun run all                  # Full pipeline: scrape → verify → export
bun run gui                  # Start web viewer on http://localhost:3000
bun run index                # Index sections into ChromaDB
bun run chat                 # Interactive RAG chat
bun run query "question"     # Single RAG query
bun run status               # Show index stats
bun run alerts               # All 8 alert monitors concurrently
bun run alerts:tsunami       # Individual alert monitors
bun run alerts:earthquake
bun run alerts:weather
bun run alerts:tides
bun run alerts:fishing
bun run alerts:airquality    # NEW
bun run alerts:wildfire      # NEW
bun run alerts:marine        # NEW
bun run monitor              # Municipal code change detection
bun run news                 # RSS news (4 sources)
bun run gov-meetings         # Government meeting tracker
bun run weekly-check         # Full health check + summary
bun run readability          # Flesch-Kincaid scoring
bun run coverage             # Domain coverage analysis
bun run report               # Monthly civic health report
bun test                     # Run all 329 tests
```

## Testing

```bash
bun test                    # 329 tests · 25 files
```

All tests run offline. Zero-mock policy: real data, real modules.
5 pre-existing failures are dependency resolution errors (playwright,
chromadb, xmldom) that require `bun install` to resolve.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- Playwright (auto-installed via `bun install`)
- For LLM features:
  - [Ollama](https://ollama.ai) with `nomic-embed-text` and `gemma3:4b` models
  - [ChromaDB](https://www.trychroma.com) server running on port 8000
- For air quality alerts:
  - `AIRNOW_API_KEY` env var (free at [airnowapi.org](https://airnowapi.org))

## Key Patterns

- **Cloudflare bypass**: Non-headless Chromium with custom user agent
- **Resume support**: Manifest tracks scraped articles
- **SHA-256 verification**: Every page hashed at scrape time
- **8-monitor composite severity**: Priority-ordered aggregation
- **Persistent JSONL history**: All alert events logged for analytics
- **Fuzzy search fallback**: Levenshtein correction when BM25 returns 0 results
- **SSE streaming**: Word-by-word RAG answer delivery

## Known Limitations

- Cloudflare Turnstile timing can vary; scraper may need retries
- ecode360 content changes not auto-detected (re-scrape to update)
- CAL FIRE API format may change; parser is defensive
- NDBC buoy data may have gaps (stations go offline for maintenance)
- AirNow API requires free API key

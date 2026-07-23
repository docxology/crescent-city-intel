# Crescent City Intelligence Platform — Documentation

Comprehensive documentation for the full pipeline: scraping, verification,
export, web viewer, RAG chat, streaming, monitoring, alerting, structured
queries, legal analysis, and civic intelligence domains.

## Contents

| Document | Description |
| :--- | :--- |
| [Setup Guide](setup.md) | Step-by-step installation and first-run instructions |
| [Architecture](architecture.md) | System design, data flow diagrams, full module dependency graph |
| [Configuration](configuration.md) | All env vars, constants, and tuning parameters |
| [API Reference](api-reference.md) | Complete table of all exported functions, interfaces, and types |
| [Roadmap](roadmap.md) | Project phases, feature backlog, and progress tracking |
| **Module Guides** | |
| [Scraping](modules/scraping.md) | Browser, TOC, content extraction, and scraper orchestrator |
| [Verification](modules/verification.md) | SHA-256 integrity checks, section presence, live re-fetch |
| [Export](modules/export.md) | JSON, Markdown, plain text, and CSV output |
| [GUI](modules/gui.md) | Web viewer, API routes, search engine, analytics, alerts dashboard |
| [LLM](modules/llm.md) | Ollama, ChromaDB, embeddings, RAG pipeline, streaming SSE |
| [Shared](modules/shared.md) | Paths resolution, data loading, Porter stemmer, readability, fuzzy search |
| [Logger](modules/logger.md) | Structured logging with levels, timestamps, module tags |
| [Domains](modules/domains.md) | 12 civic intelligence domains with code cross-references |
| [Monitoring](modules/monitoring.md) | Code change detection, news, and government meeting monitors |
| [Alerts](modules/alerts.md) | 8 real-time alert monitors + composite severity + alert analytics |
| [v2 Intelligence](modules/v2-intelligence.md) | New v2.0 modules: structured queries, legal parser, fuzzy, streaming, analytics |
| [API Middleware](modules/api.md) | Rate limiting, API key authentication, request logging |

## Quick Links

- **Source**: [`src/`](../src/) — 40+ TypeScript modules
- **Scripts**: [`scripts/`](../scripts/) — thin TypeScript orchestrators
- **Tests**: [`tests/`](../tests/) — 413 tests across 34 files (zero-mock policy)
- **Output**: `output/` (gitignored)
- **OpenAPI**: `openapi.yaml` — OpenAPI 3.0.3 spec (v2.2.0, 45+ endpoints)

## Updating Docs

When modifying source code:

1. Update `docs/modules/<module>.md` for the relevant module.
2. Update `docs/api-reference.md` if adding new exports.
3. Update `docs/configuration.md` if adding new env vars or constants.
4. Update `docs/architecture.md` if changing module relationships or data flow.

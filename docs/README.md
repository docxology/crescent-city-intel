# The Quadruplicate — Documentation

Comprehensive documentation for the full pipeline: scraping, verification,
export, web viewer, RAG chat, streaming, monitoring, alerting, structured
queries, legal analysis, and civic intelligence domains.

## Contents

| Document | Description |
| :--- | :--- |
| [Setup Guide](setup.md) | Step-by-step installation and first-run instructions |
| [Architecture](architecture.md) | System design, data flow diagrams, full module dependency graph |
| [Configuration](configuration.md) | All env vars, constants, and tuning parameters |
| [API Reference](api-reference.md) | Selected module exports; OpenAPI is the HTTP route authority |
| [Generated Configuration](generated/configuration.md) | Environment reads derived from TypeScript source, including explicit dynamic-read limits |
| [Generated Exports](generated/exports.md) | Qualified source export names and declaration hashes |
| [Generated HTTP Inventory](generated/http.md) | Structurally parsed route methods, authentication, parameters and response media |
| [Project Review](project-review.md) | Current-state findings, cleanup decisions, and verification receipts |
| [Roadmap](roadmap.md) | Future priorities, dependencies, and delivery sequence |
| [Open Backlog](../TODO.md) | Minor, medium, and major improvement scopes with acceptance criteria |
| [Manuscript](manuscript.md) | Evidence-bound IMRAD paper, claim ledger, hydration, and template rendering |
| **Module Guides** | |
| [Scraping](modules/scraping.md) | Browser, TOC, content extraction, and scraper orchestrator |
| [Verification](modules/verification.md) | Local custody/replay, current TOC, live sample, and publication binding |
| [Artifact Contracts](modules/artifact-contracts.md) | Shared family validators, explicit migrations and derived-fact byte custody |
| [Lineage and Source Review](modules/source-review.md) | Retained section changes, primary-document review, directory corrections and coverage limits |
| [Export](modules/export.md) | JSON, Markdown, plain text, and CSV output |
| [GitHub Pages](modules/pages.md) | Bounded static snapshots, provenance, and deployment workflow |
| [GUI](modules/gui.md) | Web viewer, API routes, search engine, analytics, alerts dashboard |
| [LLM](modules/llm.md) | Ollama, ChromaDB, embeddings, RAG pipeline, streaming SSE |
| [Shared](modules/shared.md) | Paths resolution, data loading, Porter stemmer, readability, fuzzy search |
| [Logger](modules/logger.md) | Structured logging with levels, timestamps, module tags |
| [Domains](modules/domains.md) | 12 civic intelligence domains with code cross-references |
| [Monitoring](modules/monitoring.md) | Code change detection, news, and government meeting monitors |
| [Alerts](modules/alerts.md) | 20 real-time alert monitors + composite severity + alert analytics |
| [Expansion Monitors](modules/expansion-monitors.md) | Permit/report catalogs, harbor posts, fuel observations, and configured vessel traffic |
| [USCG Broadcasts](modules/uscg_broadcasts.md) | Public District 11 notices and North Coast relevance |
| [Events](modules/events.md) | Occurrence dates, publication timestamps, bounded discovery, and calendar exports |
| [Corpus Intelligence](modules/corpus-intelligence.md) | Section graph, word statistics, and recorded amendment chronology |
| [Geo-Intel](modules/geo-intel.md) | Transferable municipality geo-intel contract + tiles-free map-ready feature view |
| [Geo-Observations](modules/geo-observations.md) | Live hazard-observation envelope for GEO-INFER + the geo contract drift guard |
| [Readability](modules/readability.md) | Flesch-Kincaid scoring, bounded run history, and trend analytics |
| [Additional Intelligence](modules/v2-intelligence.md) | Structured queries, legal parser, fuzzy search, streaming, and analytics |
| [API Middleware](modules/api.md) | Rate limiting, API key authentication, request logging |

## Quick Links

- **Source**: [`src/`](../src/) — TypeScript modules; inspect the tree for the current set
- **Scripts**: [`scripts/`](../scripts/) — thin TypeScript orchestrators
- **Tests**: [`tests/`](../tests/) — run `bun run validate` for the authoritative gate
- **Output**: `output/` (gitignored)
- **OpenAPI**: `openapi.yaml` — OpenAPI 3.0.3 spec (v3.1.1)

## Updating Docs

When modifying source code:

1. Update `docs/modules/<module>.md` for the relevant module.
2. Update `docs/api-reference.md` if adding new exports.
3. Update `docs/configuration.md` if adding new env vars or constants.
4. Update `docs/architecture.md` if changing module relationships or data flow.

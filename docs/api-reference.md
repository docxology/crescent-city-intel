# API Reference

Complete reference for all exported functions, interfaces, and constants.

## Constants (`src/constants.ts`)

| Constant | Type | Default |
| :--- | :--- | :--- |
| `BASE_URL` | `string` | `https://ecode360.com` |
| `MUNICIPALITY_CODE` | `string` | `CR4919` |
| `OUTPUT_DIR` | `string` | `output` |
| `ARTICLES_DIR` | `string` | `output/articles` |
| `RATE_LIMIT_MS` | `number` | `2000` |
| `SCRAPE_TIMEOUT_MS` | `number` | `60000` |
| `CLOUDFLARE_WAIT_MS` | `number` | `2000` |
| `SPA_RENDER_MS` | `number` | `1500` |
| `MAX_RETRIES` | `number` | `3` |
| `VERIFY_SAMPLE_SIZE` | `number` | `5` |
| `EMBED_BATCH_SIZE` | `number` | `32` |
| `OLLAMA_TIMEOUT_MS` | `number` | `30000` |

---

## Logger (`src/logger.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `createLogger` | `(module: string) → Logger` | Returns a module-scoped logger |
| `getLogLevel` | `() → LogLevel` | Current global log level |
| `setLogLevel` | `(level: LogLevel) → void` | Override global log level at runtime |
| `isLevelEnabled` | `(level: LogLevel) → boolean` | Check if a level passes the current threshold |
| `LogLevel` | `type` | `"debug" \| "info" \| "warn" \| "error"` |
| `Logger` | `interface` | `{ debug, info, warn, error, module }` |

---

## Utility Functions (`src/utils.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `computeSha256` | `(text: string) → Promise<string>` | SHA-256 hash as 64-char hex string |
| `flattenToc` | `(node: TocNode) → TocNode[]` | Flatten TOC tree to array |
| `shuffle<T>` | `(arr: T[]) → T[]` | Fisher-Yates shuffle (returns new array) |
| `htmlToText` | `(html: string) → string` | Strip tags, decode entities, normalize whitespace |
| `csvEscape` | `(val: string) → string` | Escape value for CSV (quote if needed) |
| `sanitizeFilename` | `(name: string) → string` | Replace non-alphanumeric, truncate to 80 chars |

---

## Browser (`src/browser.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `launchBrowser` | `() → Promise<BrowserContext>` | Launches Chromium (non-headless) with Cloudflare bypass |
| `closeBrowser` | `() → Promise<void>` | Closes context and browser, resets singletons |
| `navigateWithCloudflare` | `(page: Page, url: string, opts?: {timeout?: number}) → Promise<void>` | Navigate and wait for Cloudflare to resolve |
| `newPage` | `() → Promise<Page>` | Creates a page with `webdriver=false` injected |

---

## TOC (`src/toc.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `fetchToc` | `(page: Page) → Promise<TocNode>` | Intercept `/toc/CR4919` API response, return TOC tree |
| `flattenToc` | `(node: TocNode) → TocNode[]` | Re-exported from `utils.ts` |
| `getArticlePages` | `(toc: TocNode) → TocNode[]` | All scrapable page nodes |
| `getSections` | `(toc: TocNode) → TocNode[]` | All leaf section nodes |
| `tocSummary` | `(toc: TocNode) → string` | Human-readable TOC summary |

---

## Content (`src/content.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `scrapeArticlePage` | `(page: Page, article: TocNode) → Promise<ArticlePage>` | Scrape one article page, extract all sections |

---

## Scraper utilities (`src/scraper_utils.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `isTocShapeValid` | `(value: unknown) → value is TocNode` | Reject malformed, duplicate-guid, or section-empty TOC payloads |
| `isArticleArtifactShapeValid` | `(value: unknown, expectedSectionGuids?, exactSectionGuids?) → boolean` | Validate article JSON shape and expected section coverage before resume-skip |
| `withRetry` | `(fn, maxRetries?, baseDelayMs?) → Promise<{result, retried, attempts}>` | Exponential-backoff retry wrapper |
| `isMaintenanceMode` | `(status, url, finalUrl) → boolean` | Detect 503 or unexpected redirects |

---

## Monitor (`src/monitor.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `runMonitor` | `() → Promise<MonitorReport>` | Full change detection: hash check + section coverage |
| `checkHashes` | `() → Promise<{checked, mismatches}>` | Verify SHA-256 hashes of all saved articles |
| `checkSectionCoverage` | `() → Promise<{missing, extra}>` | Cross-reference scraped sections against TOC |
| `MonitorReport` | `interface` | `{timestamp, articlesChecked, hashMismatches, missingSections, newSections, overallStatus, summary}` |

---

## News Monitor (`src/news_monitor.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorNews` | `() → Promise<NewsItem[]>` | Fetch all RSS feeds, deduplicate, filter, save to `output/news/` |
| `fetchRSSFeedDetailed` | `(url: string, source: string) → Promise<NewsFeedResult>` | Fetch RSS/Atom and return items plus typed source health |
| `fetchRSSFeed` | `(url: string, source: string) → Promise<NewsItem[]>` | Fetch and parse a single RSS/Atom feed |
| `normalizeUrl` | `(url: string) → string` | Stable deduplication key with tracking parameters removed |
| `NewsItem` | `interface` | `{id, title, link, pubDate, source, description, fetchedAt}` |
| `SourceHealth` | `interface` | `ok | empty | unavailable | stale` plus timestamps, count, error, provenance, freshness, and duration |
| `summarizeSourceHealth` | `source_health.ts` | Aggregate present/missing counts, percentage coverage, named gaps, and compatibility alias |
| `executePipelineStep` | `orchestration.ts` | Capture a stage's status, duration, item count, output paths, and error |

---

## Government Meeting Monitor (`src/gov_meeting_monitor.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorGovMeetings` | `() → Promise<MeetingItem[]>` | Scrape all government meeting sources, save to `output/gov_meetings/` |
| `fetchGovMeetings` | `(name: string, url: string) → Promise<MeetingItem[]>` | Scrape one meeting source |
| `saveMeetingItems` | `(items: MeetingItem[]) → Promise<void>` | Persist meeting items to JSON file |
| `MeetingItem` | `interface` | `{id, title, body, source, url, fetchedAt, hash}` |

---

## YouTube and Triplicate monitors

| Export | Module | Description |
| :--- | :--- | :--- |
| `listChannelVideos` | `youtube_monitor.ts` | List recent official-channel videos |
| `listChannelVideosDetailed` | `youtube_monitor.ts` | Video listing plus typed source health |
| `parseVtt` | `youtube_monitor.ts` | Collapse rolling auto-caption cues into timestamped segments |
| `monitorYouTube` | `youtube_monitor.ts` | Idempotent transcript extraction and Chroma indexing |
| `monitorTriplicate` | `triplicate_monitor.ts` | Reference-only Playwright metadata collection with retryable health states |
| `extractArticles` | `triplicate_monitor.ts` | Defensive same-host article-link extraction |
| `TRIPLICATE_USAGE_POLICY` | `triplicate_monitor.ts` | Machine-readable citation-only/no-training policy tag |

---

## Domains (`src/domains.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `domains` | `IntelligenceDomain[]` | Configured intelligence domains (const) |
| `getDomainById` | `(id: string) → IntelligenceDomain \| undefined` | Look up domain by ID slug |
| `getDomainSummaries` | `() → DomainSummary[]` | Lightweight list (no topics) |
| `searchDomains` | `(query: string) → IntelligenceDomain[]` | Full-text search across domain names, descriptions, tags |
| `IntelligenceDomain` | `interface` | `{id, name, description, icon, topics, updatedAt}` |
| `DomainTopic` | `interface` | `{name, description, sources, externalRefs?, tags}` |
| `DomainSource` | `interface` | `{sectionNumber, relevance}` |

---

## Geo-Intel (`src/geo.ts`, `src/geo_view.ts`)

| Export | Module | Signature | Description |
| :--- | :--- | :--- | :--- |
| `CRESCENT_CITY_ANCHOR` | `geo.ts` | `MunicipalityAnchor` | Authoritative Crescent City + Del Norte bounds (WGS84) |
| `getDefaultCrescentSpec()` | `geo.ts` | `() → MunicipalitySpec` | Crescent City anchor + 12 domains as data |
| `buildMunicipalityContract(spec)` | `geo.ts` | `(MunicipalitySpec) → Record<string, unknown>` | **Transferable** pure builder for any municipality |
| `buildGeoIntel(domainList?)` | `geo.ts` | `(IntelligenceDomain[]) → Record<string, unknown>` | Legacy Crescent shorthand (delegates to transferable builder) |
| `hazardRelevantDomains(surface?)` | `geo.ts` | `(IntelligenceDomain[]?) → Array<{…}>` | Hazard-tagged subset (word-boundary matching) |
| `geoPaths` | `geo.ts` | `{ pagesSeed, liveExport }` | `pages-data/geo-intel.json` + `output/geo-intel.json` |
| `writeGeoIntelExports()` | `geo.ts` | `() → Promise<string[]>` | Write Crescent seed + live export (guarded) |
| `buildGeoView(intel)` | `geo_view.ts` | `(contract) → GeoIntelView` | Tiles-free SVG map features (bounds, anchor, hazard points, sections), `crescent-city-geo-view/v1` |
| `/api/geo-intel` | `gui/routes.ts` | `GET` | Serves the contract + geo-view feature surface (pure, no scraper needed) |

## Shared (`src/shared/`)

| Function | Module | Signature | Description |
| :--- | :--- | :--- | :--- |
| `paths` | `paths.ts` | Object | Path constants + `article(guid) → string` |
| `loadToc` | `data.ts` | `() → Promise<TocNode>` | Parse `output/toc.json` |
| `loadManifest` | `data.ts` | `() → Promise<ScrapeManifest>` | Parse `output/manifest.json` |
| `loadArticle` | `data.ts` | `(guid) → Promise<ArticlePage>` | Load single article JSON |
| `loadAllArticles` | `data.ts` | `() → Promise<ArticlePage[]>` | Load all article JSONs |
| `loadAllSections` | `data.ts` | `() → Promise<FlatSection[]>` | All sections with article metadata |
| `searchSections` | `data.ts` | `(query, sections?) → Promise<FlatSection[]>` | Substring search across sections |

---

## GUI (`src/gui/`)

| Function | Module | Signature | Description |
| :--- | :--- | :--- | :--- |
| `handleApiRoute` | `routes.ts` | `(url: URL, req?: Request) → Promise<Response>` | Main API route dispatcher |
| `initSearch` | `search.ts` | `() → Promise<void>` | Load sections into memory (singleton) |
| `search` | `search.ts` | `(query, limit?) → SearchResult[]` | Keyword search with ranking |
| `getIndexedCount` | `search.ts` | `() → number` | Number of indexed sections |
| `getCodeStats` | `analytics.ts` | `() → Promise<CodeStats>` | Aggregate stats (articles, sections, words) |
| `getEmbeddingProjection` | `analytics.ts` | `() → Promise<EmbeddingProjection>` | PCA + K-Means projection |
| `kmeans` | `analytics.ts` | `(data, k, maxIter?) → {centroids, assignments}` | K-Means clustering |
| `powerIteration` | `analytics.ts` | `(data, dim, _, iterations?) → {vector, eigenvalue}` | Dominant eigenvector via power iteration |
| `computeWordLoadings` | `analytics.ts` | `(docs, projections, pcs) → WordLoading[]` | Pearson correlation of terms to PCs |
| `/api/sources` | `routes.ts` | `GET` | Canonical source registry, automation boundaries, and known health joins |
| `/api/source-discovery` | `routes.ts` | `GET` | Fingerprinted discovery report, coverage counts, and explicit gaps |

## Source registry (`src/source_registry.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `getSourceRegistry` | `() → SourceDefinition[]` | Return stable, sorted canonical source definitions |
| `validateSourceRegistry` | `(registry?) → string[]` | Validate IDs, URLs, provenance, uniqueness, and Triplicate policy |
| `sourceRegistryFingerprint` | `(registry?) → Promise<string>` | SHA-256 fingerprint of the normalized inventory |
| `buildSourceDiscoveryReport` | `(options?) → Promise<SourceDiscoveryReport>` | Join known monitor health and optional bounded probes without hiding `not-checked` |
| `writeSourceDiscoveryArtifacts` | `(options?) → Promise<SourceDiscoveryReport>` | Atomically persist registry, discovery, and idempotency artifacts |

---

## Public Pages Snapshot (`src/pages_snapshot.ts`)

| Export | Signature | Description |
| :--- | :--- | :--- |
| `buildPagesSnapshot` | `(outputDir?, generatedAt?) → Promise<PagesSnapshot>` | Read bounded public data and preserve source health/provenance |
| `exportPagesSnapshot` | `(options?) → Promise<PagesExportResult>` | Atomically build the static `.pages/` artifact |
| `validatePagesSource` | `(indexHtml) → string[]` | Check the static dashboard for API-key/local-service leakage and required data links |
| `PagesSnapshot` | `interface` | Versioned public snapshot envelope with code, source, alert, report, and policy metadata |
| `PagesExportResult` | `interface` | Destination, status, generated files, and exported item counts |

### Operational and lineage routes

| Route | Method | Contract |
| :--- | :--- | :--- |
| `/api/metadata` | GET | Non-secret build, provider, artifact, and aggregate source-health metadata |
| `/api/curation/status` | GET | Latest provider/model batch telemetry and retry counts |
| `/api/report/latest.json` | GET | Machine-readable monthly report period, metrics, warnings, and health |

The CLI wrappers are `bun run pages:export` and `bun run pages:validate`.

---

## API Middleware (`src/api/middleware.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `applyMiddleware` | `(req: Request) → Promise<Response \| null>` | Apply rate limit + API key auth; returns `null` to pass through |

---

## Alert Monitors (`src/alerts/`)

| Function | Module | Signature | Description |
| :--- | :--- | :--- | :--- |
| `monitorNOAATsunamiAlerts` | `noaa_tsunami.ts` | `() → Promise<void>` | Fetch NOAA CAP alerts, save to `output/alerts/tsunami/` |
| `monitorUSGSEarthquakeAlerts` | `usgs_earthquake.ts` | `() → Promise<void>` | Fetch USGS GeoJSON, filter by proximity and magnitude |
| `monitorNWSWeatherAlerts` | `nws_weather.ts` | `() → Promise<void>` | Fetch NWS alerts for CAZ006, categorize by severity |

---

## LLM (`src/llm/`)

| Function | Module | Signature | Description |
| :--- | :--- | :--- | :--- |
| `llmConfig` | `config.ts` | Object | All config properties |
| `configuredChatProvider` | `provider.ts` | `() → "ollama" | "openrouter"` | Selected chat provider |
| `chatWithProvider` | `provider.ts` | `(messages, context?) → Promise<string>` | Provider-dispatched chat completion |
| `configuredChatModel` | `provider.ts` | `(modelOverride?) → string` | Resolve the active provider/model identity |
| `checkChatProvider` | `provider.ts` | `() → Promise<ProviderHealth>` | Selected-provider preflight and model metadata |
| `checkOpenRouterHealth` | `openrouter.ts` | `(options?) → Promise<OpenRouterHealthCheck>` | Bounded non-generative `/models` preflight |
| `embed` | `ollama.ts` | `(text) → Promise<number[]>` | Single text embedding via Ollama |
| `embedBatch` | `ollama.ts` | `(texts) → Promise<number[][]>` | Batch embedding |
| `chat` | `ollama.ts` | `(messages, context?) → Promise<string>` | Chat completion |
| `listModels` | `ollama.ts` | `() → Promise<string[]>` | Available Ollama models |
| `isOllamaRunning` | `ollama.ts` | `(timeoutMs?) → Promise<boolean>` | Bounded Ollama health check |
| `getOrCreateCollection` | `chroma.ts` | `() → Promise<Collection>` | Singleton ChromaDB collection |
| `addDocuments` | `chroma.ts` | `(docs) → Promise<void>` | Upsert documents |
| `query` | `chroma.ts` | `(embedding, topK?) → Promise<{ids, documents, metadatas, distances}>` | Semantic search |
| `getStats` | `chroma.ts` | `() → Promise<{count, name}>` | Collection stats |
| `isChromaRunning` | `chroma.ts` | `() → Promise<boolean>` | ChromaDB health check |
| `isIndexed` | `embeddings.ts` | `() → Promise<boolean>` | Check if collection has documents |
| `indexAllSections` | `embeddings.ts` | `() → Promise<void>` | Chunk + embed + store all sections |
| `ragQuery` | `rag.ts` | `(userQuestion) → Promise<RagResponse>` | Full RAG pipeline |

## Curation (`src/curation.ts`)

| Function | Signature | Description |
| :--- | :--- | :--- |
| `gatherCurationInputs` | `() → Promise<CurationInput[]>` | Read deterministic, already-fetched news, meeting, and YouTube inputs |
| `summarizeItemDetailed` | `(item) → Promise<SummaryResult>` | Source-grounded, bounded, retryable provider summary |
| `buildCurationEvidence` | `(item, inputFingerprint) → evidence` | Build citations and fetch provenance without an LLM call |
| `mergeCuratedItems` | `(existing, incoming) → CuratedItem[]` | Upsert visible daily output by stable source ID |
| `runCuration` | `() → Promise<CuratedItem[]>` | Idempotent curation run with provider/model/prompt-aware fingerprints |

---

## Interfaces (`src/types.ts`)

| Interface | Description |
| :--- | :--- |
| `TocNode` | Node in the ecode360 TOC tree |
| `ArticlePage` | Scraped content for one article page |
| `SectionContent` | Single section text content |
| `ScrapeManifest` | Manifest tracking all scraped articles |
| `VerificationResult` | Per-article verification result |
| `VerificationReport` | Overall verification summary |
| `FlatSection` | Section with parent article metadata |
| `SearchResult` | Search result with snippet and score |
| `ChatMessage` | LLM chat message (role + content) |
| `RagSource` | Source citation from RAG retrieval |
| `RagResponse` | Complete RAG response with answer + sources, query ID, and retrieval/generation lineage |
| `RagMetadata` | RAG latency, context fingerprint, grounding flag, embedding model, and vector-store metadata |
| `SourceHealth` | Typed external-source availability/freshness contract |
| `TitleStats` | Per-title statistics (analytics) |
| `CodeStats` | Aggregate code statistics (analytics) |
| `EmbeddingPoint` | Single point in PCA projection |
| `WordLoading` | Term-to-PC Pearson correlation |
| `EmbeddingProjection` | Full PCA projection result |

**From `src/monitor.ts`:**

| Interface | Description |
| :--- | :--- |
| `MonitorReport` | Change detection report `{timestamp, articlesChecked, hashMismatches, missingSections, newSections, overallStatus, summary}` |

**From `src/news_monitor.ts`:**

| Interface | Description |
| :--- | :--- |
| `NewsItem` | Aggregated news item `{id, title, link, pubDate, source, description, fetchedAt}` |

**From `src/domains.ts`:**

| Interface | Description |
| :--- | :--- |
| `IntelligenceDomain` | Top-level domain `{id, name, description, icon, topics, updatedAt}` |
| `DomainTopic` | Topic within a domain `{name, description, sources, externalRefs?, tags}` |
| `DomainSource` | Cross-reference to a municipal code section |

## Round-3 / "proceed-with-all" additions

**From `src/gui/semantic_search.ts`:**

| Export | Description |
| :--- | :--- |
| `semanticSearch(query, {limit, offset, forceFallback})` | Ollama-embed + ChromaDB retrieval; degrades to BM25 (`mode: "bm25-fallback"`) when the vector stack is unavailable |
| `bm25Fallback(query, {limit, offset}, reason)` | Deterministic BM25 fallback path (mode `bm25-fallback`) |
| `SemanticSearchResult` | `{mode, query, total, count, results, vectorStoreAvailable, reason}` |

**From `src/llm/rag.ts`:**

| Export | Description |
| :--- | :--- |
| `rerankByQueryOverlap(query, candidates, topN)` | Lexical-hybrid rerank (query-term overlap ⊕ vector similarity) behind `RERANK_ENABLED` |
| `buildChatMessages(userQuestion, history?)` | Bounded (last 6) multi-turn message list builder |
| `MAX_HISTORY_TURNS` | History turn cap (6) |
| `buildRagSource(doc, meta, distance)` | RagSource construction (municipal / youtube branches) |

**From `src/alerts/notify.ts`:**

| Export | Description |
| :--- | :--- |
| `maybeSendSeverityWebhook(report)` | Fire-and-forget POST on composite WARNING/EMERGENCY when `ALERT_WEBHOOK_URL` set |
| `sendWebhook(url, payload, timeoutMs?)` | Bounded JSON POST returning `{ok, status}` |
| `isWebhookConfigured()` | True when `ALERT_WEBHOOK_URL` is set |

**From `src/shared/source_health.ts`:**

| Export | Description |
| :--- | :--- |
| `appendBoundedJsonl(path, line, maxLines?)` | Async JSONL appender with cap + tail-trim (atomic) |
| `appendBoundedJsonlSync(path, line, maxLines?)` | Synchronous variant (temp+rename) |

**From `src/gov_meeting_monitor.ts`:**

| Export | Description |
| :--- | :--- |
| `extractLinkItems(htmlAnchors?)` | Parse anchor HTML into structured `{title, url}` agenda/minutes items |
| `LinkItem` | `{title, url}` |

**From `src/news_monitor.ts`:**

| Export | Description |
| :--- | :--- |
| `dedupKey(url, title)` | Composite (normalized URL | title) dedup key |

**From `src/api/middleware.ts`:**

| Export | Description |
| :--- | :--- |
| `getRateLimitStats()` | `{trackedIps, peakUsage, blocked}` for `/api/health` |

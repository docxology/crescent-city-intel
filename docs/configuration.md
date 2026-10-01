# Configuration

All configurable parameters for the Crescent City Municipal Code project.

The [generated environment inventory](generated/configuration.md) derives literal
environment reads and defaults from TypeScript ASTs without reading current
environment values. It lists unresolved dynamic reads explicitly. This guide
explains operational choices; the generated inventory is the exhaustive literal
source reference. `bun run scripts/generate-docs.ts --check` rejects drift with
the affected filename; `--write` regenerates current inventories.

## Core Constants (`src/constants.ts`)

Hard-coded project constants. Change these to target a different municipality.

| Constant | Value | Description |
| :--- | :--- | :--- |
| `BASE_URL` | `https://ecode360.com` | ecode360 base URL |
| `MUNICIPALITY_CODE` | `CR4919` | Crescent City municipality identifier |
| `OUTPUT_DIR` | `output` | Root output directory |
| `ARTICLES_DIR` | `output/articles` | Per-article JSON storage |
| `RATE_LIMIT_MS` | `2000` | Default ms between scrape requests (env-overridable) |
| `SCRAPE_TIMEOUT_MS` | `60000` | Cloudflare wait timeout (env-overridable) |
| `CLOUDFLARE_WAIT_MS` | `2000` | Extra wait after Cloudflare resolves |
| `SPA_RENDER_MS` | `1500` | SPA render settle time |
| `MAX_RETRIES` | `3` | Additional retries after the initial article attempt |
| `VERIFY_SAMPLE_SIZE` | `5` | Random re-fetch sample for verification |
| `EMBED_BATCH_SIZE` | `32` | Chunks per Ollama embedding request |
| `OLLAMA_TIMEOUT_MS` | `30000` | Ollama request timeout |

## Environment Variables

### GUI Server

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | GUI server port |
| `LOG_LEVEL` | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |

### LLM / RAG

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API server |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama model for embeddings |
| `CHAT_MODEL` | `gemma3:4b` | Ollama model for chat/summarization |
| `LLM_PROVIDER` | `ollama` | Chat provider (`ollama` or `openrouter`) |
| `OPENROUTER_API_KEY` | unset | Required when using OpenRouter |
| `OPENROUTER_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base URL |
| `OPENROUTER_MODEL` | `inclusionai/ling-3.0-flash:free` | OpenRouter chat model |
| `OPENROUTER_MAX_TOKENS` | `1024` | Maximum tokens per OpenRouter completion |
| `OPENROUTER_MAX_REQUESTS` | `100` | Per-process OpenRouter request cap |
| `OPENROUTER_TIMEOUT_MS` | `120000` | OpenRouter request timeout |
| `OPENROUTER_MIN_REQUEST_INTERVAL_MS` | `3100` | Minimum spacing between OpenRouter requests |
| `LLM_PREFLIGHT_TIMEOUT_MS` | `5000` | Bounded selected-provider health-check timeout |
| `CURATION_SUMMARY_TIMEOUT_MS` | `15000` | Maximum time for one source summary before source-only fallback |
| `CHROMA_URL` | `http://localhost:8001` | ChromaDB server |
| `SOURCE_FETCH_TIMEOUT_MS` | `10000` | Default external-source timeout |
| `SOURCE_FRESHNESS_WINDOW_MS` | `86400000` | Default retrieval-age window for non-alert source health (news, meetings, YouTube, Triplicate). It does not replace a monitor's required observation or product clock. |
| `ALERT_FRESHNESS_WINDOW_MS` | `3600000` | Generic unkeyed `isFreshReport(report, now)` compatibility window. Keyed production monitors use `SOURCE_CLOCK_POLICIES` in `src/source_clocks.ts`; this variable does not override those per-monitor policies. An unparseable or non-positive value falls back to the default. |
| `SOURCE_DISCOVERY_TIMEOUT_MS` | `10000` | Bounded timeout for optional source-discovery probes |
| `SOURCE_DISCOVERY_LIVE_CHECK` | unset | Set to `1` in scheduled orchestration to probe discovery-only sources; offline runs keep them `not-checked` |
| `NEWS_FETCH_TIMEOUT_MS` | `10000` | News feed timeout |
| `NEWS_DISABLED_SOURCES` | empty | Comma-separated feed names to mark unavailable without fetching |
| `GOV_MEETINGS_TIMEOUT_MS` | `10000` | Meeting endpoint timeout |
| `YT_DLP_TIMEOUT_MS` | `15000` | Maximum time for a YouTube listing/transcript subprocess |

The twenty alert monitors declare retrieval, observation or product clocks in
`src/source_clocks.ts`. Policies reflect each product's cadence: for example,
AirNow/buoy observations expire after two hours, local AIS positions after twenty
minutes, and weekly drought/fuel products after ten days. A supplied validity end
can expire a product earlier. Missing, invalid or future primary clocks cannot
be made current by refetching; retrieval age and observation age remain separate.

### API Security

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CRESCENT_CITY_API_KEY` | _(random per-boot)_ | Header-only key for spec-protected operations (comma-separated for multiple); public read routes declare `security: []` in OpenAPI |

`CC_OUTPUT_DIR` selects the artifact root per operation.
`CRESCENT_TRUSTED_PROXY_IPS` is a comma-separated exact socket-peer allowlist;
leave it empty unless a reviewed proxy supplies client addresses.

The API rate limiter uses a sliding window of 100 requests per IP per hour
(`RATE_LIMIT_MAX_REQUESTS`, not env-overridable) with separate chat (20), vector (10), and probe (1000) buckets. Socket peers
remain subject to quotas; forwarded IP headers are accepted only from exact
`CRESCENT_TRUSTED_PROXY_IPS` peers. Expensive operations have finite admission
and cancellation; the GUI receives its key only on an eligible loopback request. The
`RATE_LIMIT_MS` variable listed under Scraper applies to scraping, not the API.

### Scraper

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RATE_LIMIT_MS` | `2000` | Inter-request delay |
| `SCRAPE_TIMEOUT_MS` | `60000` | Cloudflare wait timeout |
| `CLOUDFLARE_WAIT_MS` | `2000` | Extra wait after the challenge clears |
| `SPA_RENDER_MS` | `1500` | Wait for ecode360 SPA content to settle |
| `MAX_RETRIES` | `3` | Additional retries after the initial article attempt |

## LLM Tuning Parameters (`src/llm/config.ts`)

| Parameter | Default | Description |
| :--- | :--- | :--- |
| `collectionName` | `crescent-city-code` | ChromaDB collection name |
| `chunkSize` | `1500` | Characters per text chunk for embedding |
| `chunkOverlap` | `150` | Character overlap between adjacent chunks |
| `topK` | `10` | Number of results retrieved per RAG query |

## Analytics Parameters (`src/gui/analytics.ts`)

| Parameter | Default | Description |
| :--- | :--- | :--- |
| `NUM_PCS` | `10` | Number of principal components |
| `MAX_POINTS` | `2000` | Max points for PCA (sub-sampled if more) |
| K-Means `k` | `6` | Number of clusters |
| Power iteration count | `20` | Iterations per principal component |
| ChromaDB batch size | `500` | Vectors fetched per ChromaDB request |

## Alert Monitor Parameters

| File | Parameter | Default | Description |
| :--- | :--- | :--- | :--- |
| `usgs_earthquake.ts` | `SEARCH_RADIUS_KM` | `200` | Max distance from Crescent City for quakes |
| `usgs_earthquake.ts` | `MIN_MAGNITUDE` | `4.0` | Minimum earthquake magnitude |
| `nws_weather.ts` | NWS zone | `CAZ101` | Coastal Del Norte public forecast zone code |
| `epa_airnow.ts` | `AIRNOW_API_KEY` | _(none)_ | Free API key from [airnowapi.org](https://airnowapi.org) — optional keyed API; the default reads public AirNow observations |
| `calfire_wildfire.ts` | `SEARCH_COUNTIES` | `["Del Norte", "Siskiyou", "Humboldt", "Trinity"]` | Counties to monitor |
| `calfire_wildfire.ts` | `SEARCH_RADIUS_KM` | `150` | Max distance from Crescent City for fire incidents |
| `ndbc_marine.ts` | `WAVE_HEIGHT_WARNING_FT` | `15` | Wave height threshold for WARNING severity |
| `ndbc_marine.ts` | `WAVE_HEIGHT_WATCH_FT` | `10` | Wave height threshold for WATCH severity |
| `ndbc_marine.ts` | `WIND_SPEED_WARNING_KT` | `34` | Wind speed threshold for WARNING (gale force) |
| `ndbc_marine.ts` | `WIND_SPEED_WATCH_KT` | `22` | Wind speed threshold for WATCH |
| `ais.ts` | `AIS_FEED_URL` | `https://meri.digitraffic.fi/api/ais/v1/locations` | Open-AIS FeatureCollection feed (keyless default; point at a US-waters provider for local coverage) |
| `pacfin.ts` | `PACFIN_SESSION_COOKIE` | _(none)_ | Optional credential forwarded to the PacFIN dashboard fetch. The current monitor reads the public report catalog; setting this does not enable landing-figure extraction. |

## Example: Override Multiple Settings

```bash
PORT=8080 LOG_LEVEL=debug OLLAMA_URL=http://my-server:11434 bun run gui
AIRNOW_API_KEY=your-key-here bun run alerts:airquality
```

## Additional environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ALERT_WEBHOOK_URL` | _(unset)_ | Optional URL; `scripts/run-alerts.ts` POSTs a JSON payload when the composite transitions into WARNING/EMERGENCY |
| `ALERT_WEBHOOK_TIMEOUT_MS` | `5000` | Positive-integer webhook POST timeout (`src/alerts/notify.ts`); invalid/non-positive values fall back to 5000 |
| `RERANK_ENABLED` | `false` | Enable the post-retrieval lexical-hybrid rerank (`src/llm/rag.ts`) |
| `RERANK_TOP_N` | `5` | Chunks retained by the rerank when `RERANK_ENABLED=true` |

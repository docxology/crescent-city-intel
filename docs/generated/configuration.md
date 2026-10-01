# Generated configuration inventory

Parsed from TypeScript source without evaluating modules or reading environment values. These are source expressions, not validated setting values. Literal env reads and discovered literal-key wrappers are listed; dynamic key reads remain explicit. Runtime coercion, units and valid ranges belong to their declared consumer.

| Variable | Consumer | Source expression | Fallback expression |
| :--- | :--- | :--- | :--- |
| `AIRNOW_API_KEY` | [src/alerts/epa_airnow.ts:149](../../src/alerts/epa_airnow.ts#L149) | `process.env.AIRNOW_API_KEY` | not declared at this read |
| `AIS_FEED_URL` | [src/alerts/ais.ts:171](../../src/alerts/ais.ts#L171) | `process.env[AIS_FEED_URL_ENV]` | `DIGITRAFFIC_AIS_URL` |
| `AIS_FEED_URL` | [src/alerts/ais.ts:201](../../src/alerts/ais.ts#L201) | `process.env[AIS_FEED_URL_ENV]` | `DIGITRAFFIC_AIS_URL` |
| `AIS_FEED_URL` | [src/alerts/ais.ts:237](../../src/alerts/ais.ts#L237) | `process.env[AIS_FEED_URL_ENV]` | `DIGITRAFFIC_AIS_URL` |
| `AIS_LOCAL_COVERAGE_CONFIRMED` | [src/alerts/ais.ts:175](../../src/alerts/ais.ts#L175) | `process.env.AIS_LOCAL_COVERAGE_CONFIRMED` | not declared at this read |
| `ALERT_FRESHNESS_WINDOW_MS` | [src/alerts/composite.ts:145](../../src/alerts/composite.ts#L145) | `process.env.ALERT_FRESHNESS_WINDOW_MS` | `""` |
| `ALERT_WEBHOOK_TIMEOUT_MS` | [src/alerts/notify.ts:14](../../src/alerts/notify.ts#L14) | `process.env.ALERT_WEBHOOK_TIMEOUT_MS` | `""` |
| `ALERT_WEBHOOK_URL` | [src/alerts/notify.ts:11](../../src/alerts/notify.ts#L11) | `process.env.ALERT_WEBHOOK_URL` | `""` |
| `ALERT_WEBHOOK_URL` | [src/notifications/push.ts:23](../../src/notifications/push.ts#L23) | `env("ALERT_WEBHOOK_URL")` | not declared at this read |
| `ALERT_WEBHOOK_URL` | [src/notifications/push.ts:23](../../src/notifications/push.ts#L23) | `env("ALERT_WEBHOOK_URL")` | not declared at this read |
| `ALERT_WEBHOOK_URL` | [src/notifications/push.ts:86](../../src/notifications/push.ts#L86) | `env("ALERT_WEBHOOK_URL")` | not declared at this read |
| `ALERT_WEBHOOK_URL` | [src/notifications/push.ts:88](../../src/notifications/push.ts#L88) | `env("ALERT_WEBHOOK_URL")` | not declared at this read |
| `ALERT_WEBHOOK_URL` | [src/notifications/push.ts:89](../../src/notifications/push.ts#L89) | `env("ALERT_WEBHOOK_URL")` | not declared at this read |
| `APP_VERSION` | [src/gui/routes.ts:1112](../../src/gui/routes.ts#L1112) | `process.env.APP_VERSION` | `packageVersion()` |
| `APP_VERSION` | [src/shared/orchestration.ts:111](../../src/shared/orchestration.ts#L111) | `process.env.APP_VERSION` | `packageVersion()` |
| `ARTICLE_DEADLINE_MS` | [src/content.ts:117](../../src/content.ts#L117) | `process.env.ARTICLE_DEADLINE_MS` | not declared at this read |
| `ARTICLE_DEADLINE_MS` | [src/content.ts:117](../../src/content.ts#L117) | `process.env.ARTICLE_DEADLINE_MS` | not declared at this read |
| `CC_OUTPUT_DIR` | [src/shared/paths.ts:28](../../src/shared/paths.ts#L28) | `process.env.CC_OUTPUT_DIR` | not declared at this read |
| `CC_OUTPUT_DIR` | [src/shared/paths.ts:33](../../src/shared/paths.ts#L33) | `process.env.CC_OUTPUT_DIR` | not declared at this read |
| `CC_QUERY_LOGGING` | [src/llm/privacy.ts:21](../../src/llm/privacy.ts#L21) | `process.env.CC_QUERY_LOGGING` | not declared at this read |
| `CC_QUERY_RETENTION_DAYS` | [src/llm/privacy.ts:27](../../src/llm/privacy.ts#L27) | `process.env.CC_QUERY_RETENTION_DAYS` | not declared at this read |
| `CHANGED` | [scripts/ci-affected-tests.ts:5](../../scripts/ci-affected-tests.ts#L5) | `process.env.CHANGED` | `""` |
| `CHAT_MODEL` | [scripts/stack-readiness.ts:3](../../scripts/stack-readiness.ts#L3) | `process.env.CHAT_MODEL` | `"gemma3:4b"` |
| `CHAT_MODEL` | [src/llm/config.ts:21](../../src/llm/config.ts#L21) | `process.env.CHAT_MODEL` | `"gemma3:4b"` |
| `CHROMA_URL` | [scripts/stack-readiness.ts:3](../../scripts/stack-readiness.ts#L3) | `process.env.CHROMA_URL` | `"http://127.0.0.1:8001"` |
| `CHROMA_URL` | [src/llm/config.ts:52](../../src/llm/config.ts#L52) | `process.env.CHROMA_URL` | `"http://localhost:8001"` |
| `CI` | [src/shared/orchestration.ts:114](../../src/shared/orchestration.ts#L114) | `process.env.CI` | `process.env.GITHUB_ACTIONS` |
| `CI_COMMIT_SHA` | [src/shared/orchestration.ts:82](../../src/shared/orchestration.ts#L82) | `process.env.CI_COMMIT_SHA` | not declared at this read |
| `CLOUDFLARE_WAIT_MS` | [src/constants.ts:39](../../src/constants.ts#L39) | `envInt("CLOUDFLARE_WAIT_MS", 2000)` | `2000` |
| `CODE_SEED_PATH` | [src/derived_publication.ts:50](../../src/derived_publication.ts#L50) | `process.env.CODE_SEED_PATH` | `join(import.meta.dir, '..', 'pages-data', 'crescent-city-code.json')` |
| `CODE_SEED_PATH` | [src/gui/analytics.ts:63](../../src/gui/analytics.ts#L63) | `process.env.CODE_SEED_PATH` | not declared at this read |
| `CRESCENT_CITY_API_KEY` | [src/api/middleware.ts:44](../../src/api/middleware.ts#L44) | `process.env.CRESCENT_CITY_API_KEY` | not declared at this read |
| `CRESCENT_CITY_INTEL_BUNDLED_PATH` | [src/geo_sync.ts:90](../../src/geo_sync.ts#L90) | `process.env.CRESCENT_CITY_INTEL_BUNDLED_PATH` | `DEFAULT_BUNDLED_PATH` |
| `CRESCENT_TRUSTED_PROXY_IPS` | [src/api/middleware.ts:181](../../src/api/middleware.ts#L181) | `process.env.CRESCENT_TRUSTED_PROXY_IPS` | `""` |
| `CURATION_SUMMARY_TIMEOUT_MS` | [src/curation.ts:353](../../src/curation.ts#L353) | `process.env.CURATION_SUMMARY_TIMEOUT_MS` | `'15000'` |
| `EMBED_BATCH_SIZE` | [src/constants.ts:53](../../src/constants.ts#L53) | `envInt("EMBED_BATCH_SIZE", 32)` | `32` |
| `EMBEDDING_MODEL` | [scripts/stack-readiness.ts:3](../../scripts/stack-readiness.ts#L3) | `process.env.EMBEDDING_MODEL` | `"nomic-embed-text"` |
| `EMBEDDING_MODEL` | [src/llm/config.ts:18](../../src/llm/config.ts#L18) | `process.env.EMBEDDING_MODEL` | `"nomic-embed-text"` |
| `GIT_COMMIT` | [src/gui/routes.ts:1113](../../src/gui/routes.ts#L1113) | `process.env.GIT_COMMIT` | not declared at this read |
| `GIT_COMMIT` | [src/shared/orchestration.ts:82](../../src/shared/orchestration.ts#L82) | `process.env.GIT_COMMIT` | not declared at this read |
| `GITHUB_ACTIONS` | [src/shared/orchestration.ts:114](../../src/shared/orchestration.ts#L114) | `process.env.GITHUB_ACTIONS` | not declared at this read |
| `GITHUB_SHA` | [src/gui/routes.ts:1113](../../src/gui/routes.ts#L1113) | `process.env.GITHUB_SHA` | `process.env.GIT_COMMIT` |
| `GITHUB_SHA` | [src/shared/orchestration.ts:82](../../src/shared/orchestration.ts#L82) | `process.env.GITHUB_SHA` | `process.env.GIT_COMMIT` |
| `GOV_MEETINGS_TIMEOUT_MS` | [src/gov_meeting_monitor.ts:374](../../src/gov_meeting_monitor.ts#L374) | `process.env.GOV_MEETINGS_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `GOV_MEETINGS_TIMEOUT_MS` | [src/gov_meeting_monitor.ts:374](../../src/gov_meeting_monitor.ts#L374) | `process.env.GOV_MEETINGS_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `GOV_MEETINGS_TIMEOUT_MS` | [src/gov_meeting_monitor.ts:436](../../src/gov_meeting_monitor.ts#L436) | `process.env.GOV_MEETINGS_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `GUI_STARTUP_TIMEOUT_MS` | [src/browser_smoke.ts:57](../../src/browser_smoke.ts#L57) | `process.env.GUI_STARTUP_TIMEOUT_MS` | `"60000"` |
| `HEADLESS_BROWSER` | [src/browser.ts:41](../../src/browser.ts#L41) | `process.env.HEADLESS_BROWSER` | not declared at this read |
| `HEALER_MAX_CONSECUTIVE_FAILURES` | [src/alerts/healer.ts:114](../../src/alerts/healer.ts#L114) | `envInt("HEALER_MAX_CONSECUTIVE_FAILURES", 3)` | `3` |
| `HEALER_OUTPUT_DIR` | [src/alerts/healer.ts:44](../../src/alerts/healer.ts#L44) | `process.env.HEALER_OUTPUT_DIR` | `outputRoot()` |
| `HEALER_RETRY_BACKOFF_CAP_MS` | [src/alerts/healer.ts:138](../../src/alerts/healer.ts#L138) | `envInt("HEALER_RETRY_BACKOFF_CAP_MS", 4 * 60 * 60 * 1000)` | `4 * 60 * 60 * 1000` |
| `HOME` | [src/browser_smoke.ts:30](../../src/browser_smoke.ts#L30) | `process.env.HOME` | `"~"` |
| `HOME` | [src/browser_smoke.ts:31](../../src/browser_smoke.ts#L31) | `process.env.HOME` | `"~"` |
| `HOME` | [src/browser.ts:53](../../src/browser.ts#L53) | `process.env.HOME` | `""` |
| `LIFEOS_CUSTOMIZATIONS_DIR` | [scripts/lifeos-bridge.ts:19](../../scripts/lifeos-bridge.ts#L19) | `process.env.LIFEOS_CUSTOMIZATIONS_DIR` | `join(home, ".claude", "LIFEOS", "USER", "CUSTOMIZATIONS", "SKILLS", "LocalIntelligence")` |
| `LIFEOS_DATA_DIR` | [scripts/lifeos-bridge.ts:21](../../scripts/lifeos-bridge.ts#L21) | `process.env.LIFEOS_DATA_DIR` | `join(home, ".claude", "LIFEOS", "MEMORY", "DATA", "LocalIntelligence")` |
| `LLM_PREFLIGHT_TIMEOUT_MS` | [src/llm/config.ts:40](../../src/llm/config.ts#L40) | `process.env.LLM_PREFLIGHT_TIMEOUT_MS` | `"5000"` |
| `LLM_PROVIDER` | [src/llm/config.ts:3](../../src/llm/config.ts#L3) | `process.env.LLM_PROVIDER` | `"ollama"` |
| `LOG_LEVEL` | [src/logger.ts:34](../../src/logger.ts#L34) | `process.env.LOG_LEVEL` | `"info"` |
| `MAX_RETRIES` | [src/constants.ts:45](../../src/constants.ts#L45) | `envInt("MAX_RETRIES", 3)` | `3` |
| `NEWS_DISABLED_SOURCES` | [src/news_monitor.ts:62](../../src/news_monitor.ts#L62) | `process.env.NEWS_DISABLED_SOURCES` | `""` |
| `NEWS_FETCH_TIMEOUT_MS` | [src/news_monitor.ts:87](../../src/news_monitor.ts#L87) | `process.env.NEWS_FETCH_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `NEWS_FETCH_TIMEOUT_MS` | [src/news_monitor.ts:167](../../src/news_monitor.ts#L167) | `process.env.NEWS_FETCH_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `NEWS_FETCH_TIMEOUT_MS` | [src/news_monitor.ts:212](../../src/news_monitor.ts#L212) | `process.env.NEWS_FETCH_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `OLLAMA_TIMEOUT_MS` | [src/constants.ts:56](../../src/constants.ts#L56) | `envInt("OLLAMA_TIMEOUT_MS", 30_000)` | `30_000` |
| `OLLAMA_URL` | [scripts/stack-readiness.ts:3](../../scripts/stack-readiness.ts#L3) | `process.env.OLLAMA_URL` | `"http://127.0.0.1:11434"` |
| `OLLAMA_URL` | [src/llm/config.ts:15](../../src/llm/config.ts#L15) | `process.env.OLLAMA_URL` | `"http://localhost:11434"` |
| `OPENROUTER_API_KEY` | [src/llm/index.ts:19](../../src/llm/index.ts#L19) | `process.env.OPENROUTER_API_KEY` | not declared at this read |
| `OPENROUTER_API_KEY` | [src/llm/openrouter.ts:71](../../src/llm/openrouter.ts#L71) | `process.env.OPENROUTER_API_KEY` | not declared at this read |
| `OPENROUTER_API_KEY` | [src/llm/openrouter.ts:272](../../src/llm/openrouter.ts#L272) | `process.env.OPENROUTER_API_KEY` | not declared at this read |
| `OPENROUTER_API_KEY` | [src/llm/openrouter.ts:272](../../src/llm/openrouter.ts#L272) | `process.env.OPENROUTER_API_KEY` | not declared at this read |
| `OPENROUTER_MAX_REQUESTS` | [src/llm/config.ts:34](../../src/llm/config.ts#L34) | `process.env.OPENROUTER_MAX_REQUESTS` | `"100"` |
| `OPENROUTER_MAX_TOKENS` | [src/llm/config.ts:31](../../src/llm/config.ts#L31) | `process.env.OPENROUTER_MAX_TOKENS` | `"1024"` |
| `OPENROUTER_MIN_REQUEST_INTERVAL_MS` | [src/llm/config.ts:49](../../src/llm/config.ts#L49) | `process.env.OPENROUTER_MIN_REQUEST_INTERVAL_MS` | `"3100"` |
| `OPENROUTER_MODEL` | [src/llm/config.ts:28](../../src/llm/config.ts#L28) | `process.env.OPENROUTER_MODEL` | `"inclusionai/ling-3.0-flash:free"` |
| `OPENROUTER_TIMEOUT_MS` | [src/llm/config.ts:37](../../src/llm/config.ts#L37) | `process.env.OPENROUTER_TIMEOUT_MS` | `"120000"` |
| `OPENROUTER_URL` | [src/llm/config.ts:24](../../src/llm/config.ts#L24) | `process.env.OPENROUTER_URL` | `"https://openrouter.ai/api/v1"` |
| `PACFIN_SESSION_COOKIE` | [src/alerts/pacfin.ts:247](../../src/alerts/pacfin.ts#L247) | `process.env[PACFIN_COOKIE_ENV]` | `""` |
| `PAGES_BUILD` | [src/weekly_pipeline.ts:110](../../src/weekly_pipeline.ts#L110) | `process.env.PAGES_BUILD` | not declared at this read |
| `PAGES_OUTPUT_DIR` | [scripts/export-pages.ts:11](../../scripts/export-pages.ts#L11) | `process.env.PAGES_OUTPUT_DIR` | `".pages"` |
| `PAGES_SEED_DIR` | [scripts/export-pages.ts:13](../../scripts/export-pages.ts#L13) | `process.env.PAGES_SEED_DIR` | `"pages-data"` |
| `PAGES_SEED_DIR` | [scripts/refresh-pages-data.ts:7](../../scripts/refresh-pages-data.ts#L7) | `process.env.PAGES_SEED_DIR` | `"pages-data"` |
| `PAGES_SEED_DIR` | [scripts/run-geo-observations.ts:30](../../scripts/run-geo-observations.ts#L30) | `process.env.PAGES_SEED_DIR` | `"pages-data"` |
| `PAGES_SEED_DIR` | [src/gui/routes.ts:626](../../src/gui/routes.ts#L626) | `process.env.PAGES_SEED_DIR` | `"pages-data"` |
| `PLAYWRIGHT_BROWSERS_PATH` | [src/browser_smoke.ts:29](../../src/browser_smoke.ts#L29) | `process.env.PLAYWRIGHT_BROWSERS_PATH` | not declared at this read |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | [src/browser.ts:47](../../src/browser.ts#L47) | `process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE` | `undefined` |
| `PLAYWRIGHT_EXECUTABLE_PATH` | [src/browser_smoke.ts:25](../../src/browser_smoke.ts#L25) | `process.env.PLAYWRIGHT_EXECUTABLE_PATH` | not declared at this read |
| `PORT` | [src/browser_smoke.ts:49](../../src/browser_smoke.ts#L49) | `process.env.PORT` | `"3999"` |
| `PORT` | [src/gui/server.ts:11](../../src/gui/server.ts#L11) | `process.env.PORT` | `"3000"` |
| `PUSH_CONTACT_EMAIL` | [src/notifications/push.ts:19](../../src/notifications/push.ts#L19) | `env("PUSH_CONTACT_EMAIL")` | not declared at this read |
| `PUSH_CONTACT_EMAIL` | [src/notifications/push.ts:49](../../src/notifications/push.ts#L49) | `env("PUSH_CONTACT_EMAIL")` | not declared at this read |
| `PUSH_PRIVATE_KEY` | [src/notifications/push.ts:19](../../src/notifications/push.ts#L19) | `env("PUSH_PRIVATE_KEY")` | not declared at this read |
| `PUSH_PRIVATE_KEY` | [src/notifications/push.ts:23](../../src/notifications/push.ts#L23) | `env("PUSH_PRIVATE_KEY")` | not declared at this read |
| `PUSH_PRIVATE_KEY` | [src/notifications/push.ts:51](../../src/notifications/push.ts#L51) | `env("PUSH_PRIVATE_KEY")` | not declared at this read |
| `PUSH_PRIVATE_KEY` | [src/notifications/push.ts:62](../../src/notifications/push.ts#L62) | `env("PUSH_PRIVATE_KEY")` | not declared at this read |
| `PUSH_PUBLIC_KEY` | [src/notifications/push.ts:19](../../src/notifications/push.ts#L19) | `env("PUSH_PUBLIC_KEY")` | not declared at this read |
| `PUSH_PUBLIC_KEY` | [src/notifications/push.ts:19](../../src/notifications/push.ts#L19) | `env("PUSH_PUBLIC_KEY")` | not declared at this read |
| `PUSH_PUBLIC_KEY` | [src/notifications/push.ts:23](../../src/notifications/push.ts#L23) | `env("PUSH_PUBLIC_KEY")` | not declared at this read |
| `PUSH_PUBLIC_KEY` | [src/notifications/push.ts:48](../../src/notifications/push.ts#L48) | `env("PUSH_PUBLIC_KEY")` | not declared at this read |
| `PUSH_PUBLIC_KEY` | [src/notifications/push.ts:57](../../src/notifications/push.ts#L57) | `env("PUSH_PUBLIC_KEY")` | not declared at this read |
| `PUSH_PUBLIC_KEY` | [src/notifications/push.ts:62](../../src/notifications/push.ts#L62) | `env("PUSH_PUBLIC_KEY")` | not declared at this read |
| `PUSH_SUBSCRIBER` | [src/notifications/push.ts:17](../../src/notifications/push.ts#L17) | `env("PUSH_SUBSCRIBER")` | not declared at this read |
| `PUSH_SUBSCRIBER` | [src/notifications/push.ts:23](../../src/notifications/push.ts#L23) | `env("PUSH_SUBSCRIBER")` | not declared at this read |
| `PUSH_SUBSCRIBER` | [src/notifications/push.ts:62](../../src/notifications/push.ts#L62) | `env("PUSH_SUBSCRIBER")` | not declared at this read |
| `RATE_LIMIT_MS` | [src/constants.ts:33](../../src/constants.ts#L33) | `envInt("RATE_LIMIT_MS", 2000)` | `2000` |
| `REPO_OUTPUT_DIR` | [scripts/lifeos-bridge.ts:16](../../scripts/lifeos-bridge.ts#L16) | `process.env.REPO_OUTPUT_DIR` | `outputRoot()` |
| `RERANK_ENABLED` | [src/llm/config.ts:77](../../src/llm/config.ts#L77) | `process.env.RERANK_ENABLED` | not declared at this read |
| `RERANK_TOP_N` | [src/llm/config.ts:80](../../src/llm/config.ts#L80) | `process.env.RERANK_TOP_N` | `"5"` |
| `SCRAPE_TIMEOUT_MS` | [src/constants.ts:36](../../src/constants.ts#L36) | `envInt("SCRAPE_TIMEOUT_MS", 60_000)` | `60_000` |
| `SOURCE_DISCOVERY_LIVE_CHECK` | [src/weekly_pipeline.ts:262](../../src/weekly_pipeline.ts#L262) | `process.env.SOURCE_DISCOVERY_LIVE_CHECK` | not declared at this read |
| `SOURCE_DISCOVERY_TIMEOUT_MS` | [src/source_registry.ts:443](../../src/source_registry.ts#L443) | `process.env.SOURCE_DISCOVERY_TIMEOUT_MS` | `SOURCE_FETCH_TIMEOUT_MS` |
| `SOURCE_FETCH_TIMEOUT_MS` | [src/shared/source_health.ts:25](../../src/shared/source_health.ts#L25) | `positiveEnvNumber("SOURCE_FETCH_TIMEOUT_MS", 10000)` | `10000` |
| `SOURCE_FRESHNESS_WINDOW_MS` | [src/shared/source_health.ts:26](../../src/shared/source_health.ts#L26) | `positiveEnvNumber("SOURCE_FRESHNESS_WINDOW_MS", 24 * 60 * 60 * 1000)` | `24 * 60 * 60 * 1000` |
| `SPA_RENDER_MS` | [src/constants.ts:42](../../src/constants.ts#L42) | `envInt("SPA_RENDER_MS", 1500)` | `1500` |
| `VERIFY_SAMPLE_SIZE` | [src/constants.ts:49](../../src/constants.ts#L49) | `envInt("VERIFY_SAMPLE_SIZE", 5)` | `5` |
| `WEEKLY_DEADLINE_MS` | [src/weekly_pipeline.ts:66](../../src/weekly_pipeline.ts#L66) | `process.env.WEEKLY_DEADLINE_MS` | `3_600_000` |
| `YT_DLP_TIMEOUT_MS` | [src/youtube_monitor.ts:61](../../src/youtube_monitor.ts#L61) | `process.env.YT_DLP_TIMEOUT_MS` | `'45000'` |

Dynamic reads (not an assertion of finite variable coverage):

- [src/alerts/healer.ts:99](../../src/alerts/healer.ts#L99): `process.env[key]`
- [src/constants.ts:14](../../src/constants.ts#L14): `process.env[key]`
- [src/notifications/push.ts:5](../../src/notifications/push.ts#L5): `process.env[name]`
- [src/shared/source_health.ts:21](../../src/shared/source_health.ts#L21): `process.env[name]`

# Scraping Module

The scraping pipeline consists of four modules that work together to extract municipal code from ecode360.com.

## `src/browser.ts` — Browser Management

Manages the Playwright browser lifecycle with anti-detection measures for Cloudflare Turnstile bypass.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `launchBrowser` | `() → Promise<BrowserContext>` | Launches Chromium (non-headless) with custom user agent and automation detection disabled. Returns singleton context. |
| `closeBrowser` | `() → Promise<void>` | Closes context and browser, resets singletons. |
| `navigateWithCloudflare` | `(page, url, opts?) → Promise<void>` | Navigates to URL, waits for Cloudflare challenge markers to clear, then waits for SPA render. |
| `newPage` | `() → Promise<Page>` | Creates a new page with `webdriver=false` injected via `addInitScript`. |

### Anti-Detection

- User agent: Chrome 131 on macOS
- `--disable-blink-features=AutomationControlled` launch arg
- `navigator.webdriver` overridden to `false`
- Non-headless mode (visible browser window)

---

## `src/toc.ts` — Table of Contents

Fetches and processes the TOC tree from the ecode360 API.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `fetchToc` | `(page) → Promise<TocNode>` | Navigates to the code page, intercepts the `/toc/CR4919` API response, returns the parsed TOC tree. |
| `flattenToc` | `(node) → TocNode[]` | Re-exported from `utils.ts`. Recursively flattens the TOC tree into a flat array. |
| `getArticlePages` | `(toc) → TocNode[]` | Returns all scrapable page nodes: article-type nodes plus chapters that directly contain sections (no intermediate articles). |
| `getSections` | `(toc) → TocNode[]` | Returns all section-type nodes from the tree. |
| `tocSummary` | `(toc) → string` | Multi-line human-readable summary with type counts and municipality name. |

### TOC Node Types

| Type | Scrapable? | Description |
|------|-----------|-------------|
| `code` | No | Root node |
| `division` | No | Top-level grouping |
| `chapter` | Sometimes | If has direct section children |
| `article` | Yes | Primary scrapable pages |
| `part` | No | Intermediate grouping |
| `subarticle` | No | Intermediate grouping |
| `section` | No | Leaf content nodes |

---

## `src/content.ts` — Content Extraction

Scrapes individual article pages and extracts section content from the DOM.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `scrapeArticlePage` | `(page, article) → Promise<ArticlePage>` | Navigates to article page, extracts all sections. Falls back to deep-scraping individual section pages for subarticle layouts. |

### Extraction Strategy

1. **Standard mode**: Article page inlines all section content as `.section_content.content` divs
2. **Deep mode**: Subarticle layout — if no sections found on article page, individually scrapes each section page at `ecode360.com/{sectionGuid}`

### Internal Functions

| Function | Description |
|----------|-------------|
| `getSectionGuids` | Recursively collects section GUIDs from a TOC node tree |
| `scrapeSectionPage` | Scrapes a single section page for deep-scrape mode |

The orchestrator rejects an article when extraction is empty, partial, or does
not match the current TOC section GUID set. A challenge page, selector drift,
or a truncated response therefore remains a retryable failure instead of
becoming a plausible-looking empty artifact.

---

## `src/scrape.ts` — Scraper Orchestrator

Main entry point for the scraping pipeline. Orchestrates TOC fetching, article scraping, and manifest management.

### Workflow

1. **TOC**: Fetch the live TOC by default; use `bun run scrape -- --cached-toc` for an explicit cached-only run. A failed live fetch may fall back to a validated cached TOC. Use `bun run scrape -- --full-rescrape` to bypass the resume cache and re-fetch every article.
2. **Identify**: Find all scrapable article pages via `getArticlePages()`
3. **Scrape**: Visit each article page, extract content via `scrapeArticlePage()`
4. **Validate**: Require a complete current-TOC section set and verify the raw-HTML SHA-256 before an artifact is eligible for resume-skip
5. **Save**: Atomically write per-article JSON and the manifest after each article
6. **Retry**: Re-attempt failed articles with a fresh browser page and exponential backoff
7. **Finalize**: Close browser, report summary

### Resume Support

The manifest (`output/manifest.json`) tracks completed articles, the TOC
fingerprint/source, and the last run. Re-running the scraper skips an article
only when its manifest hash, on-disk hash, artifact shape, and exact current
TOC section set all agree. Corrupt, partial, stale, or TOC-drifted artifacts
are automatically re-scraped. Old article files are left recoverable when a
live TOC removes a node, while stale manifest entries are pruned.

Every JSON write uses a temporary file followed by an atomic rename. This
prevents an interrupted process from leaving a truncated TOC, article, or
manifest that a later run would mistake for valid state.

### Rate Limiting

All requests are rate-limited to 1 per `RATE_LIMIT_MS` (2000ms). Deep-scrape mode uses half the rate limit between section pages. `MAX_RETRIES` is the number of additional retries after the initial attempt, so the default permits up to four total attempts per article.

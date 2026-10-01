# Scraping Module

The scraping pipeline consists of four modules that work together to extract municipal code from ecode360.com.

## `src/browser.ts` — Browser Management

Manages the Playwright browser lifecycle with anti-detection measures for Cloudflare Turnstile bypass.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `launchBrowser` | `(options?) → Promise<BrowserContext>` | Returns the context owned by the current output root; respects caller cancellation and retries retained cleanup before replacement. |
| `closeBrowser` | `(options?) → Promise<ProcessShutdownReceipt \| null>` | Stops the owned process group, confirms direct-child reaping and group disappearance, and retains failed cleanup for retry. |
| `navigateWithCloudflare` | `(page, url, opts?) → Promise<void>` | Navigates to URL, waits for Cloudflare challenge markers to clear, then waits for SPA render. |
| `newPage` | `(options?) → Promise<Page>` | Creates a page with `webdriver=false` and records its owning session. |
| `withPageDeadline` | `(page, operation, timeoutMs, parent?) → Promise<T>` | Bounds the operation and cleanup; force-stops only the page's authenticated owning session. Caller-owned pages grant no authority over another browser. |

### Owned recovery

`src/browser_launcher.ts` retains a private launcher identity before Playwright's
protocol handshake. Dead-controller recovery requires the matching root, token,
private identity and an actual process-group leader. The kernel's executable
path must match the canonical current Bun binary, and the first two structured
arguments must be the exact interpreter and wrapper script. Caller-supplied
argument text or a wrapper path used as ordinary data cannot authorize signaling.

Active pre-protocol launcher shutdown uses the same kernel/argument admission as
dead-controller recovery. Only factory-registered launcher objects are admitted;
their captured executable, root, token and parent identity govern bounded private
owner reads. A caller-supplied PID callback cannot replace that authority.
Repeated watchdog calls share one in-flight cleanup. Cleanup has its own finite
signal and remaining budget so an interrupted producer does not prevent cleanup
authentication. A failed termination remains retryable and preserves the retained
launcher. Both active termination and recovery refuse an absent `owner.json`:
an unknown PID cannot authorize signaling, successful cleanup, durable recovery
promotion or removal of the private namespace. The durable receipt, wrapper and
private identity remain available for investigation and retry. For an admitted
owner, success requires actual PID and group disappearance. Explicit factory
disposal of a known never-spawned unused launcher is a separate operation; it
does not establish process shutdown.

On Linux, bounded `/proc` stat and NUL-separated argument reads plus the kernel
`exe` path replace the external `ps` dependency. New launcher receipts record the
kernel start time; recovery checks that identity and repeats the stat read around
argument and executable capture to reject crossed process generations.

On macOS, built-in Bun FFI calls `proc_pidpath` with a 4 KiB buffer and
`KERN_PROCARGS2` with a 64 KiB buffer. Only the first two NUL-delimited arguments
are decoded; trailing environment bytes are never decoded, logged or persisted. Bounded
`ps` supplies only PID/group identifiers, never command text as authority.
Unsupported, oversized or mismatched identity data fails closed and preserves
the receipt. A changed interpreter path across restart also remains refused.

A vanished argument record, missing native identity, zombie or signaling
permission error is not proof of death and does not grant signaling authority.
Recovery waits at most one second for both the recorded PID and its group to
disappear; otherwise it fails and preserves the evidence. A vanished leader with
live descendants cannot become a successful recovery. Missing private identity
and ambiguous or substituted processes remain refused. These are recovery
contracts; the current release's hosted and native execution results belong in
its separately scoped acceptance receipt.

### Anti-Detection

- User agent: Chrome 131 on macOS
- `--disable-blink-features=AutomationControlled` launch arg
- `navigator.webdriver` overridden to `false`
- Visible browser by default; `HEADLESS_BROWSER=1` enables headless operation

---

## `src/toc.ts` — Table of Contents

Fetches and processes the TOC tree from the ecode360 API.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `fetchToc` | `(page) → Promise<TocNode>` | Navigates to the code page, intercepts the `/toc/CR4919` API response, returns the parsed TOC tree. |
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

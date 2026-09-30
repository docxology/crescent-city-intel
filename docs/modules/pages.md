# GitHub Pages snapshots

`src/pages_snapshot.ts` builds the public static artifact used by
`.github/workflows/pages.yml`. It is intentionally separate from the local
Bun GUI: GitHub Pages cannot reach the local API, Ollama, or ChromaDB.

## Build locally

```bash
bun run pages:export -- --source output --seed pages-data --output .pages
bun run pages:validate -- .pages
PAGES_SMOKE_DIR="$PWD/.pages" bun test tests/lane5-render-smoke.test.ts -t 'lane 5: exported pages render cleanly' --timeout 120000
```

`pages-data/` is a tracked, reviewed public seed containing the last verified
municipal-code JSON, TOC, manifest, and backward-compatible geo-intel contract.
Refresh the code artifacts after a successful scrape, verification, and export
with `bun run pages:seed`; live source-health and monitor artifacts still come
from the current deployment run.

The generated `.pages/` directory can be previewed with a static server. The
exporter validates a sibling staging tree before promotion. An owner/token lease
and durable journal make an interrupted writer recoverable; prior bytes remain
in a rollback directory. A failed stage leaves the active publication intact.
This is process-interruption evidence, not a claim of arbitrary power-loss atomicity.

The explicit `PAGES_SMOKE_DIR` browser command renders those exact saved bytes
without rebuilding the tree. It checks all nine exported pages in Chromium,
script/console failures, populated render targets, and overflow at four viewport
widths. Normal deterministic suite execution builds a separate six-article
reviewed-text fixture; that fixture check does not replace acceptance of the
final full publication. Actions runs the exact-artifact command before uploading
the unchanged directory.

## Local directory

`data/directory.json` (`crescent-city-directory/v1`) is a source-cited
directory of local establishments: government, schools, healthcare,
restaurants, churches, retail, services, finance, media, lodging, and
attractions. `directory.html` renders it with pull-down category menus
(counts injected from the artifact), sort, and text filter. The reviewed
seed is `pages-data/directory.json`; validation runs through
`src/directory.ts` (`buildDirectoryArtifact`), and `tests/directory.test.ts`
holds every seed entry to the same rules the export uses: a public source URL,
valid row/count/category invariants, and optional editorial `consultedAt`/
`reviewedAt` dates that remain `null` when unknown. Generation time or URL
reachability does not establish field verification. Credential URLs and private
literal hosts fail the export.

## Public artifact

The export contains the dashboard, JSON snapshot, source-health artifact, the
fingerprinted source registry/discovery artifacts, and
`data/geo-intel.json`. The geo artifact matches the additive `/api/geo-intel`
shape: the top-level `crescent-city-geo-intel/v1` contract remains compatible
with existing consumers and its `view` field carries the
`crescent-city-geo-view/v1` bounds, anchor, nominal hazard-domain features, and
section references. It is built from the reviewed seed or the same in-repo pure
builders, so no network, API key, tiles provider, or local service is required.
The companion `data/geo-observations.json` carries the selected recorded hazard-observation
envelope (`crescent-city-geo-observations/v1`): the composite severity banner,
one operational chip per alert monitor, and the freshness of the upstream
geo-intel contract. It is ALWAYS emitted — when no valid envelope exists for
the edition, an explicit `crescent-city-geo-observations-unavailable/v1`
envelope (`available: false`) keeps the dashboard's fetch from 404ing rather
than shipping silence. Validation is fail-closed: schema, anchor, composite,
monitor, and freshness fields are checked offline plus a 64 KiB byte ceiling,
and the `#observations` section must embed the panel. The masthead nav and
breadcrumbs are generated from the canonical `PAGES_SECTION_NAV` list,
including Observations; `tests/pages-nav.test.ts` pins the authored
markup against the generated nav so the two cannot drift, and the JSON-LD
dataset catalog lists the observations artifact (8 entries).

The export also includes the municipal code JSON/TOC/manifest plus
verification, coverage, and readability artifacts when available, recent
deduplicated news and government meeting items, YouTube video metadata,
Triplicate metadata and
links only, alert current snapshots and composite severity, the shared
`analytics-overview.json` when the pipeline has generated it, and the latest
monthly report.

In GitHub Actions the municipal candidate is collected in job-owned temporary
storage, with a total 18 minute scrape→verify→export budget and forced cleanup of
its process group on timeout. It stays separate from the live-feed `output/`
directory. `--municipal-source` passes an eligible candidate to publication;
failed collection selects the entire reviewed tracked seed. With no municipal
TOC/manifest beside feeds, `PAGES_BUILD=1` records the weekly live code monitor
as not run instead of trying to read a partial failed scrape. Other source
outages remain explicit; crashed required pipeline stages fail the job.

The core bundle is code JSON, TOC, manifest, and verification report from one
directory, plus optional coverage/readability from that directory. Fresh output
requires all required verification planes and exact manifest/TOC byte hashes plus
a recomputed canonical exported-article hash including section text/history.
Matching raw HTML metadata alone is insufficient. Reviewed historical seed
fallback remains visibly labeled; source verification/export dates are separate
from this build's date.

`publication-input.json` records the selected bundle and its file hashes.
`publication-manifest.json` binds every emitted file and the selected input
receipt. Family DTOs retain display fields and dynamic public maps while omitting
backend additions and operator detail. Core custody files preserve exact bytes;
unknown fields fail their explicit family allowlist. Full-tree checks reject
private paths, credential-bearing URLs, operator-only records, and private
literal service addresses. An empty but valid RSS channel is an honest zero-item
edition. All tree/schema/link/privacy/hash checks precede promotion and unchanged
artifact upload. Hosted Actions/deploy/site success needs its own receipt.

The first viewport is a welcome linktree that routes visitors to local news and
summaries, source registry/health, municipal code, alerts, reports, structured
downloads, and official local source hubs. The dashboard is intentionally interactive despite being static: source health
can be filtered by `ok`, `empty`, `unavailable`, or `stale`; news, meetings,
and curated briefs have a shared text filter; the municipal code export has a
local search box; the source registry can be filtered by automation state and
text, sorted, inspected row-by-row, and exported as filtered JSON or CSV; and
a refresh control re-reads the immutable snapshot without requiring a server.
The overview exposes direct JSON artifact links, a downloadable current
envelope, and the registry fingerprint. The dashboard also supports copying a
selected source record and rendering explicit coverage gaps. The overview
renders pipeline, curation, report, and aggregate health metadata when those
artifacts exist.

The snapshot carries `healthSummary`, report metadata, the latest pipeline run,
the source registry/discovery report, and curation telemetry. These fields explain when an item was collected, which
provider produced a brief, and whether a failure is retryable. The public
export never exposes prompts, chat history, API keys, request logs, or
vector-store contents. Pages validation requires the geo artifact, checks both
schema IDs, EPSG:4326, contract/view count and anchor parity, a 256 KiB size
ceiling, and rejects API-key fields or local-only endpoints entirely offline.

The first viewport also renders the analytics overview headline, deterministic
or LLM summary, evidence fingerprint, key metrics, and the first warning
signals. This gives a clear reading order before visitors browse the larger
news, alerts, code, or report sections.

It deliberately excludes chat history, request/search/RAG logs, Chroma
indexes, credentials, and Triplicate article content. The dashboard labels
`ok`, `empty`, `unavailable`, and `stale` separately. An unavailable source is
not converted into a calm result. The snapshot reports present versus missing
checks and lists the missing names and states; ordinary source gaps do not
reclassify an otherwise complete static export as `degraded`.

The exporter completes the operational health contract defined by
`EXPECTED_SOURCE_HEALTH` in `src/shared/source_health.ts` before writing
`data/snapshot.json`. If a monitor crashes or omits its health file,
the absent source is emitted as a named synthetic `unavailable` coverage
record, so the denominator cannot silently shrink. A monitor that reached a
source and found no matching records remains `empty` and therefore present.

## Deployment

The repository Pages source must be configured as `GitHub Actions` so that
the artifact produced by this workflow is
the site that visitors receive. The workflow runs on pushes to `main`, a
weekly schedule, and manual dispatch. It runs `bun run validate`, then
`bun run weekly-check` with source outages
allowed to remain visible in the output, followed by `pages:export` and
`pages:validate`. GitHub Pages is deployed through the official Pages artifact
and deployment actions with only `contents: read`, `pages: write`, and
`id-token: write` permissions.

The live GUI remains the correct surface for RAG chat and authenticated API
operations. The Pages site is a timestamped public snapshot, not a live
service or a substitute for following the cited source.

## SEO discoverability

The static Pages artifact carries explicit search-engine metadata so the
snapshot is discoverable and attributable without any client-side code:

- **Head metadata** (`src/pages/static/index.html`, head only): a canonical URL
  (`https://quadruplicate.org/`), Open Graph tags (`og:title`,
  `og:description`, `og:type`, `og:url`, `og:site_name`, `og:image`), a Twitter
  `summary_large_image` card, and a JSON-LD `WebSite` script with a
  `GovernmentOrganization` publisher bound to Crescent City, CA.
- **robots.txt** — emitted by `buildPagesRobotsTxt()` in
  `src/pages_snapshot.ts`: an allow-all policy with an explicit sitemap pointer.
- **sitemap.xml** — emitted by `buildPagesSitemapXml()`: the sitemap-0.9
  namespace covering the canonical root and the dedicated pages in
  `PAGES_STATIC_PAGES`.

Each export records `sitemapProvenance` in `data/snapshot.json`, separately
from municipal publication input. The bounded receipt names exactly the sitemap
templates and records their consumed source byte hashes, sizes and captured UTC
filesystem dates. Its explicit `dateOrigin` is
`exporter-template-filesystem-mtime`: checkout mtimes are not evidence of source
content change history. A missing recorded date omits `lastmod`; the build date
is never substituted.

The publication tree hash binds this saved receipt and the sitemap. Validation
requires the receipt, matches its hashes to the same template bytes, and checks
each sitemap date against the recorded valid, nonfuture date. It does not compare
the validator checkout's mtimes. An identical checkout with different timestamps
therefore validates; changed source bytes, corrupted provenance or mismatched
sitemap dates fail. Older exports without this receipt remain unverifiable by
the current provenance check; validation never invents or rewrites their metadata.

## Reader experience

The shared surface (`assets/site.css` + `assets/site.js`, content-hashed at
export) carries a site-wide dark/night theme: `html[data-theme="dark"]`
token overrides in site.css (the `html`-prefixed selector outranks the
`:root` re-declarations in `404.css`), a pre-paint `<head>` snippet on every
page (localStorage `cc-theme`, else `prefers-color-scheme`), and a
Night/Light toggle in the masthead date row wired by `initThemeToggle()`.
The homepage `#observations` board re-checks `data/geo-observations.json`
every 10 minutes while visible and re-renders the composite banner, monitor
chips, and a relative "Live check" line when the producer publishes a newer
envelope — the export-time render remains the fallback truth, and the
`data-observations-state` export contract is untouched. News and Meetings
 desks page through the full list with a "Show 30 more" control instead of
silently capping at 30 records.

## Methods & Provenance and FAQ sections

The index carries two reader-facing trust surfaces, both owned by the Pages
lane:

- **Methods & Provenance** (`#methods`) — static honest copy describing the
  scrape → verify → summarize → export pipeline, what the local LLMs do
  (summaries/tagging over collected material only) and do not do (invent
  facts; unverifiable items are dropped), integrity guarantees, and schema
  versions. The numeric counts in this section are **not hand-authored**: they
  are injected at export time from the exact snapshot manifest through
  `buildPagesMethodsCounts()` + `embedPagesMethodsCounts()`
  (`PAGES_METHODS_COUNTS_PLACEHOLDER`). Exactly one placeholder must exist or
  the exporter throws.
- **FAQ** (`#faq`) — six Q&As about Crescent City civic information and the
  project. The visible text of every question/answer pair matches its
  `FAQPage` JSON-LD block exactly; `scripts/validate-pages.ts` parses **all**
  JSON-LD blocks and fails on any mismatch between structured data and visible
  copy.

An events `.ics` subscribe badge sits in the Community Calendar header,
styled with `--cc`/`--rdark`/`--rtint` palette variables only. The page also
carries a skip link, a `<main id="main">` landmark, and aria-labels on all nav
and filter controls.

Coverage lives in `tests/pages-seo.test.ts` and `tests/pages-theme.test.ts`.

Both files are written into `.pages` by `exportPagesSnapshot()` alongside
`index.html`. `scripts/validate-pages.ts` treats them as required assets: it
checks that robots.txt declares allow-all plus the sitemap pointer and that
sitemap.xml is namespaced, has `<loc>` entries, includes the canonical root,
and that the JSON-LD block parses as JSON with the expected types.

Coverage is pinned by `tests/pages-seo.test.ts` (metadata presence, JSON-LD
parse, exporter emission) on top of the general artifact tests in
`tests/pages_snapshot.test.ts`.

## Pages gate engines (`src/pages_css.ts`, `src/pages_scan.ts`, `src/pages_validation.ts`)

Three offline validators behind `bun run pages:validate`: `pages_css.ts` is the deterministic CSS reader (checks rules a page uses are in stylesheets that page loads, and that rules are syntactically live, not shadowed); `pages_scan.ts` is the lane-0 XSS gate (every `innerHTML =` in an exported page must interpolate through esc()/href() or a provably-safe builder); `pages_validation.ts` carries the release-gate checks for the static snapshot (assets, SEO/JSON-LD, a11y, caching, payload budgets, contrast, calendar honesty, leak gates). All computation lives in these modules; the scripts stay thin CLIs.

## `src/pages_seed.ts` — Verified Seed Refresh

Copies tracked public seed artifacts from a verified output directory into `pages-data/`, gating on the verification report and parsing every file before it is copied. Invoked by `bun run pages:seed`.

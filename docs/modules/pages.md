# GitHub Pages snapshots

`src/pages_snapshot.ts` builds the public static artifact used by
`.github/workflows/pages.yml`. It is intentionally separate from the local
Bun GUI: GitHub Pages cannot reach the local API, Ollama, or ChromaDB.

## Build locally

```bash
bun run pages:export -- --source output --seed pages-data --output .pages
bun run pages:validate -- .pages
```

`pages-data/` is a tracked, reviewed public seed containing the last verified
municipal-code JSON, TOC, and manifest. Refresh it after a successful scrape,
verification, and export with `bun run pages:seed`; live source-health and
monitor artifacts still come from the current deployment run.

The generated `.pages/` directory can be previewed with any static server, for
example `cd .pages && python3 -m http.server 4173`, then open
`http://localhost:4173/`. The exporter is atomic: it builds a temporary
directory and replaces the exact destination only after all files are ready.

## Public artifact

The export contains the dashboard, JSON snapshot, source-health artifact, and
the fingerprinted source registry/discovery artifacts,
the municipal code JSON/TOC/manifest plus verification, coverage, and
readability artifacts when available, recent deduplicated news
and government meeting items, YouTube video metadata, Triplicate metadata and
links only, alert current snapshots and composite severity, and the latest
monthly report.

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
vector-store contents.

It deliberately excludes chat history, request/search/RAG logs, Chroma
indexes, credentials, and Triplicate article content. The dashboard labels
`ok`, `empty`, `unavailable`, and `stale` separately. An unavailable source is
not converted into a calm result, and a snapshot with unavailable or stale
sources is marked `degraded`.

## Deployment

The workflow runs on pushes to `main`, a weekly schedule, and manual dispatch.
It runs `bun run validate`, then `bun run weekly-check` with source outages
allowed to remain visible in the output, followed by `pages:export` and
`pages:validate`. GitHub Pages is deployed through the official Pages artifact
and deployment actions with only `contents: read`, `pages: write`, and
`id-token: write` permissions.

The live GUI remains the correct surface for RAG chat and authenticated API
operations. The Pages site is a timestamped public snapshot, not a live
service or a substitute for following the cited source.

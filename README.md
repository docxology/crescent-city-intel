# Crescent City Intel — The Quadruplicate

Thin regional orchestration for Crescent City and Del Norte County, California.
All shared methods, source adapters, tests, OpenAPI, module documentation and
manuscript tooling live in [region-intel](https://github.com/docxology/region-intel).
This repository owns its regional configuration, reviewed public seed and
publication at [quadruplicate.org](https://quadruplicate.org).

```sh
bun install --frozen-lockfile
bun run validate
bun run gui
bun run source-discovery
bun run weekly-check
bun run pages:export
bun run pages:validate -- .pages
```

`scripts/region.ts` imports the pinned shared runner. `region.json` selects the
Crescent identity, monitor policy and enabled roster. No generic implementation
is copied here. Shared documentation is at
[region-intel/docs](https://github.com/docxology/region-intel/tree/main/docs).
The retained evidence-bound reference manuscript moved with its tooling to
[region-intel/docs/manuscript](https://github.com/docxology/region-intel/tree/main/docs/manuscript).
Its recorded claims are scoped to the original Crescent edition.

Local release checks and consumer integration are separate from live source
availability, legal currency, native manuscript rendering and hosted delivery.
Live collections may produce unavailable/stale records. A reviewed seed is not
current legal advice. Optional model chat requires configured Ollama/Chroma or
OpenRouter services. See `.env.example` and the shared configuration guide.

The full pre-extraction history remains in this repository's Git history.

# Crescent City Intel — The Quadruplicate

Thin regional orchestration for Crescent City and Del Norte County, California.
All shared methods, source adapters, tests, OpenAPI, module documentation and
manuscript tooling live in [region-intel](https://github.com/docxology/region-intel).
This repository owns its regional configuration, reviewed public seed and
publication at [quadruplicate.org](https://quadruplicate.org).

## Fresh clone and accepted public edition

```sh
git clone https://github.com/docxology/crescent-city-intel.git
cd crescent-city-intel
bun install --frozen-lockfile
bun run validate
bun run pages:export
bun run pages:validate -- .pages
```

The tracked accepted seed contains 245 article pages and 2206 sections
from eCode360 `CR4919`. See [edition bindings](docs/edition.md) for verification
time and hashes. A clean clone can build that static edition without a new
scrape or model service. Local GUI corpus search needs separately acquired and
promoted raw articles; see [acquisition](docs/acquisition.md).

Use the [documentation index](docs/README.md) and [operations guide](docs/operations.md)
for command scope, troubleshooting and hosted delivery. The public GitHub
repository is marked `private: true` in `package.json` to prevent accidental
package-registry publication; that flag does not make the GitHub repository private.

## Regional commands

```sh
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

See the [accepted municipal edition and exact input hashes](docs/edition.md) and
[acquisition/promotion procedure](docs/acquisition.md).

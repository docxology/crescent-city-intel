# Regional orchestration

`package.json` pins the shared platform. `scripts/region.ts` invokes it.
`region.json` binds regional identity, provider policy, monitored sources and
consumer-owned roots. Implementation and generic documentation are maintained
once in [region-intel](https://github.com/docxology/region-intel).

## Owned files and roots

| Path | Responsibility |
| --- | --- |
| `region.json` | Active `region-deployment/v1` configuration |
| `region.candidate.json` | Same municipality with a separate acquisition root |
| `configs/` | Civic identity and regional provider policy |
| `scripts/region.ts` | Import and argument forwarding to the installed shared runner |
| `tests/` | Consumer admission, configuration and cross-region rejection |
| `pages-data/` | Tracked reviewed public seed and exact input/verification receipts |
| `output/`, `.corpus-candidates/`, `.pages/` | Ignored runtime, acquisition and export artifacts |
| `.github/workflows/` | Consumer acceptance, source collection and Pages delivery |

The [shared deployment contract](https://github.com/docxology/region-intel/blob/main/docs/deployments.md)
records compatibility versus regional command routing. The [documentation index](README.md)
also links the exact installed revision's docs.

The consumer gate checks strict importer types, configuration and cross-region
rejection against the installed package. The shared full gate checks the core
implementation. Live availability and hosted delivery need separate receipts.

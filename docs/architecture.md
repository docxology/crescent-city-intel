# Regional orchestration

`package.json` pins the shared platform. `scripts/region.ts` invokes it.
`region.json` binds regional identity, provider policy, monitored sources and
consumer-owned roots. Implementation and generic documentation are maintained
once in [region-intel](https://github.com/docxology/region-intel).

The consumer gate checks strict importer types, configuration and cross-region
rejection against the installed package. The shared full gate checks the core
implementation. Live availability and hosted delivery need separate receipts.

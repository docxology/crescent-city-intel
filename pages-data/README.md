# Public Pages seed

This directory contains the reviewed, public municipal-code seed used when a
GitHub Actions checkout has no local `output/` directory. It contains only
public generated artifacts: the consolidated code export, TOC, manifest,
passing verification report, coverage, readability data, and the backward-
compatible `geo-intel.json` contract. The Pages exporter derives the map-ready
view from that reviewed contract and publishes the combined API-shaped surface
as `.pages/data/geo-intel.json`.

Refresh only after a successful scrape, verification, and export:

```bash
bun run pages:seed
```

The refresh script refuses to copy data unless
`output/verification-report.json` has `overallStatus: "pass"`. Live news,
meetings, alerts, YouTube, Triplicate metadata, curation, and reports are
collected separately by the Pages workflow and retain their own health states.

## Directory seed (hand-curated)

`directory.json` is the one hand-curated exception to the regenerate rule: the
verified local-establishments directory (government, schools, healthcare,
restaurants, churches, retail, services, finance, media, lodging, attractions)
consumed by `src/directory.ts` and rendered on `directory.html`. Every entry
carries the URL its facts were verified against; fields that could not be
verified are `null`, never guessed. Edit it by hand, then run
`bun test tests/directory.test.ts` — every entry must pass the same validation
the export uses.

The public Pages snapshot also carries the source registry and discovery report.
Discovery-only sources are displayed as `not-checked` until a dedicated
connector writes source health; the export never turns an unmonitored source
into an implied healthy result. Triplicate remains citation/reference-only.

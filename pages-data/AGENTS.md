# pages-data — agent notes

Published snapshot data bundle (verified: crescent-city-code.json,
domain-coverage.json, event_sources.json, geo-intel.json, manifest.json,
readability.json, toc.json, verification-report.json + README.md, plus the
HAND-CURATED directory.json seed — the one exception to the regenerate rule:
directory.json is maintained by hand, every entry carrying the URL its facts
were verified against (unverified fields stay null). Consumed by src/pages/static
and validated by src/directory.ts + tests/directory.test.ts.

# AGENTS.md — crescent-city-intel/src/domains

Domain coverage for the intel platform.
- `coverage.ts` — computes per-domain municipal-code coverage; entry point
  `bun run src/domains/coverage.ts`, writes `output/domain-coverage.json`.
- `scholarly_context.ts` — maps `crescent_city` manuscript chapters to the
  quadruplicate geo-intelligence domains and geographic features, enabling
  cross-linking between the manuscript and quadruplicate.org pages.
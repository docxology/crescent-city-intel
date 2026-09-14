# TODO

This file is the item-level backlog: one entry per genuinely open item, each
with an acceptance criterion. Strategic direction lives in
[docs/roadmap.md](docs/roadmap.md); shipped work is recorded in
[CHANGELOG.md](CHANGELOG.md). Do not journal completions here — closed items
move to the CHANGELOG entry for their release.

## Open

- 🔴 **New monitors: permits, dredging, fuel** (USCG broadcasts shipped
  2026-09-08 as monitor #15; the rest need live-source connectors and an
  owner decision on data budgets). AC: each monitor wired into the
  `run-alerts` batch with offline fixture tests and honest source-health
  states.
- 🟡 **Marine expansion: PacFIN landing data + AIS vessel tracking** (same
  live-source/owner-budget prerequisite). AC: bounded fetches with offline
  fixtures; absent data is an explicit empty state, never a fabricated
  reading.
- 🟡 **Genuinely per-article incremental re-embedding** — partially shipped:
  `indexAllSections` (`src/llm/embeddings.ts`) skips the rebuild only when the
  whole-corpus chunk fingerprint is unchanged; any single changed article
  still re-embeds the entire corpus. AC: one changed article re-embeds only
  that article's chunks and deletes its stale ones.
- 🟢 **Deferred GUI/UX set** — Phase 2 tooltips + cross-reference
  hyperlinking; Phase 7 plain-language rewrite; Phase 9 AQ widget, wildfire
  map, annotation overlays; Phase 10 ordinal refinement, legal-citation/CA/US
  cross-linking, effective-date field; Phase 14 docs/modules dashboard and
  structured-query pages. AC: each surface ships with an explicit empty state
  and a string-contract (or browser-smoke) test.
- 🟢 **Docs: keep the architecture diagram and API reference in sync with
  each release.** AC: after every version bump, `docs/architecture.md` and
  `docs/api-reference.md` pass the doc-inventory / route-contract gates
  unchanged.
- 🟢 **State the geo-observations envelope schema once** — the shape is declared
  independently in `src/geo_observations.ts` interfaces, `validatePagesGeoObservations`
  (`src/pages_snapshot.ts`), and the inline OpenAPI response schema, and the
  validator's error strings are pinned verbatim in `tests/pages-nav.test.ts`.
  AC: one authority (or an automated cross-check) proves the three statements
  agree before `bun run validate` passes.

---
_Open set audited against the implemented tree 2026-09-14. `bun run validate`
reports current test and contract counts._

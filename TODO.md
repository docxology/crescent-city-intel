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
- 🟡 **Genuinely per-article incremental re-embedding** — **Closed 2026-09-28.**
  `indexAllSections` skipped the rebuild only when the whole-corpus chunk
  fingerprint was unchanged, so any single changed article re-embedded the entire
  code. The decision logic now lives in `src/llm/index_plan.ts` as a pure,
  offline-testable planner: on this corpus (238 articles, 3,105 chunks) a
  one-article edit re-embeds that article's chunks — 131 at worst, 4.2% — and an
  untouched corpus costs nothing. The planner also carries a `configSignature`
  over the embedding model and chunking parameters, so a model swap forces a
  full re-embed; without it, a per-article fingerprint would still match and the
  collection would silently hold two models' geometry in one cosine space.
  Tests: `tests/index-plan.test.ts` (fixtures) and
  `tests/index-plan-corpus.test.ts` (measured against the real scrape).
- 🟢 **Docs: keep the architecture diagram and API reference in sync with
- 🟢 **Deferred GUI/UX set** — Phase 7 plain-language rewrite; Phase 9 AQ
  widget, wildfire map, annotation overlays; Phase 10 ordinal refinement,
  legal-citation/CA/US cross-linking, effective-date field; Phase 14
  docs/modules dashboard and structured-query pages. AC: each surface ships
  with an explicit empty state and a string-contract (or browser-smoke) test.
  **Cross-reference hyperlinking (Phase 2) shipped 2026-09-28; Phase 14
  shipped 2026-09-28** — the docs/modules dashboard (`/docs-dashboard.html`
  + `GET /api/docs/modules`, derived from the tree) and the structured-query
  page (`/structured-queries.html`); the rest are unchanged.
- ✅ **The analytics-backend tests are cheap again** — closed 2026-09-28.
  `getCodeStats` reads every article through `loadAllArticles()`, and over the
  real 2,206-section corpus each overview build cost ~65s, so the two overview
  tests were the suite's bottleneck by an order of magnitude: one missed its
  120,000ms ceiling under full-suite parallelism and failed while passing in
  isolation; the other built three overviews (~196s) against a 300s ceiling and
  also failed. Neither failure was real — both were contention against timeouts
  tuned on an unloaded machine. Note the failed detour: raising the 300s timeout
  to 480s made it *worse*, turning a 300s failure into a 480s one.
  `withMinimalCorpus(articleCount, body)` now seeds everything except
  `articles/` — which is what the fingerprint is actually computed over — and
  copies only a handful of articles. Both tests: **196s → 31s**, under the
  ordinary 30s per-test timeout with no raise. The corpus was never what they
  asserted; one only checks `first == repeat` and `changed != first`.
- 🟢 **Docs: keep the architecture diagram and API reference in sync with
  each release.** **Closed 2026-09-28** — partly. `tests/docs-sync.test.ts`
  now asserts `docs/architecture.md`'s prose monitor count against
  `MONITOR_KEYS`, checks every monitor is named in it, and pins the per-directory
  `AGENTS.md` files. That check found a real gap: the diagram named modules
  (`ndbc_marine.ts`) but not the source-health names operators actually see
  ("NDBC Marine"), so a mapping table was added, together with the note that the
  composite's `monitors` record uses a third vocabulary for air quality.
  **Still open:** `docs/api-reference.md` is a MODULE EXPORT reference, not a
  route catalogue, and the TODO's original premise that it should be is not
  satisfiable without creating a third hand-maintained copy of the route table to
  drift. The spec (`openapi.yaml`) is the authority and the release gate proves
  spec↔implementation in both directions. What the reference needed was not to
  list routes but to SAY that it does not, so it now points at the spec; a test
  asserts it never advertises a route the spec does not publish, and another
  asserts its route rows stay a small minority so nobody "fixes" it by pasting
  the table in. Remaining genuine work: a generated route index served from the
  spec, if a human-readable one is ever wanted.
- 🟢 **Keep the monitor rosters derived, not restated** — the recurring defect
  class behind the 2026-09-26/27 correctness passes. **Closed 2026-09-28:**
  `tests/alert-source-roster.test.ts` derives every roster from `MONITOR_KEYS`,
  including the SPA's hand-written maps; the OpenAPI alert-type enum is checked
  by `bun run validate`; and `MONITOR_PRIORITY` is now exported and asserted
  for coverage. `MONITOR_PRIORITY` is deliberately NOT derived — its order
  encodes a judgement about consequence that no mechanical rule carries — so the
  check is membership, and the test also pins its first and last entries. That
  check found a live vocabulary mismatch: the composite's `monitors` record
  spells air quality `airQuality` where every monitor key says `airquality`.
  `SEVERITY_MONITOR_KEYS` now names the record's vocabulary and a test proves the
  two describe the same set modulo that one declared alias.
- 🟢 **State the geo-observations envelope schema once** — **Closed 2026-09-28.**
  The shape was declared independently in `src/geo_observations.ts`,
  `validatePagesGeoObservations`, and the inline OpenAPI response schema, with
  the validator's error strings pinned verbatim in `tests/pages-nav.test.ts`.
  `tests/geo-observations-contract.test.ts` now proves the three agree: it reads
  the OpenAPI property list out of the spec and compares it to a real built
  envelope, asserts the validator accepts that envelope and rejects each field
  when blanked, and checks the two schema literals match. A negative control
  (deleting `hazardSummary` from the spec) was used to confirm the check fails
  when it should — an earlier draft of it passed vacuously on an empty
  extraction.

---
_Open set audited against the implemented tree 2026-09-28. The two items marked
🔴/🟡 as blocked need live-source connectors plus an owner decision on data
budgets, so they are untouched. `bun run validate` reports current test and
contract counts._

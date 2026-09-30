# Open improvement scopes

Updated 2026-09-30 from the implemented source tree and native acceptance.
This is the only item-level backlog. Completed repairs belong in
[CHANGELOG.md](CHANGELOG.md); they are removed from this file. The
[current-state review](docs/project-review.md) records operating contracts
and verification boundaries, and the [roadmap](docs/roadmap.md) sequences the
remaining work. Each entry describes the remaining acceptance, rather than
repeating a repaired defect as future work.

Size describes engineering scope, not urgency: **minor** is localized,
**medium** crosses contracts or modules, and **major** requires staged design
and evaluation. **P1** protects evidence or execution boundaries, **P2**
stabilizes usefulness, and **P3** depends on source/access decisions. Assign
one implementation owner and an independent reviewer for shared infrastructure
or security changes. Re-estimate from the next reproduction; no estimate is a
delivery commitment.

## Minor

### S07 · P2 · Generate documentation drift checks across all current guidance

- **Lane/evidence:** Documentation; src/doc_inventory.ts, src/manuscript_document.ts and tests/doc-inventory.test.ts.
- **Scope:** Extend the qualified module and command checks to configuration variables, selected public exports, operational setup examples and generated HTTP documentation. Keep CHANGELOG and frozen ISA outside current guidance.
- **Acceptance/failures:** Mutating a real command, configuration variable, export or route description fails with its filename; dated history remains valid.
- **Dependencies:** M34 and L01; preserve the strict application and independent test typechecking lanes.


## Medium

### M04 · P1 · Complete browser acquisition cancellation

- **Lane/evidence:** Transport/browser; src/shared/transport.ts, src/shared/subprocess.ts, src/browser.ts.
- **Scope:** Finish the browser-specific process ownership and cooperative cancellation audit across navigation, setup and retries. Reuse the existing finite HTTP and child-process budgets.
- **Acceptance/failures:** A real stalled navigation and Chromium descendant terminate and are reaped within one parent deadline; retries and setup cannot extend that deadline.
- **Dependencies:** M08 and M33; preserve provider-specific behavior and source custody.

### M06 · P2 · Exercise every alert subset through the real runner

- **Lane/evidence:** Alerts; src/alerts/batch.ts and tests/run-alerts.test.ts.
- **Scope:** Add fixture-backed singleton acceptance for all twenty producers and representative mixed subsets, including missing and failed sources.
- **Acceptance/failures:** Every selected producer persists a current attempt; omitted producers keep their original observation age; a failed old snapshot cannot contribute current severity. Unknown and empty selection fail clearly.
- **Dependencies:** M08, M31 and M33; use real local HTTP and captured artifacts.

### M07 · P2 · Finish healer restart and delivery integration

- **Lane/evidence:** Alerts; src/alerts/healer.ts, src/alerts/batch.ts and notification receipts.
- **Scope:** Validate the advisory retry roster through restart, backoff expiry and accepted notification transitions. Keep retry eligibility distinct from actual producer execution.
- **Acceptance/failures:** First failure, repeated failure, recovery, restart and expiry retain accurate current-cycle state; unsuccessful notification delivery never suppresses retry.
- **Dependencies:** M06 and M33; browser push display requires an opted-in external acceptance.

### M08 · P1 · Complete the producer ownership acceptance matrix

- **Lane/evidence:** Runtime; src/shared/paths.ts, src/shared/data.ts and output-root tests.
- **Scope:** Cover every reader/writer, reload and subprocess under the shared root, including overlapping same-root and different-root runs.
- **Acceptance/failures:** Each producer writes only to its declared root; in-flight loads and caches cannot satisfy another root; same-root writers serialize without losing updates or stealing leases. The actual output fence stays unchanged on success and failure.
- **Dependencies:** M04, M06, M24 and M33; no save/restore fixtures in the real corpus.

### M21 · P1 · Enforce byte limits at the Chroma SDK boundary

- **Lane/evidence:** Vector runtime; src/llm/chroma.ts, src/llm/runtime.ts and src/api/admission.ts.
- **Scope:** Add a response-byte adapter for SDK operations and bounded admission for direct analytical SDK consumers, extending the existing deadline/cancellation and HTTP request admission contracts.
- **Acceptance/failures:** A real oversized or slow vector response stops before unbounded buffering; direct callers, cold concurrent calls and cancelled requests release capacity within their parent budget.
- **Dependencies:** M08 and L03; preserve staged serving collection completeness.

### M24 · P2 · Complete operator recovery and rollback acceptance

- **Lane/evidence:** Artifacts; src/output_migrations.ts, src/publication_bundle.ts and src/corpus_editions.ts.
- **Scope:** Exercise the supported multi-artifact migration/recovery procedure with interrupted promotion, disk-write failure and operator rollback. Keep immutable originals and precise byte receipts.
- **Acceptance/failures:** Restart identifies incomplete work; rollback restores the exact prior complete tree; historical timestamps and unavailable evidence never become fresh observations.
- **Dependencies:** M08, M30 and M33; live refresh and migration remain separate evidence planes.

### M25 · P2 · Preserve recurrence, cancellation and timezone evidence

- **Lane/evidence:** Calendar; src/events.ts and src/event_discovery.ts.
- **Scope:** Extend civil/Pacific date and publication-versus-occurrence contracts to explicit ICS recurrence, cancellation, TZID and floating-time rules.
- **Acceptance/failures:** Leap days, DST transitions, recurring cancellations and unknown time have reviewed fixtures; publication or upload timestamps cannot produce an occurrence or calendar entry. Unsupported recurrence stays explicit.
- **Dependencies:** L05 and L07; acquire representative primary calendar records before claiming coverage.

### M26 · P2 · Normalize trends for sampling and source coverage

- **Lane/evidence:** Analytics; src/insights.ts and src/analytics_backend.ts.
- **Scope:** Extend unique activity/revision counts and corrupt-input diagnostics to cadence-normalized windows and changed source coverage.
- **Acceptance/failures:** Repeated snapshots do not inflate activity; revisions remain distinct; irregular polling, corrupt history and empty windows show gaps rather than invented civic trends.
- **Dependencies:** M25, M31 and L07; report denominator and window definitions.

### M27 · P2 · Verify the external LifeOS consumer and visibility contract

- **Lane/evidence:** Bridge; src/lifeos_bridge.ts.
- **Scope:** Verify null dates, source failures and versioned digest receipts with the actual Pulse consumer. Establish whether sequential cross-directory visibility is sufficient or requires a shared activation pointer.
- **Acceptance/failures:** Consumer accepts the declared version; every copy has the same digest hash or recovery restores previous copies. Interrupted visibility is explicitly bounded; no private user state enters public output.
- **Dependencies:** M24 and M33; external private-state changes require separately established ownership.

### M29 · P2 · Complete persistent container and scheduler acceptance

- **Lane/evidence:** Infrastructure; Dockerfile, docker-compose.yml, src/stack_readiness.ts and src/scheduler.ts.
- **Scope:** Extend pinned image/readiness checks to persistent empty-volume backend startup and restart; implement the reviewed scheduler installation and log rotation with preserved unrelated entries.
- **Acceptance/failures:** Missing models degrade truthfully; clean startup and restart reach bounded readiness. Paths with spaces, quotes and XML characters install correctly in isolated fixtures; overlapping jobs retain ownership and unrelated cron/launchd entries survive.
- **Dependencies:** M08, M21 and M33; local native checks do not establish production deployment or scheduler installation.

### M30 · P2 · Unify validation across every artifact family

- **Lane/evidence:** Artifacts; src/directory.ts, src/pages_public.ts and distributed loaders.
- **Scope:** Extend strict directory, corpus, public DTO and source validation into reusable versioned validators for every supported event, health, report and analytics family.
- **Acceptance/failures:** Wrong row types/counts, invalid confidence, unsupported versions and credential/private URLs fail at loader, API and Pages boundaries; unknown facts remain null with provenance.
- **Dependencies:** L01 and M31; introduce one family at a time without weakening existing guards.

### M31 · P1 · Complete cadence-specific observation freshness

- **Lane/evidence:** Sources; src/source_registry.ts, src/shared/source_health.ts and producer observations.
- **Scope:** Finish observedAt/productDate/fetchedAt/validUntil definitions and consumption-time age checks across all source families. Keep stable source identity and HTTP reachability separate from collection.
- **Acceptance/failures:** A login/SPA shell or fresh probe cannot override parser failure; old buoy/product observations remain stale after refetch. Shared endpoints and aliases cannot conceal a failed source. Invalid or future observation times remain unavailable.
- **Dependencies:** M30 and L01; each cadence and validity policy needs source-specific evidence.

### M32 · P1 · Complete outbound boundary and configured-URL audit

- **Lane/evidence:** Acquisition/privacy; src/shared/transport.ts, src/alerts/connector.ts and configured browser/provider paths.
- **Scope:** Inventory the remaining browser and configured-URL persistence boundaries against public DNS/IP/redirect policy and credential redaction.
- **Acceptance/failures:** Private resolution, IPv6, redirects and credential query aliases are denied or handled by the declared provider policy; no configured credential reaches logs or public receipts. Local fixture access remains explicitly injected.
- **Dependencies:** M04 and M30; fresh independent security review for any new boundary.

### M33 · P1 · Complete whole-run cancellation and restart recovery

- **Lane/evidence:** Orchestration; src/weekly_pipeline.ts, src/shared/orchestration.ts, src/shared/storage.ts and src/curation.ts.
- **Scope:** Propagate one cooperative parent deadline through the entire weekly task and all steps, including browser/process ownership; finish interrupted-run and multi-artifact recovery.
- **Acceptance/failures:** Crash before completion retains a durable incomplete attempt; cancellation stops new work and reaps owned descendants. Disk-full and competing writers preserve the last valid state. Recovered summaries remain bound to exact source/model/prompt identity.
- **Dependencies:** M04, M08 and M24; an atomic file does not establish a multi-file transaction.

### M34 · P2 · Generate public export, configuration and route inventories

- **Lane/evidence:** Maintainability; src/doc_inventory.ts, extracted src orchestrators and openapi.yaml.
- **Scope:** Finish declared public export/configuration inventories and generate route documentation from structural OpenAPI, extending the qualified module/command inventory.
- **Acceptance/failures:** An undocumented or wrongly mapped export/configuration/route fails a drift check. CLI flags, diagnostics and supported renderer adapters keep their behavior.
- **Dependencies:** S07 and L01; no additional task ledger.


## Major programs

### L01 · P2 · One runtime contract for API, sources and artifacts

- **Lane/evidence:** Architecture; src/api/contracts.ts, openapi.yaml, source registry and artifact validators.
- **Scope:** Extend structural runtime API validation and source/artifact definitions into authoritative shared definitions used by generated documentation, public route inventory and all loaders. Stage version migrations one family at a time.
- **Acceptance/failures:** Deliberate method/auth/schema/alias drift fails CI. Old clients/artifacts have documented migration; generated schemas preserve strict validation and explicit severity policy.
- **Dependencies:** S07, M30, M31 and M34.

### L02 · P1 · Trace every derived public fact through publication custody

- **Lane/evidence:** Publication; immutable corpus editions, src/publication_bundle.ts and public tree receipts.
- **Scope:** Extend exact code-source, transformation, bundle and output-tree custody to every derived analytics/public fact, with independent replay and reviewed rollback drills.
- **Acceptance/failures:** A public fact resolves to exact input and transformation receipts; partial producers cannot activate mixed editions; remote commit/artifact identity and live URLs are checked separately for each release.
- **Dependencies:** M08, M24 and M33; preserve previous editions and distinguish local, hosted and deployed evidence.

### L03 · P2 · Evaluate semantic support and RAG usefulness

- **Lane/evidence:** RAG; shared retrieval/evidence builder, staged indexes and src/llm/benchmark.ts.
- **Scope:** Broaden the fixed evaluator suite to representative extraction/retrieval questions, dependent sources, negation, stale/poisoned context and user usefulness. Add reviewed semantic support checks without upgrading citation identity to factuality.
- **Acceptance/failures:** Unsupported claims cannot acquire verified-support. Reproducible results name corpus/index/model/configuration, retrieval successes, abstentions, errors and limitations. Literal span presence and source counts cannot establish independent semantic support.
- **Dependencies:** M21, L01 and L06; paid providers need explicit budget ownership.

### L04 · P2 · Complete explicit GUI modules and accessible journeys

- **Lane/evidence:** GUI; local runtime, modular assets and native journey harness.
- **Scope:** Finish replacing classic implicit globals/load-order dependencies and extend keyboard, focus, announcements, loading/error/cancel and mobile acceptance to every reader surface.
- **Acceptance/failures:** Blocked network/storage, delayed/error responses, keyboard-only navigation and mobile layouts work in real browsers; adversarial content remains inert. Stable URLs remain compatible and no framework change occurs without measured benefit.
- **Dependencies:** L01 and M21; retain exact-artifact Pages smoke separately from isolated GUI journeys.

### L05 · P3 · Establish useful local coverage for each additional source

- **Lane/evidence:** Sources; official archive discovery, source registry and src/meeting_documents.ts.
- **Scope:** Establish access terms, geographic/temporal coverage, budget/credential ownership and captured fixtures for local issued permits, landings, vessel observations, County meetings and additional civic feeds. Extend byte/page-bound PDF extraction into reviewed document semantics with explicit OCR uncertainty.
- **Acceptance/failures:** Each connector demonstrates observed local coverage and freshness. Unrelated geography cannot imply absent local traffic; catalogs do not establish availability of regulated records. Missing or inaccessible sources stay explicit.
- **Dependencies:** M04, M30, M31 and L01; source-specific access and spending decisions remain owner gates.

### L06 · P2 · Build reviewed longitudinal amendment evidence

- **Lane/evidence:** Corpus; retained edition manifests, diffs and amendment-year views.
- **Scope:** Extend retained source editions into section addition/removal/renumbering lineage and primary ordinance adoption/effectivity evidence, with a reviewed extraction sample.
- **Acceptance/failures:** Identical input replays identical lineage; asymmetric rename/removal/repeal retains identities. Unsupported legal dates remain unknown; source changes yield a reviewable update rather than automatic legal conclusions.
- **Dependencies:** L02, M24 and L05; the latest recorded amendment year is not a legal effective date.

### L07 · P3 · Measure civic event, directory and trend coverage

- **Lane/evidence:** Civic products; calendar, provenance-checked directory and unique activity/revision analytics.
- **Scope:** Add reviewed recurrence/cancellation and directory field currency, cadence-aware trends, correction ownership and additional commissions/calendar sources after coverage review.
- **Acceptance/failures:** Readers distinguish occurrence, publication, field review and generated time. Changing sampling or source coverage cannot masquerade as a trend; disputed fields have an owned correction route.
- **Dependencies:** M25, M26, M30, M31 and L05; current seeds do not establish comprehensive regional coverage.

### L08 · P2 · Independently reproduce research and release evidence

- **Lane/evidence:** Research; claim ledger, hydrated manuscript, native renderer/backend and external geo acceptance.
- **Scope:** Extend measured local rendering, consumer/backend acceptance and fixed benchmark receipts into independent clean-checkout replay and reviewed extraction/retrieval evaluations. Bind paper claims to the precise release snapshot.
- **Acceptance/failures:** Declared deterministic hashes/metrics reproduce within stated bounds; paper, provider, external consumer, hosted workflow and deployed site each have distinct receipts. No software/proof/hash test establishes legal, factual or safety efficacy.
- **Dependencies:** L02, L03 and L06; CHANGELOG remains the only version history.

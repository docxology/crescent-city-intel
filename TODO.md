# Open acceptance scopes

Updated 2026-10-02 for the v3.3.1 operating contracts, including checked GitHub
guidance, bounded County acquisition and tested shared civic-profile methods.
This is the only item-level backlog. It contains acceptance that requires real
source access, external consumers, independent interpretation or production
operation.
Implementation descriptions and measured receipts live in the
[current-state review](docs/project-review.md) and module guides; release
history lives only in [CHANGELOG.md](CHANGELOG.md). The
[roadmap](docs/roadmap.md) gives the delivery sequence without duplicating tasks.

Size describes the remaining work, not urgency. **Medium** crosses an external
integration or operating boundary; **major** requires representative collection
and independent evaluation. **P1** protects evidence and operations, **P2**
establishes usefulness, and **P3** depends on access or staffing decisions.
Name an implementation/operator owner and an independent reviewer before
security, shared infrastructure or private-state changes. Authorization for
software development does not establish source access rights, reviewer identity,
a paid-provider budget or permanent service operation.

## Medium

### M07 · P2 · Accept notification delivery at an opted-in destination

- **Existing contract:** Restart-safe healer eligibility, cycle identity, backoff and bounded retry/delivery receipts; real local encrypted Web Push and webhook protocol fixtures.
- **Remaining evidence:** An operator-owned subscription or webhook destination receives the intended transition, with actual browser/recipient display, failure/retry and recovery checked.
- **Acceptance:** Record destination class, opt-in, exact transition and receipt identity without publishing credentials or personal destination state. Failed delivery cannot suppress a later retry. A local HTTP acknowledgement is not a recipient-display receipt.
- **Ownership/dependencies:** Destination owner and independent reviewer; preserve M29 operational ownership and private subscription state.

### M27 · P2 · Accept the committed digest in the actual private Pulse consumer

- **Existing contract:** Versioned digest copies, retained exact-byte versions and a hash-bound commit pointer; `readCommittedDigest` rejects corrupt versions and avoids partially replaced latest files.
- **Remaining evidence:** The actual external Pulse reader uses the committed contract and renders source failures, unknown dates and the same activated digest identity.
- **Acceptance:** Record named consumer revision and digest hash, test an interrupted update and recovery, and confirm private consumer state stays outside public artifacts. A producer or local reader fixture does not establish the external app's behavior.
- **Ownership/dependencies:** Private consumer owner; establish the precise files and permission before modifying that external checkout or personal state.

### M29 · P1 · Accept persistent operation on the intended production host

- **Existing contract:** Pinned container profiles, readiness diagnostics, owned scheduler files and activation controls, bounded idle log rotation, whole-run cancellation and exact-byte recovery.
- **Remaining evidence:** The selected host's actual scheduler activation, service restart, model/volume persistence, resource limits and backup/restore procedure over repeated scheduled runs.
- **Acceptance:** Record host/runtime/image identities, declared timezone, installed job identity, restart and killed-run recovery, retained artifact hashes and observed degraded dependencies. Confirm unrelated jobs/processes survive and no missed or duplicate run is silently hidden.
- **Ownership/dependencies:** Host/operator owner; isolated container and scheduler fixtures certify their tested boundaries, not permanent deployment or every provider.

### M30 · P2 · Accept another explicitly configured civic deployment

- **Existing contract:** Validated immutable public profiles, isolated roots and namespaces, municipal source identity admission, generic geography/calendar/news/coverage methods and profile-bound lexical/vector receipts. Synthetic non-Pacific tests exercise contamination and invalid-configuration failures.
- **Remaining evidence:** A named real municipality with reviewed source/provider descriptors, local domain/legal content, authored public presentation and independently owned scheduler/host plan. Regional hazard/utility/road/fisheries adapters need their actual geographic policy and coverage; they are not enabled by changing labels.
- **Acceptance:** Capture source/seed/configuration fingerprints; verify native indexes, calendar timezone evidence, no cross-jurisdiction records, public artifact/browser/replay identity and distinct scheduler ownership. Validate real provider availability and source rights, and record unsupported capabilities. Synthetic fixtures do not establish deployment or request-level multitenancy.

## Major

### L03 · P2 · Independently assess semantic support and civic usefulness

- **Existing contract:** Versioned retrieval/context evaluations and private claim/source/span-bound annotation packages. The [dated native receipt](docs/evidence/rag-native-2026-10-01.json) records 6/6 applicable listed-section retrieval hits, 6/8 mechanical disposition matches, zero generation errors, and context replay with 16/16 generated answers and 14/16 expected diagnostics. Mismatches remain retained; semantic support, source independence and legal currency remain unassessed.
- **Remaining evidence:** Independent human review of representative source-backed answers, abstentions, negation, quantities, conditions, dependent copies and stale/poisoned context, plus useful reader tasks.
- **Acceptance:** Bind each review to exact corpus/context/answer/model/configuration bytes and named review provenance; record disagreement and failure cases. Imported reviewer labels and literal citation presence cannot establish reviewer identity, factuality, legal currency or independent corroboration.
- **Ownership/dependencies:** Review and evaluation owners; explicit budget ownership before paid providers, and L05/L06 primary-source interpretation where applicable.

### L05 · P3 · Establish source-specific access and observed local coverage

- **Existing contract:** Registry-grounded discovery, official archive/PDF acquisition including the County CivicClerk catalog and typed published-file streams, bounded public transport, primary observation/product clock policies and read-only `bun run source:coverage` assessment.
- **Remaining evidence:** Usable local issued-permit records, actual port/species landings, local vessel observations and any additional civic/County archive records not established by current captures; source terms, geography, time coverage and credential/budget ownership.
- **Acceptance:** Retain representative primary bytes with parser/count/freshness receipts and demonstrate the claimed geographic and temporal unit. MyGov application catalogs do not establish issued permits; PacFIN report catalogs do not establish measured landings; a foreign or empty AIS feed does not establish absent local traffic. Blocked/login/SPA/partial archives stay explicit gaps.
- **Ownership/dependencies:** Source/access owner; no fabricated records, unapproved credentials, subscriptions, scraping rights or completeness claims.

### L06 · P2 · Review primary ordinance adoption and legal lineage

- **Existing contract:** Source-bound retained-edition replay; deterministic addition/removal/renumbering/content candidates; exact primary-document hashes and nullable adoption/effective dates with review reopening on changed bytes.
- **Remaining evidence:** A representative actual primary adopted ordinance sample, independently interpreted and linked to its municipal section identities and express adoption/effectivity evidence.
- **Acceptance:** Keep source identities and asymmetric candidates, bind reviewed spans to exact document SHA and review provenance, and leave unsupported dates/conclusions null. Removal is not repeal; matching text is not legal continuity; latest recorded amendment year is not effective date. The retained proposed Harbor policy is a negative control, not an adopted City ordinance or completed human legal review.
- **Ownership/dependencies:** Qualified review owner and independent reviewer; L05 primary access and exact retained input custody.

### L07 · P3 · Establish field currency and representative temporal coverage

- **Existing contract:** Local directory field/correction ledger, explicit role decisions and changed-source reopening; bounded recurrence/cancellation/timezone evidence; unique activity/revision counts and declared sampling denominators with insufficient-data states.
- **Remaining evidence:** Staffed per-field directory consultation/review, representative primary recurring/calendar notices and longitudinal sampling sufficient for the stated comparison and regional coverage.
- **Acceptance:** Record actual consulted/reviewed source bytes and accountable decisions; unknown fields remain null. Verify occurrence versus publication and cancellation/timezone evidence against primary records. Publish sampling units, missing checks and comparable windows without presenting collection cadence or source expansion as civic or hazard frequency.
- **Ownership/dependencies:** Editorial/source owners; L05 access and M29 repeatable collection. Seed links and generated times do not establish field currency or comprehensive regional coverage.

### L08 · P2 · Independently reproduce the named release and consumer evidence

- **Existing contract:** Versioned family validators, exact derived/source/transform/output receipts, private captured-input replay, strict source/test types, fenced release gate, native browser/backend and research-render commands.
- **Remaining evidence:** A separately owned clean environment reproduces the release's declared deterministic outputs and research metrics, and each intended external consumer exercises its actual integration path beyond any narrower loader-only acceptance.
- **Acceptance:** Name source/lock/template/model/consumer revisions and input/output hashes. Separate deterministic replay from model sampling, extraction/semantic review, hosted checks and live deployment. Preserve missing prerequisites and observed failures; a prior-version receipt or byte-identical static bundle does not certify a new runtime or full package initializer.
- **Ownership/dependencies:** Independent operator/research/consumer owners; L03/L06 interpretation and M29 production conditions remain distinct evidence planes.

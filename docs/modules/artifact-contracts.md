# Shared artifact contracts and derived custody

`src/artifact_contracts.ts` is the versioned persisted-family authority
(`crescent-city-artifact-contracts/v1`). `src/schema_validation.ts` implements
bounded, noncoercing JSON/OpenAPI validation. Loaders, checked API responses and
Pages reuse this authority instead of maintaining separate row-shape rules.

| Family | Persisted schema | Checked invariants |
| --- | --- | --- |
| Events | `crescent-city-events/v1` | Exact row types, explicit null facts, confidence 0..1, occurrence/publication distinction, unique IDs, counts and public source links |
| Source health | `crescent-city-source-health/v1` envelope | Exact row status/count/clocks, unique identities, optional cycle UUID, bounded document hash drift |
| Monthly report | `1.0.0`, `monthly-civic-health` | Reporting period, nonnegative metrics, health/source totals and required provenance |
| Pipeline/weekly/curation reports | `1.0.0` | Exact family fields, step/count/time consistency and explicit provider/run verdicts |
| Analytics overview | `1.0.0` | Code totals, source coverage, alert histogram sums and mirrored metric consistency |
| Directory | `crescent-city-directory/v1` | Row/category/count/identity invariants, nullable editorial dates and public citation URLs |
| Retained lineage | `crescent-city-corpus-lineage/v1` | Source identities, asymmetric candidate sides, counts and explicit document-bound review status |

`validateArtifact(family, value, options)` returns bounded diagnostics;
`assertArtifact` rejects invalid input. `audience: "public"` requires the actual
public family projection: operator errors, paths and private signals are not
accepted. `assertPublicFamilyArtifact` also scans the full projected value for
privacy exposure. Public URL validation rejects credentials, executable schemes,
private literal IPs and credential-bearing fragments; it performs no DNS lookup.

The directory and analytics readers validate before exposing their data.
Pages validates raw source health before completing its canonical missing-source
roster, validates raw supported reports, then checks projected families and the
whole staged artifact. HTTP operations annotated `x-artifact-family` receive
the same family check after OpenAPI response validation. Other HTTP operations
retain their declared OpenAPI schema; the annotation does not pretend all routes
return persisted artifacts. The paginated discovery response is distinct from
the aggregated events artifact.

Retrieval `checkedAt`/`fetchedAt` remain separate from optional observation and
product clocks. Missing `observedAt`, `productDate` or editorial review dates are
never invented. `calendarEvidence` preserves UID, recurrence identity, timezone
and explicit UTC/TZID/floating/date-only basis when source evidence supplies it.
All-day calendar export does not infer a timezone from a floating source time.

## Read migrations

New source-health writers stamp `crescent-city-source-health/v1`. Existing
unversioned envelopes can be read only through the explicit
`allowLegacyHealthEnvelope: true` path; every row/count/date and required
`checkedAt` is still validated. This read policy neither rewrites old receipts
nor labels old observation clocks as newly assessed. Unknown future versions,
malformed known facts and unsupported extra fields fail closed.

Available directory artifacts require the current checked shape. A missing seed
can produce the explicit `crescent-city-directory-unavailable/v1` public
envelope; absence is not an empty verified directory. Missing analytics uses its
separate public unavailable envelope. An unavailable envelope never claims
derived-fact custody for nonexistent rows. Regenerate actual exports from their
retained sources after a contract/transform change; do not fabricate a receipt
for an old artifact or silently revise exported provenance.

## Derived-fact custody

`src/artifact_custody.ts` creates `crescent-city-derived-custody/v1` receipts:
exact output byte count/SHA, exact logical input and transformer membership,
configuration hash, family contract version and a binding hash. Regular-file
capture rejects symlinks, changing captures, invalid bounds and over-budget input.
The caller supplies the deterministic replay function; receipt JSON executes
nothing. `replayArtifactCustody` checks bindings and requires replayed output
bytes to match the retained output.

The directory exporter captures the actual seed bytes and fixed directory,
contract, URL-policy, package and lockfile authority. It writes
`data/directory-custody.json` beside `data/directory.json`; staged validation
replays from that seed and checks source/transform/configuration/output hashes.
Copying the directory to another checkout preserves the receipt only when those
source and transformer bytes match. Programmatic validators can explicitly name
the same retained seed through `sourceDirectorySeedPath`; its private local path
is not included in public metadata.

The derived producer retention module archives actual inputs, transformations,
configuration and output privately and refuses an input-edition change during
computation. These receipts are separate from municipal publication eligibility
and sitemap exporter-mtime provenance. Hashes and deterministic replay establish
byte identity and transformation reproducibility. They do not prove extraction
correctness, semantic entailment, comprehensive coverage, human review, adoption
or legal effectivity.

`tests/artifact-contracts.test.ts` exercises malformed types/dates/counts/URLs and
actual loader round trips. `tests/artifact-custody.test.ts` exercises bounded
filesystem capture, exact replay and real Pages export with recomputed tree
hashes after source, transformer, configuration and output tampering.

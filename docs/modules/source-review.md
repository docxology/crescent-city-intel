# Retained lineage, field review and source coverage

`src/corpus_lineage.ts` compares retained municipal editions only after checking
the edition file hashes, exact manifest/TOC membership and raw HTML/parsed
section custody. Filesystem admission uses a remaining aggregate byte budget;
the reader does not allocate every file before deciding that an edition is too
large. `captureCurrentLineageEdition` constructs a read-only, in-memory edition
from current files and checks the manifest/TOC again before accepting it.

`buildCorpusLineage` preserves source article/section GUIDs. It emits addition,
removal, same-identity renumbering, retitling and content-change candidates.
Matching text under different GUIDs creates an identity candidate while retaining
both the actual removal and addition. All candidates begin pending with a null
legal conclusion. Missing membership is not repeal; cross-GUID text equality is
not proof of legal continuity. Deterministic asymmetric fixtures cover these
distinctions rather than manufacturing a legal interpretation.

Primary evidence carries its actual document SHA, public source URL, media type,
document kind and explicit nullable adoption/effective dates. A reviewed date
requires the same source hash, owner, review time and literal retained span.
Changed bytes reopen review and clear legal dates. Meeting records and proposals
cannot acquire ordinance dates through this contract. A literal matching span
still does not prove legal entailment or document authority; interpretation and
human legal review remain separate work.

`buildCorpusLineageWithCustody` binds exact before/after edition bytes, source
documents, optional retained extraction text, transformer bytes and configuration.
The [local evidence receipt](../evidence/lineage-local-2026-09-30.json) records an
actual retained-to-current replay and a native PDF extraction negative control.
Its timestamps and hashes describe that run. It does not claim a current upstream
refetch, a human legal review or a future final release gate.

County primary documents can also be acquired through the approved CivicClerk
published-file notices documented in [monitoring](monitoring.md#county-civicclerk-acquisition).
The bounded event window and exact extensionless PDF route supply source access
and extraction evidence; they do not turn meeting minutes into an adopted City
ordinance or certify the meaning of provider timestamps. Proposed and adopted
legal conclusions still require their own document-bound interpretation.

## Directory field currency and corrections

`src/directory_review.ts` builds a local ledger bound to the exact directory.
Each name/category/address/phone/website/description starts unreviewed with null
source SHA, consultation and review times. A seed citation, build timestamp or
reachable URL does not verify a field.

`proposeDirectoryCorrection` retains a public source URL, exact source hash and
literal evidence span without editing the directory. An explicit
`directory-editor` role decision is bound to the pending correction and the same
source bytes. Accepted changes rebuild and validate directory identities and
category counts; duplicate identities and unsafe URLs fail. Changed retained
source bytes reopen field review. The local ledger and owner decisions are not
automatically transferred to Pages or represented as completed human review.
This provides a correction contract; scheduling, human staffing and comprehensive
per-entry currency require actual operational evidence.

## Read-only coverage assessment

```bash
bun run scripts/source-coverage.ts
CC_OUTPUT_DIR=/path/to/retained-output bun run scripts/source-coverage.ts
```

The command writes nothing and performs no network requests. It projects the
current canonical source registry and bounded retained permit/PacFIN/AIS reports,
including each exact report SHA and source identity. Corrupt existing files fail;
missing files retain null facts and `not-assessed` status.

| Source family | Collected unit | Fact still outside that collection |
| --- | --- | --- |
| City MyGov permits | Application-type catalog entries | Issued permits and issued-site geography |
| PacFIN | Public report-catalog definitions | Executed port/species landing measurements |
| AIS | Feed positions inside the declared Del Norte watch box | Comprehensive local vessel traffic or provider coverage |

The default foreign AIS feed yields `local-coverage-unavailable` rather than local
calm. A configured feed declaring local coverage is labeled
`source-declared-local-sample` only when the shared AIS primary-observation clock
is usable; stale/missing primary timestamps have explicit statuses and cannot
become current available traffic through a fresh fetch. The report includes the
actual clock basis and maximum age. Future retrieval timestamps fail. A usable
local sample does not prove provider completeness.
No credential inspection occurs. The primary-document portion explicitly leaves
adoption/effectivity unknown and requires document-bound review. Read-only local
assessment closes the mechanics for enumerating these gaps; it does not supply
missing sources, access rights, adopted ordinances or verified local field facts.

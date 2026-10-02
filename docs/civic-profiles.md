# Reusable civic methods and jurisdiction configuration

Crescent City remains the deployed platform. Shared methods now consume a
validated `civic-profile/v1` contract rather than silently importing its identity
and policy. This establishes tested reuse with synthetic non-Pacific profiles;
it does not establish another city's live sources or a fully portable deployment.

`src/civic_profile.ts` owns the public configuration schema. It rejects unknown
fields, control characters, credential-bearing URLs, unsupported providers,
invalid IANA timezones, malformed coordinates/bounds and reused Crescent
namespaces. Profile values are deeply immutable and have a canonical SHA-256.
Local output paths, credentials, notification destinations and private consumer
state belong in runtime configuration, outside this public contract.

The default profile retains the existing Crescent City code identifier, corpus
filenames, calendar UIDs, vector namespace, source roster and integration schema
aliases. Set `CIVIC_PROFILE` to a bounded regular JSON file to select another
profile. The loader reads it once per process; restart after editing it.
`withCivicProfile` and `withOutputRoot` provide captured asynchronous contexts for
importable methods and offline acceptance, without mutating global environment.

```bash
bun run civic:profile
CIVIC_PROFILE=configs/example-civic.json bun run civic:profile
```

[The example](../configs/example-civic.json) is explicitly synthetic, has no
municipal-code provider or regional sources, and cannot publish the Quadruplicate.
It demonstrates another timezone, geography, calendar identity and vector
namespace. It is not a real municipality's configuration or operational receipt.
Alternate producers need an explicit isolated `CC_OUTPUT_DIR` or owned output
context. The first writer binds an empty root to the profile fingerprint;
different profiles and unbound retained data are refused. Changing configuration
requires a new root or an explicitly reviewed migration; no implicit relabelling
or root takeover is provided.

Importable producers accept `ProducerOptions.leaseWaitMs` for same-producer
contention (default 5,000 ms; integer 0–60,000 ms). Admission is capped by the
remaining parent deadline and honours caller cancellation. Zero requests an
immediate busy decision. This wait does not extend acquisition or publication
budgets, and a live owner's lease is never taken over.

| Boundary | Reusable behavior | Explicit locality policy |
| --- | --- | --- |
| Acquisition and custody | Bounded transport, deadlines, byte caps, leases, transactions, extraction/input/output hashes | Approved provider origins, tenant descriptors, terms and source coverage |
| Municipal code | Selected ecode360 municipality identifier; approved origin; cached corpus identity checked before replacement/export | ecode360 extraction protocol; other code providers need an adapter |
| Geography | Complete validated anchors, empty domain surfaces, contract/map/observation projection and independent export roots | Crescent curated domains, section references and hazard intent; generic inputs never inherit them |
| Events | Selected civil-day timezone, explicit source instant conversion, stable distinct calendar UIDs and product identity | Missing/floating source timezone remains uncertain; local calendar discovery is a Crescent adapter |
| News | Explicit feeds, keywords and HTML fallback policy; effective relevance reaches extraction; bounded source-health evidence; canonical names require reviewed endpoints and custom feeds own independent IDs | Default Crescent feeds and keywords apply only to the default profile; feed URLs do not establish local coverage |
| Source inventory | Explicit registry injection, region labels, canonical fingerprints and source-ID custody | Default reviewed roster and historical aliases describe Crescent City; alternate default roster is empty |
| Coverage and analysis | Injected sections/domain surfaces; alternate analytics has no Crescent seed fallback | Regional legal references, scholarly context, severity thresholds and demographic interpretation |
| Search and vectors | Profile/root-owned BM25 indexes; bounded context cache; profile-bound vector namespace, config signature, manifest and metadata | English stemmer/legal synonym policy; independent namespaces remain an operator responsibility |
| Publication | Exact profile captured in Pages replay configuration and snapshot identity; core bundle source identity admission | Authored Quadruplicate GUI/Pages, regional weekly pipeline and scheduler require the exact Crescent profile |

The public contract's capability roster admits supported shared methods; it is
not permission to activate an unconfigured regional adapter. The twenty current
hazard/operational monitors retain explicit Crescent/California/coastal scope.
Their parsers and bounded transport can be reused through reviewed provider
descriptors, but setting another display name cannot establish a forecast zone,
buoy station, road jurisdiction, fisheries regime, utility service area or AIS
coverage. Regional producers, the regional weekly/alert batches and private digest writer fail
before acquisition or transfer for alternate profiles. The analytics-overview
producer remains regional; shared statistical and coverage methods can receive
explicit inputs.

Pure geography builders accept explicit `MunicipalitySpec` values. An explicit
empty domain list stays empty. Nondefault schemas are `civic-geo-intel/v1`,
`civic-geo-view/v1` and `civic-geo-observations/v1`, with explicit profile or anchor
identity; frozen Crescent integration aliases stay available. Foreign malformed
anchors cannot fall back to Crescent coordinates. Exporting another profile
requires physically independent seed/output roots; tracked Crescent seeds and
their filesystem aliases are protected.

Index receipts bind profile ID, profile SHA-256 and vector namespace. A foreign
or corrupt serving receipt cannot select a collection, and foreign retrieved
metadata is rejected. Existing unbound Crescent receipts retain a narrowly
scoped compatibility path; the next complete staged index records identity.
Profile/configuration changes alter the index signature. A lexical cache key
includes both the captured root and profile fingerprint, so interleaved loads
cannot overwrite another context's index. These method-level contexts are not
a claim of authenticated request-level multitenancy.

The offline acceptance files are `tests/civic-profile.test.ts`,
`tests/civic-geography-calendar.test.ts` and
`tests/civic-profile-news-index.test.ts`. They exercise real modules, owned
temporary files, real local HTTP vector/feed services and bounded child
processes: invalid configuration; empty-domain/geography controls; non-Pacific
midnight/DST and calendar identity; wrong-root/corpus/seed/receipt refusal;
custom news relevance; and interleaved corpora sharing IDs but differing in text.
They do not substitute for native Chroma/model or live alternate-source evidence.

Another deployed civic platform requires reviewed provider descriptors and local
domain content, municipality-specific presentation and scheduler ownership,
independent namespace/root admission, and actual source/host/publication
acceptance. The open acceptance scope belongs in [TODO.md](../TODO.md), alongside
the existing live-source, human interpretation and production-operation scopes.

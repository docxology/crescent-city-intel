# Geo-Observations Module

## `src/geo_observations.ts` — GEO-INFER hazard-observation interface

Builds the `crescent-city-geo-observations/v1` envelope: the LIVE hazard-state
companion to the frozen `crescent-city-geo-intel/v1` contract
(`src/geo.ts`, `docs/modules/geo-intel.md`). Where the contract answers
"what is the municipal hazard-policy surface", this envelope answers "what is
the current hazard state" — the composite alert severity snapshot, per-monitor
source health, a per-tag hazard summary projected from the contract's
hazard-relevant domain subset, and the upstream contract's freshness.

Data honesty is the core rule: absent artifacts surface as honest empty
states (`composite: null`, `monitors: []`, `contractGeneratedAt: null`) —
never invented values, never a fabricated CALM.

## Envelope shape

```json
{
  "schema": "crescent-city-geo-observations/v1",
  "anchor":   { "name", "guid", "municipality", "county", "state", "latitude", "longitude" },
  "generatedAt": "<ISO-8601, passed into the builder — never Date.now() inside>",
  "composite": { "level", "reason", "assessedAt", "hasUnavailableMonitors" } | null,
  "monitors": [ { "id", "label", "status", "checkedAt", "itemCount?", "ageMs?", "url?" } ],
  "hazardSummary": [ { "tag", "domainCount", "topicCount" } ],
  "freshness": { "contractSchema": "crescent-city-geo-intel/v1", "contractGeneratedAt": "<ISO>|null" }
}
```

- `monitors[].status` is one of the four operational states (`ok`, `empty`,
  `unavailable`, `stale`), lower-cased; an unrecognized value degrades to
  `unavailable` (state could not be established).
- `monitors[].id` is a stable slug of the source label (`"NOAA Tsunami"` →
  `"noaa-tsunami"`); `ageMs` is rounded to whole milliseconds.
- `hazardSummary` is sorted by tag for deterministic output.

## Data flow

```
src/geo_observations.ts (pure builders — no I/O, no clock)
    ▲
scripts/run-geo-observations.ts (thin orchestrator; `bun run geo:observations`)
    ├── output/alerts/composite/current.json  → composite (normalizeCompositeSnapshot)
    ├── output/alerts/source-health.json      → monitors (normalizeMonitorObservation)
    └── pages-data/geo-intel.json             → anchor + hazard subset + contractGeneratedAt
    → writes pages-data/geo-observations.json AND output/geo-observations.json
      (atomic temp+rename via writeJsonAtomic; exits non-zero on write failure only)
```

Missing inputs are a VALID empty-state run — the runner never fails because an
alert artifact is absent.

## GEO-INFER adoption (BAYES / ACT / RISK)

The load pattern mirrors
`geo_infer_bayes.civic_intel.load_crescent_city_intel`: read the JSON artifact
at its documented path and consume the envelope fields directly — no scraping,
no recomputation.

```python
# GEO-INFER-BAYES style adoption
from geo_infer_bayes.civic_intel import load_crescent_city_intel  # existing contract loader
import json

with open("pages-data/geo-observations.json") as fh:
    observations = json.load(fh)

assert observations["schema"] == "crescent-city-geo-observations/v1"
level = observations["composite"]["level"] if observations["composite"] else None
tags  = { s["tag"]: s for s in observations["hazardSummary"] }   # weight map layers by hazard intent
fresh = observations["freshness"]["contractGeneratedAt"]          # join against the geo-intel contract
```

Keep the schema id frozen: external mappers key on
`crescent-city-geo-observations/v1` exactly as they do on
`crescent-city-geo-intel/v1`.

## Drift guard (`bun run geo:sync-check`)

`scripts/check-geo-sync.ts` is a deterministic drift guard over the contract:

1. **Contract rebuild check** — rebuilds the contract with the pure builder
   (`buildMunicipalityContract(getDefaultCrescentSpec())`) and compares the
   stable fields (`schema`, `anchor`, `domainCount`, `domains`, `hazard` —
   NOT the clock-stamped `generatedAt`) against `pages-data/geo-intel.json`.
   Any difference **exits 1**.
2. **Bundled copy check** — when
   `../GEO-INFER/GEO-INFER-BAYES/src/geo_infer_bayes/crescent-city-geo-intel.json`
   exists (or `CRESCENT_CITY_INTEL_BUNDLED_PATH` overrides the path), it
   sha256-hashes both payloads and reports byte identity. Bundled drift
   prints a loud `BUNDLED COPY DRIFT` line but **exits 0** so CI can decide
   policy.

The comparison logic (`compareRebuiltContract`, `compareBundledCopy`) is
exported and tested against tmp files
(`tests/geo-observations.test.ts`).

## Exports

| Export | Purpose |
| :--- | :--- |
| `buildHazardObservations(input)` | Pure envelope builder (route surface: `GET /api/geo-observations`) |
| `normalizeCompositeSnapshot(raw)` | Defensive artifact → `CompositeSnapshot \| null` |
| `normalizeMonitorObservation(health)` | `SourceHealth` → public monitor entry |
| `hazardTagSummary(domains)` | Per-tag aggregation over the hazard subset |
| `monitorId(source)` | Stable slug id derivation |
| `DEFAULT_OBSERVATION_ANCHOR` | Crescent City point-identity anchor fallback |
| `GEO_OBSERVATIONS_SCHEMA`, `GEO_INTEL_CONTRACT_SCHEMA` | Frozen schema ids |

## Dependencies

- `src/geo.ts` — `CRESCENT_CITY_ANCHOR` (frozen contract; never modified here).
- `src/types.ts` — `SourceHealth`, `SourceHealthStatus`.
- `src/shared/source_health.ts` — `writeJsonAtomic` (runner only).
- `src/shared/paths.ts` — `outputRoot()` (runner only).

## Tests

`tests/geo-observations.test.ts` — deterministic and offline: envelope shape,
empty states, normalization (status casing, `ageMs` rounding), hazard
aggregation from an inline fixture, sync-check comparisons on tmp files, and
a runner smoke over real artifact fixtures inside the output-corpus fence.

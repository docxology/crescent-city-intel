# Results {#sec:results}

## Snapshot inventory

The run-specific analytics artifact was generated at {{SNAPSHOT_DATE}}. Its
input fingerprint was {{ANALYTICS_FINGERPRINT}}, and the overview status was
{{ANALYTICS_STATUS}}. The current artifact therefore describes one observed
state of the repository outputs; it is not a timeless property of Crescent
City.

| Surface | Observed value |
|---|---:|
| Municipal-code article pages | {{CODE_ARTICLES}} |
| Municipal-code sections | {{CODE_SECTIONS}} |
| Municipal-code words | {{CODE_WORDS}} |
| Canonical registry records | {{REGISTRY_COUNT}} |
| Monitored sources | {{MONITORED_COUNT}} |
| Discovery-only sources | {{DISCOVERY_ONLY_COUNT}} |
| Reference-only sources | {{REFERENCE_ONLY_COUNT}} |
| Source records: ok | {{SOURCE_OK}} |
| Source records: empty | {{SOURCE_EMPTY}} |
| Source records: unavailable | {{SOURCE_UNAVAILABLE}} |
| Source records: stale | {{SOURCE_STALE}} |
| Historical alert events | {{ALERT_EVENTS}} |
| Curated LLM briefs | {{CURATED_BRIEFS}} |

: Run-snapshot inventory from output/state/analytics-overview.json. Values are hydrated at render time; they are not manually maintained. {#tbl:snapshot_inventory}

The inventory demonstrates why a single “data available” boolean is
insufficient. In the current snapshot, a user can see successful observations,
successful zero-result queries, and unavailable feeds as separate populations.
The source registry also includes sources that are known but not yet connected
to a dedicated parser. Discovery is therefore visible without being mistaken
for collection. The complete run inventory is reported in
[@tbl:snapshot_inventory].

## Worked example: unavailable is not calm

The current source envelope records EPA AirNow as unavailable when its API key
is absent and CAL FIRE as unavailable when its endpoint returns HTTP 403. The
operational record is qualitatively different from an empty NOAA tsunami
response:

~~~json
{
  "source": "EPA AirNow",
  "status": "unavailable",
  "itemCount": 0,
  "error": "AIRNOW_API_KEY env var not set"
}
~~~

The empty tsunami record means that the request completed and no qualifying
active event was returned. It does not prove that every tsunami-related fact
is absent from the world; it only describes the bounded query. The analytics
overview propagates unavailable and stale states into warning signals, and its
summary explicitly states that an unavailable feed cannot establish calm.

## Worked example: composite alert state

The rendered snapshot reports {{ALERT_LEVEL}} with reason “{{ALERT_REASON}}”.
The alert algorithm keeps that level separate from monitor availability. A
high tide can produce WARNING while an independent wildfire feed remains
unavailable. This is an important failure-mode result: a current warning does
not repair an unrelated blind spot, and a blind spot does not get relabeled as
calm merely because another monitor returned a benign observation.

Thresholds remain interpretable because each monitor exposes its own summary.
For example, the tide monitor reports water level and datum, while the
wildfire monitor reports incident and evacuation-order fields. The composite
reason is a trace to the maximum local severity, not a black-box risk score.

## LLM summary provenance and reuse

The current overview records LLM status {{LLM_STATUS}} from
{{LLM_PROVIDER}} using model {{LLM_MODEL}}. It also records the prompt version
and the same input fingerprint used by the deterministic overview. The
successful-summary reuse rule in [@eq:summary_reuse] was exercised by running
the analytics command twice without changing substantive inputs. The second
run retained the prior summary timestamp and fingerprint rather than issuing a
new completion.

This is an idempotency result, not an accuracy result. The platform can prove
that it reused the same evidence-bound summary; it cannot infer that the model
noticed every caveat or that a user would interpret the prose correctly. When
the provider is unavailable, the expected result is a source-only or
deterministic fallback plus an unavailable provenance state.

## Validation and public-surface parity

The repository release gate checks strict TypeScript, deterministic tests,
whitespace, generated JSON contracts, and the Pages artifact. The manuscript
gate adds IMRAD structure, heading-level continuity, citation closure,
equation/table reference closure, claim-ledger shape, and token hydration.

The local and public surfaces were regenerated from the same output directory.
The Pages data/analytics-overview.json fingerprint equals the local
output/state/analytics-overview.json fingerprint, satisfying the parity
invariant [@eq:surface_parity]. The public snapshot remains degraded whenever
unavailable or stale source records are present; this prevents the static
export from converting an operational gap into a reassuring label.

## Claim-to-evidence map

| Claim class | Evidence object | What it establishes | What it does not establish |
|---|---|---|---|
| System invariant | Source and test files | The implementation contains the stated contract and negative controls | That every production input is semantically parsed correctly |
| Run observation | Analytics overview and source-health artifacts | What the system observed at a timestamp | That the observation is complete outside the configured boundary |
| Generated summary | Provider/model/prompt/fingerprint fields and citations | How a summary was produced and what evidence it references | That the prose is factually complete or unbiased |
| Public artifact | Pages snapshot plus validator output | That local and static outputs are structurally aligned | That readers will interpret them correctly |

: Claim boundaries used in the manuscript. {#tbl:claim_boundaries}

The boundary categories in [@tbl:claim_boundaries] keep software evidence, run
observations, generated language, and public delivery from being collapsed
into one undifferentiated claim.

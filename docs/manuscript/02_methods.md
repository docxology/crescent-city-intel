# Methods {#sec:methods}

## Study design and system boundary

This work is a software and artifact evaluation rather than a randomized
intervention. The unit of analysis is a pipeline run and its generated
evidence envelope. The system boundary begins at configured public endpoints
and ends at three coupled surfaces: durable JSON artifacts, the local Bun GUI,
and the static GitHub Pages snapshot. Credentials, private chat history,
request logs, vector-store internals, and full reference-only newspaper
content are outside the public snapshot boundary.

The municipal-code source is the Crescent City code collection identified by
ecode360 record CR4919 [@ecode3602026]. Alert sources include NWS/NOAA weather
and tsunami services, USGS earthquake data, NOAA CO-OPS tides, CDFW fishing
bulletins, EPA AirNow, CAL FIRE incidents, and NDBC marine observations
[@nws2026alerts; @usgs2026feed; @noaa2026tides; @airnow2026; @calfire2026].
The code and alert source families are not treated as interchangeable:
municipal code sections describe rules, while monitor records describe
time-bounded observations or collection states.

## Evidence model

Each source record has a stable identity, authority class, geographic scope,
canonical URL, collection mode, expected cadence, automation status, and
provenance note. A health envelope adds the latest check time, item count,
optional fetch time, error, HTTP status, and derived age. The operational state
is:

$$
q_i(t) \in \{\mathrm{ok},\mathrm{empty},\mathrm{unavailable},\mathrm{stale}\}.
$$ {#eq:source_state}

The four-valued state contract is summarized in [@eq:source_state].

The state is not an ordinal quality score. In particular,
unavailable is not worse-than-empty in a numerical sense; it is a different
epistemic statement. A source-health summary reports counts for each state and
sets the degraded count to unavailable plus stale. The public interface renders
these states verbatim and places the source URL and error beside the state when
possible.

The source registry also distinguishes three automation classes:
monitored sources emit health records, discovery-only sources are inventoried
but not parsed by a configured monitor, and reference-only sources may support
human citation but are excluded from curation, embeddings, training inputs, and
public article-content export. This separation is an implementation of a
data-use boundary, not a claim that the underlying source is unimportant.

## Municipal-code acquisition and verification

The scraper first obtains a table of contents, then visits manifest-selected
article pages through the Playwright browser lifecycle. Each saved article
contains the source URL, extracted sections, raw HTML, collection time, and a
SHA-256 digest. The verifier checks that expected article files exist, that
their hashes match the manifest, and that expected descendant sections are
present. A bounded live re-fetch sample can detect changes after the local
snapshot was written.

The exporter derives JSON, Markdown, plain-text, and CSV representations from
the same article objects. This makes the exported forms projections of one
source model rather than independently edited documents. The design follows
reproducible-computational-research guidance: a result should be regenerated
from a known source and command, not reconstructed from a screenshot or a
hand-edited table [@sandve2013reproducible].

## Alert assessment

Each monitor maps its domain-specific input to a local severity
$\ell_j(t) \in \{0,1,2,3\}$ corresponding to CALM, WATCH, WARNING, and
EMERGENCY. The composite level is the maximum available local severity:

$$
L(t) = \max_{j \in \{1,\ldots,8\}} \ell_j(t),
\qquad
U(t) = \mathbb{1}\{\exists j: q_j(t)=\mathrm{unavailable}\}.
$$ {#eq:composite_alert}

The composite assessment in [@eq:composite_alert] retains both the highest
observed severity and an explicit availability flag.

The pair $(L(t), U(t))$ is more informative than the label $L(t)$ alone. A
warning can coexist with an unavailable monitor; a calm local level with
$U(t)=1$ is explicitly “not established as calm.” Monitor thresholds are
operational rules encoded in src/alerts/severity.ts, not learned risk models.
For example, a tide at or above 7.0 feet MLLW maps to WARNING, while a tide
between 6.0 and 7.0 feet maps to WATCH (set above Crescent City's typical
max astronomical high tide of ~6.2 ft MLLW, so a normal high tide does not
elevate the composite); the tides input uses the current observed water
level. The composite function retains the per-monitor breakdown and the
reason that produced the maximum.

This max operator is intentionally conservative for escalation but incomplete
as a risk model. It does not estimate joint probabilities, forecast impacts,
or calibrate false-positive and false-negative rates. Those would require
historical labeled events and a decision-theoretic evaluation outside the
current repository.

## Retrieval, curation, and language-model controls

Municipal-code search uses a deterministic in-memory BM25 index with stemming
and fuzzy fallback. The RAG path retrieves labeled code sections and, where
configured, labeled YouTube transcript chunks. A response carries a query
identifier, context fingerprint, retrieval metadata, provider, model, and a
grounded flag. Retrieval is therefore inspectable even when the generated
answer is not accepted as authoritative.

News, meeting, and YouTube items are normalized into curation inputs. The
curation prompt instructs the selected provider to use only the supplied
source excerpt, avoid inferring identity, date, cause, location, or agency,
and return a concise summary. A preflight check prevents a known-unavailable
provider from causing one timeout per item. Per-item calls have a bounded
timeout. A failed call yields a source-only excerpt or an unavailable summary
with retryable=true; it is not recorded as a successful LLM completion.

The evidence carried by a successful curated item includes the source URL,
source family, fetch time, input fingerprint, prompt version, provider, and
model. The absence of a citation is therefore a reason to downgrade a summary,
not a reason to hide it. This design treats RAG and summarization as
evidence-conditioned transformations, consistent with the motivation for
retrieval-augmented generation [@lewis2020rag] and the documented risk of
hallucinated generation [@ji2023hallucination].

## Deterministic analytics and idempotency

The shared analytics backend builds one overview from code statistics, source
health, source discovery, alert analytics, composite severity, curation
metadata, reports, and pipeline state. Volatile observation times and run IDs
are excluded from the substantive input projection. Let $X$ denote the
canonicalized projection and let $H$ be SHA-256:

$$
F = H(\operatorname{canonical\_json}(X)).
$$ {#eq:input_fingerprint}

The fingerprint construction is [@eq:input_fingerprint]; it excludes
observation times so polling an unchanged source does not change the evidence
identity.

An existing successful summary is reusable only when:

$$
\operatorname{reuse} =
\mathbb{1}\left[
F_{\mathrm{new}}=F_{\mathrm{old}}
\land p_{\mathrm{new}}=p_{\mathrm{old}}
\land m_{\mathrm{new}}=m_{\mathrm{old}}
\right].
$$ {#eq:summary_reuse}

Here $p$ is the prompt version and $m$ is the provider/model identity. A
successful summary is never reused for changed evidence or a changed prompt.
If the provider is unavailable, the backend writes a deterministic fallback
summary and records LLM status as unavailable. The HTTP GET endpoint reads the
durable artifact and never performs an LLM call.

JSON artifacts are written to a process-specific temporary path and committed
with rename. Persistent idempotency stores key records by stable item identity
and content hash, migrate the legacy string-array form, and retain bounded
history. These measures address the system-level accumulation and dependency
risks described by Sculley et al. [@sculley2015technicaldebt].

## Cross-surface delivery

The local GUI exposes GET /api/analytics/overview with an ETag and renders the
overview in the welcome and intelligence sections. The Pages exporter copies
the same schema-valid overview to data/analytics-overview.json and renders its
summary, status, warnings, LLM provenance, and input fingerprint. The Pages
validator checks the public asset map and refuses local-only endpoints,
unresolved API-key placeholders, unsafe reference-only publication, and
inconsistent fingerprints.

The result is a two-surface invariant:

$$
F_{\mathrm{GUI}} = F_{\mathrm{Pages}}
\quad\land\quad
\operatorname{status}_{\mathrm{GUI}} =
\operatorname{status}_{\mathrm{Pages}}
$$ {#eq:surface_parity}

when both surfaces are generated from the same output directory and overview
artifact.

## Evaluation protocol

The evaluation combines five checks:

1. **Static contracts:** TypeScript strictness, OpenAPI/route parity, source
   registry validation, manuscript structure, citation closure, and
   unresolved-token detection.
2. **Deterministic tests:** real local corpus and fixture tests for extraction,
   source-health degradation, alert parsing, curation idempotency, API routes,
   and Pages snapshots.
3. **Artifact validation:** JSON envelopes, schema versions, SHA-256 format,
   source-health states, overview LLM provenance, and Pages asset links.
4. **Negative controls:** unavailable providers, missing output, empty feeds,
   HTTP errors, duplicate inputs, changed input hashes, and partially indexed
   embeddings.
5. **Render inspection:** manuscript hydration, template-rendered HTML/PDF
   outputs, bibliography closure, equation/table labels, and absence of
   unresolved tokens.

The protocol tests whether the system says less when it knows less. It does not
measure whether the system's summaries are preferred by residents, whether
alerts predict harm, or whether the source registry covers every relevant
community institution.

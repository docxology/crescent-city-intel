# Limitations, Ethics, and Threats to Validity {#sec:limitations}

## Coverage and freshness

The source registry is not a census of all local knowledge. It contains
configured official, agency, journalistic, environmental, transportation,
meeting, and reference sources within a declared geographic scope. Discovery
records can reveal a coverage gap without collecting it. A source can also
change its URL, markup, API contract, cadence, or access policy after the
software was released. Freshness windows are operational parameters, not
guarantees of semantic currency.

The municipal-code snapshot has a different limitation. SHA-256 verifies that
the local file has not changed since it was hashed; it does not prove that the
remote source was complete, that the parser extracted every legal nuance, or
that the code is the currently controlling law. The platform is a research and
navigation aid, not legal advice.

## Measurement and construct validity

The alert level is a rule-based aggregation of monitor-specific thresholds. It
is not a calibrated probability of harm, a forecast, or an emergency-management
directive. “CALM” means no configured threshold was met among available
inputs; “unavailable” means current state was not established. Neither label
should be used without reading the monitor breakdown and source age.

The analytics counts measure records and words, not civic relevance. BM25
scores measure lexical retrieval, not legal adequacy. A curation success count
measures provider completion, not summary faithfulness. The distinction between
measurement and construct is central: a reliable counter can still count the
wrong thing.

## Language-model and automation risks

The system uses language models only after input normalization and source
excerpt construction, but prompt constraints cannot guarantee faithfulness.
Models may omit a material qualification, repeat a source error, or produce
fluent text that appears more certain than the evidence. A provider/model
fingerprint makes the transformation auditable; it does not make the
transformation true. Generated text should be checked against its citations
before consequential use.

Automation can also amplify source selection bias. The source registry records
which institutions are monitored, but it cannot correct for institutions that
publish less often, lack accessible feeds, use inaccessible formats, or are
not represented in the configured coverage boundary. Absence of an item is
therefore never evidence that a community concern does not exist.

## Privacy, copyright, and responsible use

The system targets public sources, but public availability does not remove
ethical obligations. The public Pages snapshot excludes request logs, search
logs, RAG logs, vector-store data, credentials, and full Triplicate article
content. Triplicate metadata remains reference/citation-only and is excluded
from LLM curation, embeddings, and training inputs. These controls reduce
unnecessary redistribution and preserve a clear use boundary.

The platform should not be used to identify private individuals, infer
protected attributes, make eligibility decisions, or substitute for official
emergency instructions or legal counsel. If an alert matters, users should
consult the responsible public agency. If a source appears wrong, users should
inspect the source record and report the discrepancy rather than treating the
dashboard as a new authority.

## Threats to reproducibility

Live endpoints are mutable and sometimes unavailable. External providers,
browser automation, API keys, local model versions, and network conditions can
change between runs. The repository addresses this by preserving local
artifacts, timestamps, source URLs, hashes, provider metadata, and deterministic
tests. It cannot reproduce a remote state that was never archived. A future
release should add immutable input bundles and fixture-backed replay for every
monitor family before making longitudinal claims.

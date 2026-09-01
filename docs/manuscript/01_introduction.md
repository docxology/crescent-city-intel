# Introduction {#sec:introduction}

## Problem setting

Small municipalities publish information through many institutional channels.
The municipal code is authoritative for a different purpose than a news feed,
a meeting agenda, a tide prediction, or an earthquake catalog. These channels
also differ in cadence, access method, retention policy, and failure mode. A
single dashboard can make them easier to discover, but it can also erase the
distinctions that matter most: authority, time, coverage, and availability.
The resulting problem is not simply information retrieval. It is the design of
a civic information system whose outputs remain interpretable when inputs are
partial, changing, or unavailable.

The design follows the FAIR principle that data and the workflows that produce
it should be findable, accessible, interoperable, and reusable
[@wilkinson2016fair]. It also follows the provenance view formalized by PROV-O,
which represents entities, activities, and agents involved in producing a
result rather than treating the result as context-free
[@lebo2013provo]. In a local-government setting, these principles require more
than a downloadable JSON file. A user needs to know which source was checked,
when it was checked, what the source returned, which transformation produced a
summary, and whether the public artifact is the same artifact that the local
application served.

The language-model component adds a second boundary. Retrieval-augmented
generation combines a parametric generator with non-parametric retrieved
context [@lewis2020rag], but retrieval does not guarantee faithful generation.
Hallucination remains a documented failure mode of natural-language generation
systems [@ji2023hallucination]. The platform therefore uses language models for
bounded summarization and presentation, not as an authority that can repair
missing evidence. This distinction is consistent with documentation practices
that ask dataset producers to state intended uses, limitations, and provenance
[@gebru2021datasheets], and with risk-management guidance that treats an AI
system as a socio-technical system rather than a model in isolation
[@nist2023airmf].

## Research questions and contributions

This paper addresses four engineering research questions:

1. **RQ1 — State visibility:** Can a civic dashboard preserve the difference
   between no matching event, a successful empty response, an unavailable
   source, and stale data?
2. **RQ2 — Reproducible synthesis:** Can a language-model summary be bound to a
   stable evidence fingerprint so that an unchanged input does not trigger
   another completion?
3. **RQ3 — Cross-surface integrity:** Can one typed overview drive both a local
   interactive GUI and a static public snapshot without silently changing
   status, provenance, or source boundaries?
4. **RQ4 — Operational limits:** Which failure modes remain after deterministic
   tests, source-health contracts, idempotency, and generated-artifact checks
   are in place?

The contribution is a working research artifact with five parts:

- a manifest-driven municipal-code pipeline that records SHA-256 content
  hashes, validates section coverage, and exports machine- and
  human-readable forms;
- a canonical source registry joined to typed health records and explicit
  discovery-only and reference-only boundaries;
- eight monitor families, a priority-ordered composite severity function, and a
  persistent cross-source event timeline;
- grounded retrieval and provider-aware summarization whose outputs carry
  citations, model metadata, prompt versions, and retryable failure states; and
- a deterministic analytics overview with atomic writes, stable input
  fingerprints, local API delivery, and Pages export parity.

The paper makes no causal claim that the platform improves civic participation,
emergency response, public trust, or legal compliance. It evaluates whether
those claims would be premature by making their prerequisites and missing
evidence visible.

## Scope and terminology

“Source” means an external or generated input with a declared provenance and
collection contract. “Health” means the operational state of an attempted
collection, not the truth of the source's content. “Unavailable” means that
the system could not establish current state. “Empty” means that a successful
collection returned no matching records under the monitor's query. “Summary”
means a generated or deterministic text field derived from recorded evidence;
it is not itself a primary source.

This vocabulary is intentionally conservative. The same source may be
available but biased, current but incomplete, or technically healthy while
semantically misparsed. The platform's contracts address operational
observability first; semantic validity still requires domain review.

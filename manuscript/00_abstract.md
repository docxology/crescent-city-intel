# Abstract {#sec:abstract}

Local public information is fragmented across municipal code portals, meeting
calendars, news feeds, agency APIs, and emergency-status services. A search
interface can collect these materials without making their epistemic status
clear: an empty feed can be mistaken for a calm condition, a stale record can
look current, and a fluent language-model summary can be mistaken for a source.
This paper presents the Crescent City Intelligence Platform, an open
research-software system for Crescent City, California, designed around an
explicit evidence boundary.

The platform combines a manifest-driven municipal-code scraper and verifier,
canonical source registry, typed source-health envelopes, eight alert monitors,
persistent event analytics, retrieval-augmented code search, provider-aware
language-model curation, and a shared analytics overview consumed by both the
local GUI and a static GitHub Pages snapshot. The implementation represents
source state as a four-valued operational contract—ok, empty, unavailable, or
stale—and treats provenance as a first-class field rather than as display
decoration. Run-specific analytics are bound to a SHA-256 fingerprint of
substantive inputs; repeated runs with the same fingerprint, provider, model,
and prompt version reuse a successful summary without issuing another
completion.

At the rendered snapshot time of {{SNAPSHOT_DATE}}, the platform indexed
{{CODE_SECTIONS}} municipal-code sections in {{CODE_ARTICLES}} article pages
containing approximately {{CODE_WORDS}} words, while the monitored source
envelope contained {{SOURCE_TOTAL}} records: {{SOURCE_OK}} ok,
{{SOURCE_EMPTY}} empty, {{SOURCE_UNAVAILABLE}} unavailable, and
{{SOURCE_STALE}} stale. The public analytics artifact was
{{ANALYTICS_STATUS}}, with a composite {{ALERT_LEVEL}} assessment and
language-model status {{LLM_STATUS}}. These observations are a run snapshot,
not a claim about the persistent state of Crescent City or the effectiveness of
the system in improving public safety.

The contribution is therefore methodological and operational. The platform
makes absence, uncertainty, retrieval context, model provenance, and generated
artifact identity inspectable. It does not establish that an LLM summary is
factually complete, that a source is unbiased, or that the alert thresholds are
calibrated for decision-making. Those questions remain empirical evaluation
targets.

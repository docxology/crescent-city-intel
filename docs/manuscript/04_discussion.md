# Discussion {#sec:discussion}

## What the system demonstrates

The strongest result is not the volume of collected material. It is the
preservation of distinctions that ordinary dashboards tend to compress. The
four-valued source-health contract makes the dashboard answer two different
questions: “Did the monitor successfully observe a qualifying record?” and
“Was the monitor able to establish current state?” The answers can diverge,
and the user interface keeps them diverged.

The second result is that provenance can be made operational. A source registry
is useful only when its entries connect to actual health records, output
artifacts, and explicit automation boundaries. The registry fingerprint,
source-health envelope, input fingerprint, prompt version, and model metadata
form a chain that a reader can follow from public summary to underlying
record. It is a domain-specific application of machine-actionable provenance
principles [@lebo2013provo] and FAIR stewardship [@wilkinson2016fair].

The third result is that idempotency is part of epistemic quality. Duplicate
summaries are not merely inefficient. They create competing text for the same
input, complicate audit, and make a rerun look like a new observation. The
combination of stable item fingerprints, prompt versions, atomic writes, and
repeat-run tests reduces that ambiguity. It does not make the upstream data
stable; it makes the system's response to unchanged data stable.

## Relation to prior work

The platform sits between civic technology and research software. Work on civic
technology emphasizes digital tools that mediate relationships between
institutions and communities, while also warning that technology alone does not
determine participation or accountability [@aguerre2024civic]. This system
focuses on the narrower infrastructure problem beneath that relationship:
keeping public-source identity, time, coverage, and failure state visible.

The implementation also extends ideas from reproducible computational research
[@sandve2013reproducible], dataset documentation
[@gebru2021datasheets], and provenance standards
[@lebo2013provo] into a small local-information setting. Its RAG and
summarization paths draw on the retrieval-plus-generation architecture
described by Lewis et al. [@lewis2020rag], but its evaluation stance is
deliberately more modest than a benchmark claim. Retrieval context and
citations improve inspectability; they are not a proof of factuality. The
hallucination literature motivates the system's refusal to elevate generated
text above primary records [@ji2023hallucination].

## Design trade-offs

The explicit source-state model increases visible complexity. A dashboard with
one green/red indicator is easier to scan, but it hides whether a source was
empty, broken, stale, disabled, or never checked. The present design chooses
interpretability over a single scalar. This is appropriate for a research
artifact and for safety-adjacent public information, but it places a reading
burden on users. The entry-point guidance and ordered “start here” sections are
therefore part of the method, not merely interface copy.

The max-severity alert rule is likewise a conscious compromise. It makes a
high-priority signal hard to suppress, but it does not quantify risk. A more
ambitious model could combine hazard probability, exposure, vulnerability,
forecast lead time, and uncertainty. Such a model would require validated
labels, calibrated thresholds, and community review. Until then, the
priority-ordered rule is best understood as an escalation heuristic.

The LLM layer trades breadth for boundedness. A short source-grounded brief can
help a reader navigate many items, but it can also produce misplaced confidence
if the user overlooks the citation and provenance fields. The platform's
fallbacks and visible status reduce this risk but do not eliminate the
human-factors problem. NIST's AI risk-management framing is relevant here:
trustworthiness is a lifecycle property involving data, people, systems, and
deployment context, not a model score alone [@nist2023airmf].

## What would change the conclusion

The present evidence would support a stronger claim only if future work adds:

1. a labeled set of source-health and parser outcomes for semantic validation;
2. historical alert records with documented ground truth for threshold
   calibration and false-alarm analysis;
3. a blinded human evaluation of summary faithfulness, citation correctness,
   omission, and harmful overstatement;
4. community-centered evaluation of whether the interface improves discovery
   or understanding for residents and local organizations; and
5. independent replication from a clean checkout using archived inputs and
   pinned runtime versions.

These are not cosmetic enhancements. Each one tests a claim that the current
artifact intentionally leaves open.

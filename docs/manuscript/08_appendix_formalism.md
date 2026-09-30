# Appendix: Formal Contracts and Worked Records {#sec:appendix_formalism}

## Typed source contract

For source $i$, the operational record is:

$$
r_i =
\left(
\mathrm{id}_i,\,
\mathrm{authority}_i,\,
\mathrm{scope}_i,\,
\mathrm{url}_i,\,
\mathrm{mode}_i,\,
q_i,\,
\tau_i,\,
n_i,\,
e_i
\right),
$$ {#eq:source_record}

where $q_i$ is the four-valued state, $\tau_i$ is the check time, $n_i$ is the
item count, and $e_i$ is an optional error or provenance detail. The record
supports navigation and audit; it does not assign a truth probability.
The record shape is given in [@eq:source_record].

## Evidence-conditioned summary contract

For an item $a$ with source excerpt $E(a)$, a generated brief is accepted as
an LLM success only if the provider returns non-empty text within the bounded
timeout:

$$
b(a) =
\begin{cases}
(\text{text},\mathrm{ok},m,p,F,C), & \text{provider returns in time},\\
(\text{fallback},\mathrm{unavailable},m,p,F,C), & \text{otherwise},
\end{cases}
$$ {#eq:summary_contract}

where $m$ is the model, $p$ is the prompt version, $F$ is the input
fingerprint, and $C$ is the citation set. A fallback may remain visible as
source-only context, but it is not recorded as a successful LLM completion.
The acceptance boundary is formalized in [@eq:summary_contract].

## Worked JSON record

The following is an illustrative shape, not an additional live source:

~~~json
{
  "id": "news-item-identifier",
  "summaryStatus": "ok",
  "provider": "ollama",
  "model": "configured-model",
  "inputFingerprint": "64-hex-digest",
  "promptVersion": "curation-prompt-version",
  "citations": [
    {
      "url": "https://example.invalid/public-item",
      "label": "Public item",
      "source": "news",
      "fetchedAt": "2026-07-24T00:00:00Z"
    }
  ]
}
~~~

The example demonstrates the minimum audit path. It should not be populated
with invented facts merely to make the interface look complete.

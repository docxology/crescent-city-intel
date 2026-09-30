# Reproducibility and Artifact Specification {#sec:reproducibility}

## Source of truth

The source-controlled manuscript lives in docs/manuscript/. Its run-specific
numbers are hydrated from output/state/analytics-overview.json by
scripts/hydrate-manuscript.ts. The hydrated copy is written to
output/manuscript/ and is the input consumed by the shared template renderer.
The source manuscript remains free of hand-edited run counts.

The platform's primary commands are:

~~~text
bun install --frozen-lockfile
bunx playwright install chromium
bun run test:typecheck
bun run scrape
bun run verify
bun run export
bun run analytics
bun run manuscript:check
bun run manuscript:hydrate
bun run validate
~~~

The first four commands produce the municipal-code evidence chain. The
analytics command builds the shared overview and may request a provider
summary; passing --no-llm produces a deterministic fallback. The manuscript
commands validate and hydrate the publication source. The final gate runs
separate source/test strict type checking, two fenced deterministic runs, actual
line-coverage parsing, contract checks, whitespace, and generated Pages validation.
Child deadlines cover descendant process groups and bound output; finally fences
check both the checkout output and an explicitly selected `CC_OUTPUT_DIR`.

## Template rendering

The Research Project Template repository provides the renderer. From the
template checkout, the project can be rendered through a temporary
projects/working/crescent-city-intel link to this repository, or through the
project's documented wrapper when one is available:

~~~text
uv run python scripts/pipeline/stage_03_render.py --project working/crescent-city-intel
~~~

The renderer expects a project root containing docs/manuscript/, output/, and
config.yaml. The Python compatibility adapter
scripts/z_generate_manuscript_variables.py delegates hydration to Bun, so
template-driven rendering can refresh the evidence-bound manuscript before
compilation. The expected outputs are a combined PDF, per-section HTML, and
a combined HTML document under output/.

Rendered files are generated artifacts. Review source Markdown, config, the
claim ledger, and validator output before treating a PDF or HTML page as a
release object. A successful render is necessary but not sufficient: a file can
compile while a claim, citation, source boundary, or unresolved token is wrong.

## Reproduction matrix

| Question | Command or artifact | Passing condition |
|---|---|---|
| Is retained code internally consistent? | bun run verify -- --offline | Local custody plane passes; current-source publication remains ineligible |
| Is fresh code publication eligible? | bun run verify | Local/current-TOC/live-sample planes pass and bind the exact manifest, TOC, and canonical exported article text |
| Did the analytics overview use a known evidence state? | output/state/analytics-overview.json | 64-hex input fingerprint and valid schema |
| Was the LLM call bounded? | Overview llm fields | Provider, model, prompt version, status, and fingerprint present |
| Did an unchanged run avoid duplicate summarization? | bun run analytics twice | Fingerprint and successful summary timestamp reused |
| Are source states explicit? | Source-health artifacts | Every record is ok, empty, unavailable, or stale |
| Did GUI and Pages agree? | Local overview and .pages/data/analytics-overview.json | Equal input fingerprints |
| Is the manuscript structurally closed? | bun run manuscript:check | IMRAD, citations, labels, tokens, and claim ledger pass |
| Did the publication renderer succeed? | Template stage_03_render.py | Exact template revision and hydrated-input fingerprint recorded; PDF/HTML outputs exist and render summary is clean |
| Is the public edition coherent? | publication-input.json and publication-manifest.json | Complete input bundle selected; every emitted file hash matches; source age/seed fallback remains explicit |
| Is the optional stack ready? | scripts/stack-readiness.ts | Real bounded Ollama/Chroma responses and both requested model identities present |

## Reproducibility boundary

The reproducibility claim is bounded: a clean checkout can reproduce the
software's transformations and deterministic fixtures, and can regenerate a
new live snapshot when sources and providers are reachable. It cannot recreate
an unavailable endpoint's past response or guarantee that a remote source has
not changed. This boundary follows the distinction between reproducible code
and reproducible external state emphasized in computational-research guidance
[@sandve2013reproducible].


Local fixture tests, native browser interactions, real model/vector-service
acceptance, external template rendering, hosted CI, and public deployment are
reported separately. The claim ledger names code and tests for implemented
contracts; their existence does not imply the external acceptance ran. Real model
outputs remain generated-unverified even when transport, citation identities, and
retrieval contracts pass. The versioned benchmark reports bounded case outcomes,
not universal model factuality or calibrated safety.

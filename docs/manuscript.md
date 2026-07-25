# Manuscript and template rendering

The source-controlled paper is in [`manuscript/`](../manuscript/). It is a
software-and-artifact evaluation paper, not a claim of safety impact or legal
sufficiency. The manuscript keeps implementation invariants, one-run
observations, generated language, and public-delivery claims separate through
`manuscript/claim_ledger.json`.

## Source and hydration

The numbered Markdown files provide the renderer-compatible IMRAD spine:
abstract, introduction, methods, results, discussion, limitations and ethics,
reproducibility, conclusion, appendix, and references. Run:

~~~text
bun run analytics
bun run manuscript:check
bun run manuscript:hydrate
bun run scripts/validate-manuscript.ts --hydrated
~~~

Hydration reads `output/state/analytics-overview.json`, writes
`output/data/manuscript_variables.json`, and creates the ignored
`output/manuscript/` tree. The analytics input fingerprint is preserved in the
variable artifact and rendered abstract/results text. Do not edit generated
Markdown or hand-copy snapshot values into source prose.

## Rendering with the shared template repository

The project uses the shared template renderer without modifying the template
checkout. From `/Users/4d/Documents/GitHub/template`, create a temporary link
only when that path is unused:

~~~bash
link=/Users/4d/Documents/GitHub/template/projects/working/crescent-city-intel
ln -s /Users/4d/Documents/GitHub/projects/ongoing/DAF/crescent-city-intel "$link"
trap 'unlink "$link"' EXIT
uv run python scripts/pipeline/stage_03_render.py --project working/crescent-city-intel
~~~

The renderer invokes `scripts/z_generate_manuscript_variables.py`, which
delegates to Bun, then compiles `output/manuscript/` into PDF and HTML. The
link must be removed after the render; the template repository is not a
project dependency and no template source is changed by this workflow.

## Publication checks

`bun run validate` includes the manuscript source contract in addition to the
TypeScript, deterministic test, generated-output, Pages, and whitespace gates.
When an analytics overview exists, it also hydrates and checks the generated
manuscript fingerprint. The manuscript validator checks H1 continuity, IMRAD
headings, Pandoc citations, bibliography closure, equation/table references,
token names, claim-ledger shape, and hydrated output. A successful renderer
compile is necessary but does not establish LLM factuality, source
completeness, public interpretability, legal advice, or safety efficacy.

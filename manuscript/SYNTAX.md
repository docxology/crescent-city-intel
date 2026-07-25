# Manuscript syntax

The shared template renderer consumes numbered Markdown files in lexical order.
The first line of each renderable file is its H1 section label. Keep the
references section last.

Use Pandoc citations, for example `[@lewis2020rag]`. Bibliography keys must be
present in `references.bib`. Use one of the supported labels for formal
objects, such as `{#eq:summary_reuse}` or `{#tbl:snapshot_inventory}`, and
refer to them with `@eq:summary_reuse` or `@tbl:snapshot_inventory`.

Run-specific observations belong in double-brace variables and are resolved by
the analytics-bound hydrator. New variables require a corresponding entry in
`src/manuscript_variables.ts`, a source value in the analytics overview, and a
validator test or gate. Never make a rendered number look authoritative by
hardcoding it in the source prose.

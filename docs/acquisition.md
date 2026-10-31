# Source-bound municipal acquisition

`region.candidate.json` selects a candidate root independent of active output and
public seeds. It uses the same civic identity and regional policy. Run:

```sh
REGION_DEPLOYMENT=region.candidate.json bun run all
```

The shared runner acquires source, verifies every retained article locally,
checks the current TOC and a deterministic live sample, then exports. Interrupted
or failed candidates remain unaccepted and are resumable. Do not copy a partial
manifest or article subset into active output or public seeds. A successful sample
is not a guarantee that every upstream page stayed current throughout acquisition.

Public seed promotion and active corpus promotion require the matching complete
hash-bound verification receipt; raw provider HTML and operator evidence remain
local. Optional model-backed RAG additionally requires configured model/vector
services. Never relabel another municipality's corpus.

## Accept and publish a complete edition

After all acquisition stages succeed, use the shared methods:

```sh
bun run corpus:check -- --source .corpus-candidates/EDITION
bun run corpus:promote -- --source .corpus-candidates/EDITION
bun run corpus:check
bun run pages:seed
bun run pages:export
bun run pages:validate
```

Replace `EDITION` with the candidate selected in `region.candidate.json`. Promotion
validates exact raw extraction custody, complete membership and live-verification
bindings before replacing active files. A journal composes bounded transactions
and restores earlier batches on failure, preserving unrelated news/alert state.
Candidates must remain separate from active output and public seed roots.

Only public corpus projections and their verification/input receipts belong in
`pages-data/`. Raw HTML, checkpoints and private recovery evidence stay ignored.
The static site can search the accepted seed without a running model service.
Local GUI BM25 search uses the promoted raw corpus; a fresh clone needs acquisition
and promotion before that local corpus search is populated. Optional RAG requires
its own model/vector setup and acceptance.

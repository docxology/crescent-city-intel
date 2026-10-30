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

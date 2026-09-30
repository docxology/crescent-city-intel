# Workflow contracts

| Workflow | Trigger | Scope |
| --- | --- | --- |
| `pr-gate.yml` | Pull request to main, manual | Strict source/tests types, canonical contract checks, conservative affected tests, real GUI browser smoke |
| `pages.yml` | Main push, weekly, manual | Full gate, bounded isolated code candidate, fresh feeds, validated same-edition public tree, unchanged upload/deploy |
| `weekly.yml` | Weekly, manual | Current monitor roster health; optional full scrape and hash-bound artifact handoff to downstream live verification |

Pin the same Bun version and frozen dependency install in every job. Chromium
requires its own explicit installation. The fast path calls
`bun run validate -- --only=contracts`; importing `src/release_gate.ts` alone is
not a CLI invocation. Its output names all skipped checks.

Dependency selection uses recursive TypeScript import/re-export/helper closure.
Configuration/assets/scripts, missing/deleted paths, unresolved/dynamic imports,
or uncertain mappings run the full suite. Affected selection never means an
empty pass. Current-cycle health requires the exact canonical monitor roster,
valid states/counts/timestamps, and a successful runner; unavailable upstream
records remain distinct from crashes or missing current evidence.

The Pages code candidate lives under runner temporary storage, apart from
`output/` feeds. A failed/timed-out candidate selects the entire reviewed seed;
it cannot poison the weekly monitor with partial TOC/manifest files. A successful
candidate must pass live verification before export, and the publication reader
recomputes its binding. Staged tree validation and hash/privacy receipts precede
upload. Deployment status needs a hosted receipt and direct site checks.

Weekly manual scraping uploads the exact generated core/article artifacts and
verification receipt. The downstream job downloads that artifact and validates
its input binding before another live verification. It must not verify an empty
fresh checkout and imply continuity with a prior job. Public health uploads use
DTO projections; raw operator diagnostics stay outside transferred artifacts.

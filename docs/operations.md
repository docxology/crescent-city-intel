# Operate the Crescent City deployment

Start with the [repository guide](../README.md), [architecture](architecture.md)
and [accepted edition](edition.md). This repository imports the shared runner
from an immutable public Git dependency. `bun install --frozen-lockfile` needs
no sibling core checkout. CI pins Bun 1.4.2. Keep source, build output, caches and
temporary files on GitVault when using that workspace and follow its enclosing
repository-admission contract.

## Local checks without new acquisition

```sh
bun install --frozen-lockfile
bun run status
bun run validate
bun run pages:export
bun run pages:validate -- .pages
```

The consumer gate checks importer types, installed-package configuration,
identity binding and cross-region rejection. It is separate from the shared
implementation's full test and coverage gate. Pages export can use the tracked
accepted seed in a fresh clone. It neither refreshes the municipal source nor
populates local raw articles. Static code search uses that public seed; local
GUI corpus search requires [acquisition and promotion](acquisition.md).

## Regional collection

```sh
bun run source-discovery
bun run news
bun run gov-meetings
bun run alerts
bun run weekly-check
```

The first four commands can be run individually to diagnose source state;
`weekly-check` runs its declared collection sequence. Inspect actual dated
source-health and pipeline receipts in `output/` rather than treating command
completion or an empty feed as coverage. These commands do not acquire and
promote a new municipal edition. That separate procedure uses
`region.candidate.json` and preserves failed candidate evidence.

Crescent uses the authored Quadruplicate compatibility application and source
registry. Its 20-monitor roster is declared in `region.json`; configured catalog
or statewide feeds retain their actual geographic/data units and known gaps.
The two source declarations in `region.json` do not replace the compatibility
registry's full reviewed source inventory.

Run `bun run gui` for the local interface, normally at port 3000. Browser-based
collection requires separately installed Chromium. Optional chat/index/query
needs the configured model/vector services and its own accepted index; a Pages
or configuration pass does not certify those services.

## Hosted delivery

The actual definitions are
[consumer acceptance](../.github/workflows/validate.yml),
[Pages delivery](../.github/workflows/pages.yml) and
[weekly collection](../.github/workflows/weekly.yml). Main pushes trigger
acceptance and Pages; collection is also scheduled weekly. Pages builds perform
live source collection before exporting, so provider results can differ from a
local offline seed check. Keep upstream unavailable/stale states visible.
The weekly workflow collects in its runner workspace; it does not commit a new
municipal seed back into this repository.

After pushing, check each workflow's exact head SHA and conclusion. Local
validation, hosted execution and the served site's identity/bytes are separate
observations. Consult current run receipts before claiming deployment success.

## Upgrading and troubleshooting

Generic fixes belong in `region-intel`. For a runtime upgrade select a reviewed
full Git SHA, run `bun install`, commit the manifest and resulting lockfile,
then repeat consumer validation and fresh Pages checks for both regions. Never
substitute a mutable branch or neighboring `file:` dependency. Documentation-only
shared changes do not require changing a previously qualified runtime pin.

If identity binding fails, preserve the occupied root and inspect configuration;
do not relabel retained articles. If a provider fails or returns partial content,
keep its report and resume through the supported candidate path. Do not delete
locks, checkpoints or recovery journals. If Pages validation fails, retain the
failure and re-export from unchanged accepted inputs before checking again.
If only local search is empty, check whether raw articles have been acquired
and promoted before investigating model services.

Shared [operations](https://github.com/docxology/region-intel/blob/main/docs/operations.md)
and [command routing](https://github.com/docxology/region-intel/blob/main/docs/deployments.md#command-routing)
provide method details. [The docs index](README.md) links the installed revision.

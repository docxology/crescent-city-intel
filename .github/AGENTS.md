# .github — agent notes

Three workflows (verified 2026-09-28). See
[workflows/AGENTS.md](workflows/AGENTS.md) for the per-workflow contract and the
rules that `tests/ci-config.test.ts` enforces.

- **`pr-gate.yml`** (added 2026-09-28) gates every pull request to `main`: the
  offline contract checks plus the tests a change could plausibly affect. It
  exists because the authoritative release gate previously ran only on
  `push: main` and a schedule, so a regression could be merged before anything
  noticed.
- **`pages.yml`** builds and publishes the static snapshot to GitHub Pages
  (permissions: contents read, pages write, id-token write; concurrency group
  `github-pages`; env includes AIRNOW_API_KEY secret, SOURCE_DISCOVERY_LIVE_CHECK=1,
  PAGES_BUILD=1). It runs the FULL release gate and a failure stops the publish.
- **`weekly.yml`** runs the weekly intelligence cycle (schedule +
  `workflow_dispatch` with a `run_scrape` boolean; permissions contents read +
  actions read; concurrency group `weekly-cycle`).

All three pin Bun via `BUN_VERSION` to the same version. Keep trigger times, env
names, and the table in `workflows/AGENTS.md` in sync when editing them.

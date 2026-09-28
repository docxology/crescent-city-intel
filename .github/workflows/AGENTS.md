# workflows — agent notes

Three workflows (verified 2026-09-28). `tests/ci-config.test.ts` asserts the
properties below, because workflow YAML is configuration: nothing typechecks it
and nothing fails when it drifts.

| Workflow | Trigger | Job | What it decides |
| :--- | :--- | :--- | :--- |
| `pr-gate.yml` | `pull_request` to main, non-main pushes, manual | Fast gate | Whether a change may merge. Offline contract checks + affected tests. |
| `pages.yml` | `push` to main, weekly, manual | Publish | Whether the public snapshot may ship. Runs the FULL release gate. |
| `weekly.yml` | weekly, manual | Health check / verify / scrape | The intelligence cycle. |

## Rules

- **Bun is pinned** via `BUN_VERSION`, identical in all three. Never
  `bun-version: latest` — that lets a Bun release break a job with no change to
  this repository.
- **Never restate the monitor roster in a workflow.** `weekly.yml` used to
  carry eight hand-written `bun run alerts:<x>` steps and silently fell behind a
  roster of fifteen, so seven monitors were never smoke-tested in CI. Use
  `scripts/ci-monitor-smoke.ts`, which derives from `MONITOR_KEYS`.
- **The fast PR path is a MODE OF THE GATE**, not a second implementation:
  `bun run validate --only=contracts`. A check added to `src/release_gate.ts`
  before the `contractsOnly` early-return is picked up by both. It prints what it
  skipped and says it is not a full pass.
- **Live-feed degradation is reported, never a build failure.** These hit
  government endpoints; a red build on someone else's downtime is a red build
  people learn to ignore. Real failures are the gate's job.
- **Adding a job** means updating this table and checking any `secrets.*` /
  `vars.*` references are used.

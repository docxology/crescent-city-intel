# .github — agent notes

GitHub selects `.github/README.md` for the repository landing page. It is the
complete generated projection of root `README.md`, with relative Markdown and
HTML links rebased to this directory. Edit the root guide, then run
`bun run docs:generate`; `bun run docs:check` and both release-gate modes enforce
exact agreement. Workflow notes belong in `workflows/README.md`.

See [workflows/AGENTS.md](workflows/AGENTS.md) for the per-workflow contract.
All three workflows pin Bun 1.4.2, use frozen dependencies, and explicitly install
Chromium before browser work. Configuration tests establish local agreement;
hosted execution and deployment require their own receipts.

- `pr-gate.yml`: production and separate test strict types, the canonical
  contract-only gate, recursively selected affected tests with conservative
  full-suite fallback, and real GUI browser smoke.
- `pages.yml`: the full deterministic gate, a job-private municipal candidate
  with an 18 minute total budget, fresh live feeds, whole-edition code/seed
  selection, full public-tree validation, then unchanged artifact upload/deploy.
- `weekly.yml`: current-cycle whole-roster monitoring, full tests, and explicit
  scraper→artifact upload→downstream verification/analysis handoff on manual
  scrape runs. Failed children or missing current evidence fail the job.

Keep environment names, trigger/job topology, and the guide synchronized with
workflow edits. Public uploads use allowed source-health fields; raw operator
errors, credentials, and local artifact paths remain local.

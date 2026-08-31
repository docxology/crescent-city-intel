# Review Log - 2026-08-31 (agent-ergonomics fleet pass)

Lane: crescent-city-intel - branch `main` - doc + gate-repair pass.

## Phase 0 - preflight
- 21 pre-existing dirty paths at dispatch (manuscript migration
  `manuscript/` to `docs/manuscript/`: deletions, modified README/docs, untracked
  `docs/manuscript/`). Treated as pre-existing; not committed by this pass
  except where explicitly finished (see Phase 3).

## Phase 1 - cold-start audit
- (a) current status: weak - README stated no pointer to generated status files
  (fixed in Phase 3).
- (b) what to do next: FAIL - TODO.md existed but neither README nor AGENTS.md
  linked to it (fixed).
- (c) primary verification command: PASS - `bun run validate` well documented.
- Link check over README/AGENTS/TODO/ISA/CONTRIBUTING plus docs/**: one broken
  relative link (`docs/manuscript.md:3` pointing at deleted `../manuscript/`).
- Stale claim: `docs/manuscript/MANUSCRIPT_STATUS.md` described the legacy
  fallback as `docs/manuscript/` (copy-paste from another repo).

## Phase 3 - implementation
- `docs/manuscript.md:3` link fixed to `docs/manuscript/`.
- README: added "Current Status" (executable-truth table) + "What To Do Next"
  (single pointer to TODO.md) + TOC entries.
- AGENTS.md: added "Agent Orientation" block; architecture tree now names all
  13 monitors (8 core + 5 extended) explicitly.
- MAJOR gate repair: `scripts/validate-manuscript.ts` and
  `scripts/hydrate-manuscript.ts` still pointed at deleted top-level
  `manuscript/`, so `bun run validate` failed (`manuscript/ is missing`).
  Both now resolve `docs/manuscript/` first, legacy path as fallback.
  `bun run manuscript:check` passes.
- MANUSCRIPT_STATUS.md stale fallback claim corrected.
- TODO.md: completed entries recorded; footer date updated.

## Phase 4 - verify and close
- Link check re-run on touched docs: 0 broken.
- Gate: `bun run validate` - final 2026-08-31 result recorded in the fleet
  report and TODO.md.

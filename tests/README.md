# Tests — `tests/`

Deterministic zero-mock tests cover pure logic, local HTTP fixtures, route
contracts, public artifact boundaries, orchestration metadata, and provider
degradation. The current total is emitted by Bun and verified by
`bun run validate`; it is intentionally not duplicated here.

## Test Suite

The file-to-module mapping is maintained in [AGENTS.md](AGENTS.md). Per-file
test counts are intentionally not duplicated here — they drift as modules
evolve, and `bun test` / `bun run validate` are authoritative.

## Running

```bash
bun test                          # all tests
bun test tests/utils.test.ts      # specific file
bun test --watch                  # watch mode
```

See [AGENTS.md](AGENTS.md) for conventions and how to add new tests.

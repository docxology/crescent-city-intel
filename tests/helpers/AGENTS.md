# helpers/ — agent notes

Test helpers are imported by sibling `*.test.ts` files; they are not tests.

- `output-root.ts` resolves fixture output roots.
- `site-js.ts` loads the actual authored browser helpers.
- `publication-fixture.ts` writes bounded synthetic municipal publication fixtures.
- `llm-http.ts` provides real local HTTP fixtures for LLM contracts.
- `pages-validator.ts` runs the actual Pages CLI in an owned child with finite
  time/output limits, concurrent pipe draining, and child-only `CC_TEST_FIXTURE=1`.

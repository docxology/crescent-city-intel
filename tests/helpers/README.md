# tests/helpers

Shared real-fixture helpers resolve output roots (`output-root.ts`), load the
authored browser code (`site-js.ts`), write bounded municipal editions
(`publication-fixture.ts`), and host local model HTTP fixtures (`llm-http.ts`).

`pages-validator.ts` invokes the actual Pages CLI with child-only fixture
admission, asynchronously drained pipes, a maximum five-second child deadline,
and a one-MiB output bound. Validation rejection and timeout remain distinct
terminal outcomes; callers assert the expected exit status and child reaping.

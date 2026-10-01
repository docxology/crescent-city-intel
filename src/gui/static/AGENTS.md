# gui/static — agent notes

`index.html` (SPA markup shell), `docs.html` (API docs at `/api/docs`), and
`assets/` — `gui.css`, `gui-runtime.js`, `virtual-list.js`, and `modules/*.js`.
The SPA loads `gui-app.js` as one ES module entry point; controllers import
their dependencies and use `app-state.js` for shared mutable state.
Standalone pages import their own controllers and `reader-lifecycle.js`.
`gui-runtime.js` provides explicit `CCGui.render()` sanitation and guarded
storage; every generated HTML insertion must use that renderer. It does not
patch browser prototypes. Served by ../server.ts. Do not confuse with the
Pages snapshot in ../../pages/static/.

Reader requests use `runReaderTask`, `readerFetch`, and `readerAwait` to bind
cancellation, a finite deadline, visible retry controls, and latest ownership.
Keep keyboard controls, focus restoration, and live announcements available
at desktop and mobile widths. API credentials live only in tab memory and
are sent solely to same-origin API paths; redirects are denied.

Verify module wiring with GUI tests and actual browser journeys:
`bun run tests/gui-journeys.browser.ts` and
`bun run tests/gui-readers.browser.ts`. The latter uses the real API handlers
with isolated reviewed-seed data and local HTTP provider/vector protocols.

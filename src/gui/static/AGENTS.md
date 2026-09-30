# gui/static — agent notes

`index.html` (SPA markup shell), `docs.html` (API docs at `/api/docs`), and
`assets/` — `gui.css`, `gui-runtime.js`, `virtual-list.js`, and `modules/*.js`.
Loaded by classic `<link>`/`<script src>` tags in an explicit execution order;
shared globals coordinate the modules. `gui-runtime.js` sanitizes supported
HTML/markdown rendering. Served by ../server.ts. Do not confuse with the
Pages snapshot in ../../pages/static/.

Load-order note: `modules/100-overlay-tabs.js` loads AFTER `130-readability.js`
because its `TAB_LOADERS` map eagerly references loader functions declared in
later modules; function declarations are not hoisted across files.

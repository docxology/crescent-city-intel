# gui/static — agent notes

`index.html` (SPA markup shell), `docs.html` (API docs at `/api/docs`), and
`assets/` — `gui.css`, `virtual-list.js`, and `modules/*.js` extracted
verbatim from the former inline `<style>`/`<script>` (v2.7.0). Loaded by
classic `<link>`/`<script src>` tags in the original execution order;
globals stay implicit. Served by ../server.ts. Do not confuse with the
Pages snapshot in ../../pages/static/.

Load-order note: `modules/100-overlay-tabs.js` loads AFTER `130-readability.js`
because its `TAB_LOADERS` map eagerly references loader functions declared in
later modules (function declarations are not hoisted across files the way they
were in the single inline script).

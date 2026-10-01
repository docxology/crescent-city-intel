# gui/static

Static HTML assets served by the GUI: index.html (SPA), docs.html (OpenAPI
Swagger UI at /api/docs), docs-dashboard.html (docs/modules dashboard at
/docs-dashboard.html), structured-queries.html (history/compare/similar), and
phase10-legal.html (ordinal, citation, and recorded-amendment-year analysis).
The SPA imports `assets/gui-app.js` as one ES module entry point. Dedicated
pages import their own controllers; module dependencies and shared state are
explicit. Generated markup passes through `CCGui.render()`, and each reader
request has cancellation, retry, a deadline, and live status announcements.
The topic map provides a keyboard section picker; wildfire note anchors
accept map percentages as layout coordinates.

import { CCGui } from "./gui-runtime.js";
import { initializeStandalone, runReaderTask, readerAwait, readerFetch } from "./reader-lifecycle.js";

    function apiFetch(url, opts) {
      return CCGui.apiFetch(url, opts);
    }
    function show(id) { document.getElementById(id).classList.remove("hidden"); }
    function hide(id) { document.getElementById(id).classList.add("hidden"); }
    async function load() { return runReaderTask("dashboard-content", async signal => {
    try {
        const resp = await readerAwait(readerFetch(apiFetch, signal, "/api/docs/modules"), signal);
        if (!resp.ok) {
            hide("dashboard-loading");
            show("dashboard-error-state");
            return;
        }
        const data = await readerAwait(resp.json(), signal);
        hide("dashboard-loading");
        if (data.empty) {
            show("dashboard-empty-state");
            return;
        }
        const s = data.counts;
        CCGui.render(document.getElementById("dashboard-summary"), `<div class="stat"><b>${s.modules}</b>modules in src/</div>` +
    `<div class="stat"><b>${s.documented}</b>documented</div>` +
    `<div class="stat ${s.undocumented ? 'miss' : 'ok'}"><b>${s.undocumented}</b>undocumented</div>` +
    `<div class="stat"><b>${s.docsSurfaces}</b>docs surfaces</div>`);
        const tbody = document.getElementById("modules-body");
        for (const m of data.modules) {
            const docs = m.documentedBy.length
                ? m.documentedBy.map(d => `<code>${d}</code>`).join(" ")
                : '<span class="miss">not documented</span>';
            CCGui.render(tbody, tbody.innerHTML + CCGui.sanitizeHtml(`<tr><td><code>${m.file}</code></td><td>${docs}</td></tr>`));
        }
        if (data.modules.length === 0)
            show("dashboard-roster-empty");
        const surfaces = document.getElementById("surfaces-body");
        for (const d of data.docsSurfaces) {
            const missing = d.missingFiles.length
                ? `<span class="miss">${d.missingFiles.length}</span>`
                : '<span class="ok">0</span>';
            CCGui.render(surfaces, surfaces.innerHTML + CCGui.sanitizeHtml(`<tr><td><code>${d.file}</code></td><td>${d.namesModules}</td><td>${missing}</td></tr>`));
        }
        show("dashboard-content");
    }
    catch {
        if (signal.aborted)
            return;
        hide("dashboard-loading");
        show("dashboard-error-state");
    }
}); }
    load();

initializeStandalone();

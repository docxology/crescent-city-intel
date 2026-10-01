import { CCGui } from "./gui-runtime.js";
import { initializeStandalone, runReaderTask, readerAwait, readerFetch } from "./reader-lifecycle.js";

    function apiFetch(url, opts) {
      return CCGui.apiFetch(url, opts);
    }
    function show(id){document.getElementById(id).classList.remove("hidden");}
    function hide(id){document.getElementById(id).classList.add("hidden");}
    function setError(id,msg){const el=document.getElementById(id);el.textContent=msg;el.classList.remove("hidden");}
    function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

    async function resolveGuid(input, signal) {
      if (/^\d{5,20}$/.test(input) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{27}$/i.test(input)) return input;
      const resp = await readerFetch(apiFetch, signal, `/api/search?q=${encodeURIComponent(input)}&field=number&limit=1`);
      const data = await readerAwait(resp.json(), signal);
      return data.results?.[0]?.section?.guid ?? null;
    }

    document.getElementById("history-load").addEventListener("click", async () => { return runReaderTask("history-content", async signal => {
    const input = document.getElementById("history-guid").value.trim();
    if (!input)
        return;
    hide("history-empty-result");
    hide("history-empty");
    hide("history-error");
    const out = document.getElementById("history-content");
    CCGui.render(out, "<p>Loading…</p>");
    try {
        const guid = await readerAwait(resolveGuid(input, signal), signal);
        if (!guid) {
            CCGui.render(out, "");
            show("history-empty-result");
            return;
        }
        const resp = await readerAwait(readerFetch(apiFetch, signal, `/api/history/${encodeURIComponent(guid)}`), signal);
        if (resp.status === 404) {
            CCGui.render(out, "");
            show("history-empty-result");
            return;
        }
        const data = await readerAwait(resp.json(), signal);
        if (!resp.ok) {
            CCGui.render(out, "");
            setError("history-error", data.error || `Request failed (${resp.status})`);
            return;
        }
        let html = `<h3>§ ${esc(data.number)}</h3><p>${esc(data.rawHistory ?? "")}</p>`;
        if (data.entries?.length) {
            html += '<table><thead><tr><th>Ordinance</th><th>Action</th><th>Year</th></tr></thead><tbody>';
            for (const e of data.entries)
                html += `<tr><td>${esc(e.ordinance)}</td><td>${esc(e.action)}</td><td>${esc(e.date ?? "—")}</td></tr>`;
            html += "</tbody></table>";
        }
        else {
            html += '<p class="empty-state">This section carries no parsed history entries.</p>';
        }
        CCGui.render(out, html);
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(out, "");
        setError("history-error", "Failed to reach /api/history");
    }
}); });

    document.getElementById("compare-run").addEventListener("click", async () => { return runReaderTask("compare-result", async signal => {
    const in1 = document.getElementById("compare-guid1").value.trim();
    const in2 = document.getElementById("compare-guid2").value.trim();
    if (!in1 || !in2)
        return;
    hide("compare-empty");
    hide("compare-error");
    const out = document.getElementById("compare-result");
    CCGui.render(out, "<p>Comparing…</p>");
    try {
        const g1 = await readerAwait(resolveGuid(in1, signal), signal);
        const g2 = await readerAwait(resolveGuid(in2, signal), signal);
        if (!g1 || !g2) {
            CCGui.render(out, "");
            show("compare-empty");
            return;
        }
        const resp = await readerAwait(readerFetch(apiFetch, signal, `/api/compare?guid1=${encodeURIComponent(g1)}&guid2=${encodeURIComponent(g2)}`), signal);
        const data = await readerAwait(resp.json(), signal);
        if (!resp.ok) {
            CCGui.render(out, "");
            setError("compare-error", data.error || `Request failed (${resp.status})`);
            return;
        }
        const pct = (data.similarity * 100).toFixed(1);
        CCGui.render(out, `<p>Similarity <span class="metric">${pct}%</span> · word delta <span class="metric">${data.wordCountDelta > 0 ? "+" : ""}${data.wordCountDelta}</span></p>` +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">` +
    `<div><h5>Only in § ${esc(data.number1)}</h5><div class="only">${esc(data.onlyInFirst.slice(0, 20).join("\n"))}</div></div>` +
    `<div><h5>Only in § ${esc(data.number2)}</h5><div class="only">${esc(data.onlyInSecond.slice(0, 20).join("\n"))}</div></div></div>`);
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(document.getElementById("compare-result"), "");
        setError("compare-error", "Failed to reach /api/compare");
    }
}); });

    document.getElementById("similar-run").addEventListener("click", async () => { return runReaderTask("similar-result", async signal => {
    const input = document.getElementById("similar-guid").value.trim();
    const limit = parseInt(document.getElementById("similar-limit").value, 10) || 10;
    if (!input)
        return;
    hide("similar-empty-result");
    hide("similar-error");
    const out = document.getElementById("similar-result");
    CCGui.render(out, "<p>Searching…</p>");
    try {
        const guid = await readerAwait(resolveGuid(input, signal), signal);
        if (!guid) {
            CCGui.render(out, "");
            show("similar-empty-result");
            return;
        }
        const resp = await readerAwait(readerFetch(apiFetch, signal, `/api/similar/${encodeURIComponent(guid)}?limit=${limit}`), signal);
        const data = await readerAwait(resp.json(), signal);
        if (!resp.ok) {
            CCGui.render(out, "");
            setError("similar-error", data.error || `Request failed (${resp.status})`);
            return;
        }
        if (!data.results?.length) {
            CCGui.render(out, "");
            show("similar-empty-result");
            return;
        }
        let html = '<table><thead><tr><th>Section</th><th>Score</th><th>Why</th></tr></thead><tbody>';
        for (const r of data.results)
            html += `<tr><td>${esc(r.section?.number ?? r.section?.guid)}</td><td>${Number(r.score ?? 0).toFixed(2)}</td><td>${esc(r.reason)}</td></tr>`;
        CCGui.render(out, html + "</tbody></table>");
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(out, "");
        setError("similar-error", "Failed to reach /api/similar");
    }
}); });

initializeStandalone();

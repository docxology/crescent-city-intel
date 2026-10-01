import { CCGui } from "./gui-runtime.js";
import { initializeStandalone, runReaderTask, readerAwait, readerFetch } from "./reader-lifecycle.js";

    function apiFetch(url, opts) {
      return CCGui.apiFetch(url, opts);
    }
    function show(id){document.getElementById(id).classList.remove("hidden");}
    function hide(id){document.getElementById(id).classList.add("hidden");}
    function setError(id,msg){const el=document.getElementById(id);el.textContent=msg;el.classList.remove("hidden");}
    function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

    document.getElementById("ordinals-load").addEventListener("click", async () => { return runReaderTask("ordinals-content", async signal => {
    hide("ordinals-empty");
    hide("ordinals-empty-result");
    hide("ordinals-error");
    const out = document.getElementById("ordinals-content");
    CCGui.render(out, "<p>Loading…</p>");
    try {
        const resp = await readerAwait(readerFetch(apiFetch, signal, "/api/ordinals?limit=200"), signal);
        const data = await readerAwait(resp.json(), signal);
        if (!resp.ok) {
            CCGui.render(out, "");
            setError("ordinals-error", data.error || `Request failed (${resp.status})`);
            return;
        }
        if (data.empty || !data.sequences?.length) {
            CCGui.render(out, "");
            show("ordinals-empty-result");
            return;
        }
        let html = `<div class="grid">`
            + `<div class="card"><h4>Sections scanned</h4><div class="metric">${data.summary.sectionsScanned}</div></div>`
            + `<div class="card"><h4>Titles</h4><div class="metric">${data.summary.titles}</div></div>`
            + `<div class="card"><h4>Missing ordinals</h4><div class="metric">${data.summary.totalGaps}</div></div>`
            + `<div class="card"><h4>Unparseable segments</h4><div class="metric">${data.summary.totalUnparseable}</div></div>`
            + `</div>`;
        html += '<table><thead><tr><th>Title</th><th>Chapters</th><th>Missing between</th><th>Unparseable</th><th>Density</th></tr></thead><tbody>';
        for (const seq of data.sequences) {
            const gaps = seq.gaps.length
                ? seq.gaps.slice(0, 12).map(g => `<span class="missing">${esc(g.missing)}</span>`).join(", ") + (seq.gaps.length > 12 ? ` … (+${seq.gaps.length - 12} more)` : "")
                : '<span style="color:#15803d">dense</span>';
            html += `<tr><td>${esc(seq.title)}</td><td>${seq.ordinals.length}</td><td>${gaps}</td><td>${esc(seq.unparseable.join(", ") || "—")}</td><td>${(seq.density * 100).toFixed(0)}%</td></tr>`;
        }
        html += "</tbody></table>";
        if (data.truncated)
            html += '<p style="color:#555;font-size:12px;margin-top:8px">List bounded at 200 titles; the summary reports the true totals.</p>';
        CCGui.render(out, html);
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(out, "");
        setError("ordinals-error", "Failed to reach /api/ordinals");
    }
}); });

    document.getElementById("crosslinks-load").addEventListener("click", async () => { return runReaderTask("crosslinks-content", async signal => {
    hide("crosslinks-empty");
    hide("crosslinks-empty-result");
    hide("crosslinks-error");
    const out = document.getElementById("crosslinks-content");
    CCGui.render(out, "<p>Loading…</p>");
    try {
        const resp = await readerAwait(readerFetch(apiFetch, signal, "/api/citations/index?limit=500"), signal);
        const data = await readerAwait(resp.json(), signal);
        if (!resp.ok) {
            CCGui.render(out, "");
            setError("crosslinks-error", data.error || `Request failed (${resp.status})`);
            return;
        }
        if (data.empty || !data.crosslinks?.length) {
            CCGui.render(out, "");
            show("crosslinks-empty-result");
            return;
        }
        let html = `<div class="grid">`
            + `<div class="card"><h4>Citations found</h4><div class="metric">${data.summary.citationsFound}</div></div>`
            + `<div class="card"><h4>Linked to official text</h4><div class="metric">${data.summary.linkableCitations}</div></div>`
            + `<div class="card"><h4>No stable target</h4><div class="metric">${data.summary.unlinkedCitations}</div></div>`
            + `<div class="card"><h4>Distinct codes cited</h4><div class="metric">${data.summary.distinctTargets.length}</div></div>`
            + `</div>`;
        html += '<p style="font-size:12px;color:#555">Codes cited: ' + data.summary.distinctTargets.map(esc).join(" · ") + "</p>";
        html += '<table><thead><tr><th>Section</th><th>Citation</th><th>Target</th><th>Link</th></tr></thead><tbody>';
        for (const row of data.crosslinks) {
            const link = row.href
                ? `<a class="xlink" href="${esc(row.href)}" target="_blank" rel="noopener noreferrer">official text ↗</a>`
                : '<span class="nodate">no stable target — unlinked</span>';
            const internal = row.internalGuid
                ? ` · <a class="xlink" href="/?section=${encodeURIComponent(row.internalGuid)}">in-corpus section</a>`
                : "";
            html += `<tr><td>&sect; ${esc(row.fromNumber)}</td><td>${esc(row.citation)}</td><td>${esc(row.targetLabel || row.type)}</td><td>${link}${internal}</td></tr>`;
        }
        html += "</tbody></table>";
        if (data.truncated)
            html += '<p style="color:#555;font-size:12px;margin-top:8px">List bounded at 500 rows; the summary reports the true totals.</p>';
        CCGui.render(out, html);
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(out, "");
        setError("crosslinks-error", "Failed to reach /api/citations/index");
    }
}); });

    document.getElementById("effective-load").addEventListener("click", async () => { return runReaderTask("effective-content", async signal => {
    hide("effective-empty");
    hide("effective-empty-result");
    hide("effective-error");
    const out = document.getElementById("effective-content");
    CCGui.render(out, "<p>Loading…</p>");
    const guid = document.getElementById("effective-guid").value.trim();
    try {
        const resp = await readerAwait(readerFetch(apiFetch, signal, "/api/effective-dates?limit=500" + (guid ? `&guid=${encodeURIComponent(guid)}` : "")), signal);
        const data = await readerAwait(resp.json(), signal);
        if (!resp.ok) {
            CCGui.render(out, "");
            setError("effective-error", data.error || `Request failed (${resp.status})`);
            return;
        }
        if (!data.sections?.length) {
            CCGui.render(out, "");
            show("effective-empty-result");
            return;
        }
        let html = `<div class="grid">`
            + `<div class="card"><h4>Sections scanned</h4><div class="metric">${data.summary.sectionsScanned}</div></div>`
            + `<div class="card"><h4>With a recorded year</h4><div class="metric">${data.summary.sectionsWithDate}</div></div>`
            + `<div class="card"><h4>No date on record</h4><div class="metric">${data.summary.sectionsWithoutDate}</div></div>`
            + `<div class="card"><h4>Year range</h4><div class="metric" style="font-size:18px">${data.summary.earliestYear ?? "—"}–${data.summary.latestYear ?? "—"}</div></div>`
            + `</div>`;
        html += '<table><thead><tr><th>Section</th><th>Recorded amendment year</th><th>Most recent action</th><th>History line</th></tr></thead><tbody>';
        for (const row of data.sections) {
            const year = row.effectiveYear === null
                ? '<span class="nodate">no recorded amendment year on record</span>'
                : `<strong>${row.effectiveYear}</strong>`;
            const action = row.effectiveYear === null ? "—" : `${esc(row.ordinance ?? "")} ${esc(row.action ?? "")}`;
            html += `<tr><td>&sect; ${esc(row.sectionNumber)}</td><td>${year}</td><td>${action}</td><td style="font-size:.8rem;color:#555">${esc(row.derivedFrom || "—")}</td></tr>`;
        }
        html += "</tbody></table>";
        if (data.truncated)
            html += '<p style="color:#555;font-size:12px;margin-top:8px">List bounded at 500 rows; the summary reports the true totals.</p>';
        CCGui.render(out, html);
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(out, "");
        setError("effective-error", "Failed to reach /api/effective-dates");
    }
}); });

initializeStandalone();

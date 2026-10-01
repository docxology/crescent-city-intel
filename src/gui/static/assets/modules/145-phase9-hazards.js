import { CCGui } from "../gui-runtime.js";
import { runReaderTask, readerAwait, readerFetch } from "../reader-lifecycle.js";
import { apiFetch } from "./10-core.js";
// 145-phase9-hazards.js — Phase 9 GUI surfaces: Air Quality widget, wildfire
// distance-band map, and user-anchored annotations over that map. Reads the
// real alert endpoints (/api/alerts/airquality, /api/alerts/wildfire) and the
// /api/annotations store. Absent data renders an explicit empty state, never
// a fabricated reading.
(function () {
    const AQ_MISSING_HTML = '<p class="phase9-empty-state" data-empty="airquality">No air quality data yet — run <code>bun run alerts:airquality</code> to fetch the latest EPA AirNow reading.</p>';
    const AQ_UNAVAILABLE_HTML = '<p class="phase9-empty-state" data-empty="airquality">Air quality data is unavailable right now; the report will appear after the next monitor run.</p>';
    const WF_MISSING_HTML = '<p class="phase9-empty-state" data-empty="wildfire">No wildfire data yet — run <code>bun run alerts:wildfire</code> to fetch the current CAL FIRE incident report.</p>';
    const WF_EMPTY_HTML = '<p class="phase9-empty-state" data-empty="wildfire-incidents">No active CAL FIRE incidents in the Del Norte search area.</p>';
    const ANNOTATION_EMPTY_HTML = '<p class="phase9-empty-state" data-empty="annotations">No annotations yet — choose map percentages or click the map, then save a note.</p>';
    const AQ_STALE_MS = 24 * 60 * 60 * 1000;

    function phase9EscapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    async function fetchAlertJson(url, signal) {
        const resp = await readerFetch(apiFetch, signal, url);
        if (resp.status === 404) return { state: 'missing' };
        if (!resp.ok) return { state: 'unavailable' };
        return { state: 'ok', data: await resp.json() };
    }

    function aqiColor(level) {
        return ({
            GOOD: '#2ecc71', MODERATE: '#f1c40f', UNHEALTHY_SENSITIVE: '#e67e22',
            UNHEALTHY: '#e74c3c', VERY_UNHEALTHY: '#9b59b6', HAZARDOUS: '#7d3c98',
        })[level] || '#888';
    }

    async function loadAirQualityWidget() { return runReaderTask("aq-widget-content", async signal => {
    const target = document.getElementById('aq-widget-content');
    const result = await readerAwait(fetchAlertJson('/api/alerts/airquality', signal), signal);
    if (result.state === 'missing') {
        CCGui.render(target, AQ_MISSING_HTML);
        return;
    }
    if (result.state === 'unavailable') {
        CCGui.render(target, AQ_UNAVAILABLE_HTML);
        return;
    }
    const report = result.data;
    const age = Date.now() - Date.parse(String(report.timestamp || ''));
    const isStale = !Number.isFinite(age) || age > AQ_STALE_MS;
    const readings = Array.isArray(report.readings) ? report.readings : [];
    const trend = await readerAwait(fetchAlertJson('/api/alerts/airquality/history?limit=14', signal), signal);
    const trendEvents = trend.state === 'ok' && Array.isArray(trend.data.alerts) ? trend.data.alerts : null;
    const trendHtml = trendEvents === null
        ? '<p class="phase9-empty-state" data-empty="aq-trend">Trend unavailable — the alert history could not be read.</p>'
        : trendEvents.length === 0
            ? '<p class="phase9-empty-state" data-empty="aq-trend">No recorded air-quality events yet — the trend appears after the first monitor run.</p>'
            : `<details><summary>Recent air-quality events (${trendEvents.length})</summary><ul>${trendEvents.slice().reverse().map(ev => `<li>${phase9EscapeHtml(String(ev.timestamp || ''))}: ${phase9EscapeHtml(String(ev.summary || ev.title || ''))}</li>`).join('')}</ul></details>`;
    CCGui.render(target, `
            <div class="phase9-current-aqi">
              <span class="phase9-aqi-value" style="color:${aqiColor(report.level)};font-size:1.6rem;font-weight:700;">AQI ${typeof report.maxAqi === 'number' ? report.maxAqi : '—'}</span>
              <span class="phase9-aqi-level">${phase9EscapeHtml(String(report.level || 'Unknown'))}</span>
              <span class="phase9-aqi-summary">${phase9EscapeHtml(String(report.summary || ''))}</span>
            </div>
            ${report.advisory ? `<p style="color:var(--warning, #f1c40f);margin:0.4rem 0 0 0;">Advisory: ${phase9EscapeHtml(String(report.advisory))}</p>` : ''}
            ${isStale ? `<p class="phase9-stale-note" data-stale="airquality">Stale reading — last updated ${phase9EscapeHtml(String(report.timestamp || 'unknown time'))}, older than 24 hours. Run the monitor again to refresh.</p>` : ''}
            ${readings.length === 0 ? '<p class="phase9-empty-state" data-empty="airquality-readings">The report carries no individual parameter readings (the public KML feed reports one combined value).</p>' : `<ul>${readings.map(r => `<li>${phase9EscapeHtml(String(r.parameter || ''))}: AQI ${phase9EscapeHtml(String(r.aqi))} — ${phase9EscapeHtml(String(r.category || ''))}</li>`).join('')}</ul>`}
            ${trendHtml}`);
}); }

    function renderWildfireMap(report, incidents) {
        const size = 300;
        const center = size / 2;
        const maxRadius = center - 24;
        const searchRadiusKm = typeof report.searchRadiusKm === 'number' ? report.searchRadiusKm : 150;
        const markers = incidents.map((incident, i) => {
            const radius = typeof incident.distanceKm === 'number'
                ? Math.max(18, (incident.distanceKm / searchRadiusKm) * maxRadius)
                : maxRadius;
            const angle = (2 * Math.PI * i) / incidents.length - Math.PI / 2;
            const cx = center + radius * Math.cos(angle);
            const cy = center + radius * Math.sin(angle);
            const fill = incident.hasEvacuationOrders ? '#e74c3c' : '#e67e22';
            return `<g data-incident-index="${i}"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${fill}" stroke="var(--border, #555)" stroke-width="1"></circle><text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" text-anchor="middle" font-size="9">${phase9EscapeHtml(String(incident.name || '').slice(0, 18))}</text></g>`;
        }).join('');
        const rings = [0.25, 0.5, 1].map(f => `<circle cx="${center}" cy="${center}" r="${(maxRadius * f).toFixed(1)}" fill="none" stroke="var(--border, #555)" stroke-dasharray="4 3"></circle>`).join('');
        return `
            <svg id="wildfire-map-canvas" viewBox="0 0 ${size} ${size}" width="100%" style="max-width:${size}px;display:block;" role="img" aria-label="Wildfire incidents placed by distance from Crescent City">
              ${rings}
              <circle cx="${center}" cy="${center}" r="5" fill="var(--accent, #3498db)"></circle>
              <text x="${center}" y="${center + 16}" text-anchor="middle" font-size="10">Crescent City</text>
              ${markers}
            </svg>
            <p class="phase9-map-legend">Ring distance is real — each incident sits at its recorded distance from Crescent City (scaled to the ${searchRadiusKm} km search radius). The angular position is layout only: the CAL FIRE feed carries distance, not bearing. Red markers have active evacuation orders.</p>
            <ul class="phase9-incident-list">${incidents.map(inc => `<li><strong>${phase9EscapeHtml(String(inc.name || 'Unnamed incident'))}</strong> — ${phase9EscapeHtml(String(inc.acres))} acres, ${phase9EscapeHtml(String(inc.containmentPercent))}% contained, ${typeof inc.distanceKm === 'number' ? phase9EscapeHtml(String(inc.distanceKm)) + ' km away' : 'distance unknown'}${inc.hasEvacuationOrders ? ' — <em>evacuation orders active</em>' : ''}</li>`).join('')}</ul>`;
    }

    async function loadWildfireMap() { return runReaderTask("wildfire-map-content", async signal => {
    const target = document.getElementById('wildfire-map-content');
    const result = await readerAwait(fetchAlertJson('/api/alerts/wildfire', signal), signal);
    if (result.state === 'missing') {
        CCGui.render(target, WF_MISSING_HTML);
        loadAnnotations();
        return;
    }
    if (result.state === 'unavailable') {
        CCGui.render(target, '<p class="phase9-empty-state" data-empty="wildfire">Wildfire data is unavailable right now; the map appears after the next monitor run.</p>');
        loadAnnotations();
        return;
    }
    const report = result.data;
    const incidents = Array.isArray(report.incidents) ? report.incidents : [];
    if (incidents.length === 0) {
        CCGui.render(target, WF_EMPTY_HTML);
        loadAnnotations();
        return;
    }
    CCGui.render(target, renderWildfireMap(report, incidents));
    const canvas = document.getElementById('wildfire-map-canvas');
    canvas.addEventListener('click', event => {
        const rect = canvas.getBoundingClientRect();
        pendingAnchor = {
            x: ((event.clientX - rect.left) / rect.width) * 100,
            y: ((event.clientY - rect.top) / rect.height) * 100,
        };
        document.getElementById('annotation-place-indicator').textContent =
            `Anchor placed at ${pendingAnchor.x.toFixed(0)}%, ${pendingAnchor.y.toFixed(0)}% of the map.`;
    });
    loadAnnotations();
}); }

    let pendingAnchor = null;
    document.getElementById('annotation-anchor').addEventListener('click', () => {
      const x = Number(document.getElementById('annotation-x').value), y = Number(document.getElementById('annotation-y').value);
      const status = document.getElementById('annotation-place-indicator');
      if (![x,y].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) { status.textContent = 'Enter map percentages from 0 through 100.'; return; }
      pendingAnchor = {x,y}; status.textContent = `Anchor placed at ${x}%, ${y}% of the map; these are layout coordinates.`; document.getElementById('annotation-text').focus();
    });

    async function loadAnnotations() { return runReaderTask("annotation-list", async signal => {
    const list = document.getElementById('annotation-list');
    try {
        const resp = await readerAwait(readerFetch(apiFetch, signal, '/api/annotations'), signal);
        if (!resp.ok) {
            CCGui.render(list, '<p class="phase9-empty-state" data-empty="annotations">Annotations are unavailable right now.</p>');
            return;
        }
        const payload = await readerAwait(resp.json(), signal);
        const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
        if (annotations.length === 0) {
            CCGui.render(list, ANNOTATION_EMPTY_HTML);
            return;
        }
        const droppedNote = payload.droppedPastBound > 0
            ? `<p class="phase9-bound-note">${payload.droppedPastBound} older note(s) were dropped by the ${ANNOTATION_MAX_BOUND}-note storage bound.</p>`
            : '';
        CCGui.render(list, `${droppedNote}<ul>${annotations.map(a => `<li data-annotation-id="${phase9EscapeHtml(a.id)}">📍 ${phase9EscapeHtml(a.text)} <button class="btn" type="button" data-delete-annotation="${phase9EscapeHtml(a.id)}">Delete</button></li>`).join('')}</ul>`);
        for (const button of list.querySelectorAll('[data-delete-annotation]')) {
            button.addEventListener('click', async () => {
                const response = await runReaderTask('annotation-list', async signal => { const response = await readerAwait(readerFetch(apiFetch, signal, `/api/annotations?id=${encodeURIComponent(button.getAttribute('data-delete-annotation'))}`, { method: 'DELETE' }), signal); if (!response.ok) throw new Error('Delete failed'); return response; });
                if (response?.ok) loadAnnotations();
            });
        }
    }
    catch {
        if (signal.aborted)
            return;
        CCGui.render(list, '<p class="phase9-empty-state" data-empty="annotations">Annotations are unavailable right now.</p>');
    }
}); }

    const ANNOTATION_MAX_BOUND = 200;

    async function saveAnnotation(event) {
        event.preventDefault(); return runReaderTask("annotation-place-indicator", async signal => {
        const textInput = document.getElementById('annotation-text');
        const status = document.getElementById('annotation-place-indicator');
        if (!pendingAnchor) {
            status.textContent = 'Choose map percentages or click the wildfire map first to place the note anchor.';
            return;
        }
        const text = String(textInput.value || '').trim();
        if (!text) {
            status.textContent = 'Enter note text before saving.';
            return;
        }
        const resp = await readerAwait(readerFetch(apiFetch, signal, '/api/annotations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x: pendingAnchor.x, y: pendingAnchor.y, text }),
        }), signal);
        if (resp.ok) {
            pendingAnchor = null;
            textInput.value = '';
            status.textContent = 'Note saved.';
            loadAnnotations();
        } else {
            const err = await readerAwait(resp.json().catch(() => ({})), signal);
            status.textContent = `Save failed: ${err.error || 'unknown error'}`;
        }
    }); }

    document.getElementById('annotation-form')?.addEventListener('submit', saveAnnotation);

    // Loaded when the alerts panel opens, mirroring the lazy-load pattern in 60-alerts.js.
    document.getElementById('alerts-toggle')?.addEventListener('click', () => {
        setTimeout(() => {
            if (document.getElementById('alerts-panel').style.display === 'none') return;
            loadAirQualityWidget();
            loadWildfireMap();
        }, 0);
    });
})();

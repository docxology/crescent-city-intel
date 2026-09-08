// 110-feeds.js — civic dashboard, alert timeline, search analytics, glossary, xrefs, report, curated feed, API explorer.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // ─ Overview ─
    async function loadIntelOverview() {
      const grid = document.getElementById('intel-overview-grid');
      try {
        const [overview, health, alerts, timeline] = await Promise.all([
          apiFetch('/api/analytics/overview').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/health').then(r => r.json()).catch(() => null),
          apiFetch('/api/monitor/alerts').then(r => r.json()).catch(() => null),
          apiFetch('/api/alerts/timeline').then(r => r.json()).catch(() => null),
        ]);
        let html = '';
        if (overview) {
          const signals = Array.isArray(overview.signals) ? overview.signals.slice(0, 8) : [];
          html += `<div class="intel-card" style="grid-column:1/-1"><h4>${escapeHtml(overview.headline || 'Current analytical signal')}</h4><p style="line-height:1.55">${escapeHtml(overview.summary || '')}</p><div class="label">${escapeHtml(overview.llm?.status === 'ok' ? `LLM summary · ${overview.llm.provider}/${overview.llm.model}` : `Deterministic summary · LLM ${overview.llm?.status || 'not recorded'}`)} · evidence ${escapeHtml(String(overview.inputFingerprint || '').slice(0, 16))}…</div>${signals.length ? `<ul style="margin:10px 0 0 18px">${signals.map(signal => `<li><strong>${escapeHtml(signal.title)}</strong> — ${escapeHtml(signal.detail)} <span class="label">Next: ${escapeHtml(signal.nextStep)}</span></li>`).join('')}</ul>` : '<div class="label">No warning signals were recorded.</div>'}</div>`;
          html += `<div class="intel-card"><h4>Code sections</h4><div class="metric">${overview.metrics.code.sections}</div><div class="label">${overview.metrics.code.articles} articles · ${overview.metrics.code.words} words</div></div><div class="intel-card"><h4>LLM briefs</h4><div class="metric">${overview.metrics.content.curated}</div><div class="label">source-grounded items</div></div><div class="intel-card"><h4>Alert events</h4><div class="metric">${overview.metrics.alerts.totalEvents}</div><div class="label">historical monitor events</div></div><div class="intel-card"><h4>Source gaps</h4><div class="metric">${overview.metrics.sources.missing}</div><div class="label">unavailable or stale</div></div>`;
        }
        if (health) {
          html += `<div class="intel-card"><h4>System Status</h4><div class="metric">${health.status === 'ok' ? '✅' : '⚠️'}</div><div class="label">Health</div></div>`;
          if (health.manifest) {
            html += `<div class="intel-card"><h4>Data Freshness</h4><div class="metric">${health.manifest.ageDays}</div><div class="label">days old ${health.manifest.stale ? '(⚠️ stale)' : '✅'}</div></div>`;
          }
          if (health.manifest?.sectionCount) {
            html += `<div class="intel-card"><h4>Sections</h4><div class="metric">${health.manifest.sectionCount}</div><div class="label">code sections</div></div>`;
          }
          if (health.alertLevel) {
            const colors = {CALM:'badge-green',WATCH:'badge-yellow',WARNING:'badge-orange',EMERGENCY:'badge-red'};
            html += `<div class="intel-card"><h4>Composite Alert</h4><div class="metric"><span class="intel-badge ${colors[health.alertLevel]||'badge-blue'}">${health.alertLevel}</span></div></div>`;
          }
        }
        if (timeline) {
          html += `<div class="intel-card"><h4>Total Alert Events</h4><div class="metric">${timeline.totalEvents}</div><div class="label">across all monitors</div></div>`;
          if (timeline.mostActiveType) {
            html += `<div class="intel-card"><h4>Most Active Monitor</h4><div class="metric" style="font-size:18px">${timeline.mostActiveType}</div></div>`;
          }
        }
        // Domains
        try {
          const domains = await apiFetch('/api/domains').then(r => r.json());
          html += `<div class="intel-card"><h4>Intelligence Domains</h4><div class="metric">${domains.length || 12}</div><div class="label">civic domains</div></div>`;
        } catch { /* skip */ }
        // Provider and source-health diagnostics are operational facts, not
        // inferred from a successful page load.
        if (health?.chatProvider) {
          html += `<div class="intel-card"><h4>Chat Provider</h4><div class="metric" style="font-size:18px">${escapeHtml(health.chatProvider)}</div><div class="label">${escapeHtml(health.chatModel || '')}</div></div>`;
        }
        for (const [label, sources] of [['News', health?.newsSources], ['Meetings', health?.meetingsSources], ['YouTube', health?.youtubeSources], ['Triplicate', health?.triplicateSources], ['Alerts', health?.alertSources]]) {
          if (!Array.isArray(sources)) continue;
          const unavailable = sources.filter(s => s.status === 'unavailable' || s.status === 'stale').length;
          html += `<div class="intel-card"><h4>${label} Sources</h4><div class="metric">${sources.length - unavailable}/${sources.length}</div><div class="label">${unavailable ? '⚠️ unavailable/stale' : '✅ healthy'}</div></div>`;
        }
        html += `<div class="intel-card"><h4>API Contract</h4><div class="metric">v2.5.1</div><div class="label">OpenAPI 3.0.3 · run validate</div></div>`;
        html += `<div class="intel-card"><h4>Version</h4><div class="metric" style="font-size:18px">v2.5.1</div><div class="label">deterministic gate: bun run validate</div></div>`;
        grid.innerHTML = html || '<p style="color:var(--text-secondary)">No data available</p>';
      } catch (err) {
        grid.innerHTML = '<p style="color:var(--text-secondary)">Failed to load overview</p>';
      }
    }

    // ─ Alert Timeline ─
    async function loadAlertTimeline() {
      const el = document.getElementById('alert-timeline-content');
      try {
        const data = await apiFetch('/api/alerts/timeline').then(r => r.json());
        let html = '';
        // Type stats table
        if (data.typeStats?.length > 0) {
          html += '<table class="intel-table"><thead><tr><th>Monitor</th><th>Events</th><th>First</th><th>Last</th><th>Avg/Day</th></tr></thead><tbody>';
          for (const s of data.typeStats) {
            const total = Number.isFinite(s.totalEvents) ? Math.max(0, Math.floor(s.totalEvents)) : 0;
            const average = Number.isFinite(s.avgPerDay) ? s.avgPerDay.toFixed(2) : '—';
            const first = alertTrendText(s.firstEvent, 10) || '—';
            const last = alertTrendText(s.lastEvent, 10) || '—';
            html += `<tr><td>${escapeHtml(alertTrendText(s.type, 40) || 'unknown')}</td><td>${total}</td><td>${escapeHtml(first)}</td><td>${escapeHtml(last)}</td><td>${average}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          html += '<p style="color:var(--text-secondary)">No alert events recorded. Run: bun run alerts</p>';
        }
        // Recent events
        if (data.mostRecentAlert) {
          const r = data.mostRecentAlert;
          const description = alertTrendText(r.description, 100) || 'No description';
          html += `<div style="margin-top:16px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)"><strong>Most Recent Alert:</strong> <span class="intel-badge badge-blue">${escapeHtml(alertTrendText(r.type, 40) || 'unknown')}</span> ${escapeHtml(description)} — ${escapeHtml(alertTrendTimestamp(r.timestamp))}</div>`;
        }
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load alert timeline</p>'; }
    }

    // ─ Search Analytics ─
    async function loadSearchAnalytics() {
      const el = document.getElementById('search-analytics-content');
      try {
        const data = await apiFetch('/api/search/analytics').then(r => r.json());
        let html = `<p style="margin-bottom:12px"><strong>Total queries:</strong> ${data.totalQueries}</p>`;
        if (data.topTerms?.length > 0) {
          html += '<table class="intel-table"><thead><tr><th>Term</th><th>Count</th></tr></thead><tbody>';
          for (const t of data.topTerms) {
            html += `<tr><td>${t.term}</td><td>${t.count}</td></tr>`;
          }
          html += '</tbody></table>';
        } else {
          html += '<p style="color:var(--text-secondary)">No search queries logged yet. Search the code to populate analytics.</p>';
        }
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load search analytics</p>'; }
    }

    // ─ Glossary ─
    let glossaryData = null;
    async function loadGlossary() {
      const el = document.getElementById('glossary-content');
      try {
        const data = await apiFetch('/api/glossary').then(r => r.json());
        glossaryData = data.entries || [];
        renderGlossary('');
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load glossary</p>'; }
    }
    function renderGlossary(filter) {
      const el = document.getElementById('glossary-content');
      if (!glossaryData) return;
      const filtered = filter ? glossaryData.filter(g => g.term.toLowerCase().includes(filter.toLowerCase()) || g.definition.toLowerCase().includes(filter.toLowerCase())) : glossaryData;
      let html = `<p style="margin-bottom:8px;color:var(--text-secondary)">${filtered.length} of ${glossaryData.length} definitions</p>`;
      // The glossary is the SPA's longest flat list (row-capped at 200).
      // Above GLOSSARY_VIRTUAL_THRESHOLD rows render through virtual-list.js
      // (table mode): row markup is unchanged, fixed-height spacer <tr>s
      // preserve the scroll extent, and only the visible window exists in
      // the DOM. The legacy full-render path is kept for smaller sets.
      if (filtered.length > GLOSSARY_VIRTUAL_THRESHOLD) {
        if (!glossaryVirtualList) {
          glossaryVirtualList = createVirtualList({
            container: el,
            mode: "table",
            rowHost: glossaryTbodyHost(el, html),
            renderItem: (g) => `<td><strong>${g.term}</strong></td><td>${g.definition.substring(0,200)}</td><td>${g.sectionNumber}</td>`,
          });
        }
        glossaryVirtualList.setItems(filtered.slice(0, 200));
        return;
      }
      destroyGlossaryVirtualList();
      html += '<table class="intel-table"><thead><tr><th>Term</th><th>Definition</th><th>Section</th></tr></thead><tbody>';
      for (const g of filtered.slice(0, 200)) {
        html += `<tr><td><strong>${g.term}</strong></td><td>${g.definition.substring(0,200)}</td><td>${g.sectionNumber}</td></tr>`;
      }
      html += '</tbody></table>';
      el.innerHTML = html;
    }
    let glossaryVirtualList = null;
    function destroyGlossaryVirtualList() {
      if (glossaryVirtualList) { glossaryVirtualList.destroy(); glossaryVirtualList = null; }
    }
    function glossaryTbodyHost(el, countPrefix) {
      el.innerHTML = (countPrefix || '') + '<table class="intel-table"><thead><tr><th>Term</th><th>Definition</th><th>Section</th></tr></thead><tbody></tbody></table>';
      return el.querySelector('tbody');
    }
    document.getElementById('glossary-search').addEventListener('input', (e) => renderGlossary(e.target.value));

    // ─ Cross-Refs ─
    async function loadXRefs() {
      const el = document.getElementById('xrefs-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Validating cross-references (may take a moment)...</p>';
      try {
        const data = await apiFetch('/api/cross-refs/validate').then(r => r.json());
        const pct = (data.resolutionRate * 100).toFixed(1);
        const badge = data.resolutionRate > 0.9 ? 'badge-green' : data.resolutionRate > 0.7 ? 'badge-yellow' : 'badge-red';
        let html = `<div class="intel-grid" style="margin-bottom:16px">
          <div class="intel-card"><h4>Resolution Rate</h4><div class="metric"><span class="intel-badge ${badge}">${pct}%</span></div></div>
          <div class="intel-card"><h4>Total References</h4><div class="metric">${data.totalReferences}</div></div>
          <div class="intel-card"><h4>Resolved</h4><div class="metric" style="color:#22c55e">${data.resolvedCount}</div></div>
          <div class="intel-card"><h4>Unresolved</h4><div class="metric" style="color:#ef4444">${data.unresolvedCount}</div></div>
        </div>`;
        if (data.mostUnresolved?.length > 0) {
          html += '<h4 style="margin:16px 0 8px">Sections with Most Unresolved References</h4><table class="intel-table"><thead><tr><th>Section</th><th>Unresolved Count</th></tr></thead><tbody>';
          for (const m of data.mostUnresolved) { html += `<tr><td>§ ${m.sectionNumber}</td><td>${m.count}</td></tr>`; }
          html += '</tbody></table>';
        }
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to validate cross-references</p>'; }
    }

    // ─ Legislative History ─
    document.getElementById('history-load-btn').addEventListener('click', async () => {
      const guid = document.getElementById('history-guid-input').value.trim();
      if (!guid) return;
      const el = document.getElementById('history-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Loading...</p>';
      try {
        const data = await apiFetch(`/api/history/${guid}`).then(r => r.json());
        if (data.error) { el.innerHTML = `<p style="color:#f97316">${data.error}</p>`; return; }
        let html = `<h4>§ ${data.number}</h4><p style="color:var(--text-secondary);margin-bottom:12px">${data.rawHistory}</p>`;
        if (data.entries?.length > 0) {
          html += '<table class="intel-table"><thead><tr><th>Ordinance</th><th>Action</th><th>Year</th></tr></thead><tbody>';
          for (const e of data.entries) { html += `<tr><td>${e.ordinance}</td><td>${e.action}</td><td>${e.date ?? '—'}</td></tr>`; }
          html += '</tbody></table>';
        }
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load history</p>'; }
    });

    // ─ Compare Sections ─
    document.getElementById('compare-btn').addEventListener('click', async () => {
      const g1 = document.getElementById('compare-guid1').value.trim();
      const g2 = document.getElementById('compare-guid2').value.trim();
      if (!g1 || !g2) return;
      const el = document.getElementById('compare-result');
      el.innerHTML = '<p style="color:var(--text-secondary)">Comparing...</p>';
      try {
        const data = await apiFetch(`/api/compare?guid1=${g1}&guid2=${g2}`).then(r => r.json());
        if (data.error) { el.innerHTML = `<p style="color:#f97316">${data.error}</p>`; return; }
        const pct = (data.similarity * 100).toFixed(1);
        let html = `<div class="intel-grid" style="margin-bottom:12px">
          <div class="intel-card"><h4>Similarity</h4><div class="metric">${pct}%</div></div>
          <div class="intel-card"><h4>Word Delta</h4><div class="metric">${data.wordCountDelta > 0 ? '+' : ''}${data.wordCountDelta}</div></div>
          <div class="intel-card"><h4>Common Lines</h4><div class="metric">${data.common.length}</div></div>
        </div>`;
        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div><h5>Only in § ${data.number1}</h5><div class="compare-text">${data.onlyInFirst.slice(0,20).join('<br>')}</div></div><div><h5>Only in § ${data.number2}</h5><div class="compare-text">${data.onlyInSecond.slice(0,20).join('<br>')}</div></div></div>`;
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to compare</p>'; }
    });

    // ─ Monthly Report ─
    async function loadReport() {
      const el = document.getElementById('report-content');
      try {
        const resp = await apiFetch('/api/report/latest');
        if (resp.status === 404) { el.innerHTML = '<p style="color:var(--text-secondary)">No reports generated. Run: bun run report</p>'; return; }
        const md = await resp.text();
        el.innerHTML = marked.parse(md);
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load report</p>'; }
    }

    // ─ Curated Feed ─
    // Attribute-safe escaping (also quotes) — distinct from the existing
    // escapeHtml() above, which does not escape quotes and is therefore
    // unsafe to use inside an href="..." attribute. Curated titles/links
    // originate from external scraped sources (news RSS, Triplicate,
    // YouTube), so this must not be skipped.
    function escapeHtmlAttr(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const SOURCE_LABELS = { news: '📰 News', gov_meetings: '🏛️ Gov Meeting', youtube: '📺 YouTube' };
    async function loadCuratedFeed() {
      const el = document.getElementById('curated-content');
      try {
        const resp = await apiFetch('/api/curated?limit=50');
        const data = await resp.json();
        if (!data.items || data.items.length === 0) {
          el.innerHTML = '<p style="color:var(--text-secondary)">' + escapeHtmlAttr(data.error || 'No curated items yet. Run: bun run curate') + '</p>';
          return;
        }
        let html = '';
        for (const item of data.items) {
          const sourceLabel = SOURCE_LABELS[item.source] || escapeHtmlAttr(item.source);
          const tags = (item.tags || []).map(t => '<span class="intel-tab" style="padding:2px 8px;font-size:11px;cursor:default">' + escapeHtmlAttr(t) + '</span>').join(' ');
          html += '<div style="border-bottom:1px solid var(--border);padding:12px 0">'
            + '<div style="font-size:12px;color:var(--text-secondary)">' + sourceLabel + ' · ' + escapeHtmlAttr(new Date(item.curatedAt).toLocaleString()) + ' · ' + escapeHtmlAttr(item.provider || 'source-only') + ' · ' + escapeHtmlAttr(item.summaryStatus || 'legacy') + '</div>'
            + '<div style="font-weight:600;margin:4px 0">' + (item.link ? '<a href="' + escapeHtmlAttr(item.link) + '" target="_blank" rel="noopener">' + escapeHtmlAttr(item.title) + '</a>' : escapeHtmlAttr(item.title)) + '</div>'
            + '<div style="color:var(--text-secondary);margin-bottom:6px">' + escapeHtmlAttr(item.summary) + '</div>'
            + (tags ? '<div>' + tags + '</div>' : '')
            + '</div>';
        }
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load curated feed</p>'; }
    }

    // ─ API Explorer ─
    const apiEndpoints = [
      {method:'GET', path:'/api/health', desc:'Health + staleness + alert level'},
      {method:'GET', path:'/api/metadata', desc:'Build, provider, artifact, and source lineage'},
      {method:'GET', path:'/api/toc', desc:'Table of contents tree'},
      {method:'GET', path:'/api/stats', desc:'Code statistics'},
      {method:'GET', path:'/api/stats/count', desc:'Lightweight section count'},
      {method:'GET', path:'/api/search?q=zoning', desc:'BM25 search with fuzzy fallback'},
      {method:'GET', path:'/api/sections', desc:'Hierarchical section listing'},
      {method:'GET', path:'/api/domains', desc:'12 intelligence domains'},
      {method:'GET', path:'/api/domains/coverage', desc:'Domain coverage metrics'},
      {method:'GET', path:'/api/readability', desc:'Flesch-Kincaid + Gunning Fog scores'},
      {method:'GET', path:'/api/monitor/status', desc:'Code change detection status'},
      {method:'GET', path:'/api/monitor/alerts', desc:'8-monitor alert aggregation + composite'},
      {method:'GET', path:'/api/alerts/timeline', desc:'Unified alert event timeline'},
      {method:'GET', path:'/api/alerts/recent?limit=10', desc:'Recent alert events'},
      {method:'GET', path:'/api/alerts/airquality', desc:'Current EPA AQI'},
      {method:'GET', path:'/api/alerts/wildfire', desc:'Current CAL FIRE incidents'},
      {method:'GET', path:'/api/alerts/marine', desc:'Current NDBC buoy data'},
      {method:'GET', path:'/api/alerts/composite', desc:'8-monitor composite severity'},
      {method:'GET', path:'/api/glossary', desc:'Definition glossary from code corpus'},
      {method:'GET', path:'/api/cross-refs/validate', desc:'Cross-reference validation'},
      {method:'GET', path:'/api/search/analytics', desc:'Search term analytics'},
      {method:'GET', path:'/api/report/latest', desc:'Monthly civic health report (Markdown)'},
      {method:'GET', path:'/api/report/latest.json', desc:'Machine-readable report metadata'},
      {method:'GET', path:'/api/curation/status', desc:'LLM curation provider and retry metadata'},
      {method:'POST', path:'/api/chat/stream', desc:'Streaming RAG chat (SSE)'},
      {method:'GET', path:'/api/fuzzy?q=harbr', desc:'Fuzzy search suggestions'},
      {method:'GET', path:'/api/openapi.yaml', desc:'OpenAPI 3.0.3 spec'},
    ];
    function loadApiExplorer() {
      const list = document.getElementById('api-explorer-list');
      let html = '';
      for (const ep of apiEndpoints) {
        const methodClass = ep.method === 'GET' ? 'method-get' : 'method-post';
        html += `<div class="api-explorer-item"><span class="api-explorer-method ${methodClass}">${ep.method}</span><span class="api-explorer-path">${ep.path}</span><span style="color:var(--text-secondary);font-size:12px">${ep.desc}</span><button class="api-explorer-btn" data-path="${ep.path}" data-method="${ep.method}">Try</button></div>`;
      }
      list.innerHTML = html;
      list.querySelectorAll('.api-explorer-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const path = btn.dataset.path;
          const method = btn.dataset.method;
          const resultEl = document.getElementById('api-explorer-result');
          resultEl.style.display = 'block';
          resultEl.textContent = `Loading ${method} ${path}...`;
          try {
            const opts = method === 'POST' ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({q:'tsunami'})} : {};
            const resp = await apiFetch(path, opts);
            const text = await resp.text();
            resultEl.textContent = `${resp.status} ${resp.statusText}\n\n${text.substring(0, 2000)}`;
          } catch (err) {
            resultEl.textContent = `Error: ${err.message}`;
          }
        });
      });
    }

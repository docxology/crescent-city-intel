// 80-sources.js — source coverage and structured output.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // ─── Source coverage and structured output ───────────────────────
    function sourceStatusLabel(value) {
      const status = String(value || 'not-checked');
      const colors = { ok: '#22c55e', empty: '#60a5fa', unavailable: '#ef4444', stale: '#ef4444', 'not-checked': '#eab308' };
      return `<span style="font-weight:700;color:${colors[status] || '#a1a1aa'}">${escapeHtml(status.toUpperCase())}</span>`;
    }

    function downloadStructuredJson(filename, value) {
      const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function filteredSourceCoverageRecords() {
      const needle = document.getElementById('source-filter').value.trim().toLowerCase();
      const automation = document.getElementById('source-automation-filter').value;
      const status = document.getElementById('source-status-filter').value;
      return sourceCoverageRecords.filter(record => {
        const matchesText = !needle || JSON.stringify(record).toLowerCase().includes(needle);
        const matchesAutomation = automation === 'all' || record.automation === automation;
        const matchesStatus = status === 'all' || (record.operationalStatus || 'not-checked') === status;
        return matchesText && matchesAutomation && matchesStatus;
      });
    }

    function renderSourceCoverage() {
      const discovery = sourceCoverageData?.discovery || {};
      const records = filteredSourceCoverageRecords();
      const summary = document.getElementById('source-summary-grid');
      summary.innerHTML = `<div class="intel-card"><h4>Total sources</h4><div class="metric">${discovery.sourceCount ?? sourceCoverageRecords.length}</div><div class="label">fingerprint ${escapeHtml(String(discovery.registryFingerprint || sourceCoverageData?.registryFingerprint || '').slice(0, 16))}</div></div><div class="intel-card"><h4>Monitored</h4><div class="metric">${discovery.monitoredCount ?? 0}</div><div class="label">actively joined to health</div></div><div class="intel-card"><h4>Discovery only</h4><div class="metric">${discovery.discoveryOnlyCount ?? 0}</div><div class="label">known, not continuously monitored</div></div><div class="intel-card"><h4>Reference only</h4><div class="metric">${discovery.referenceOnlyCount ?? 0}</div><div class="label">citation boundary</div></div>`;
      const table = document.getElementById('source-table');
      table.innerHTML = records.length ? `<table class="intel-table"><thead><tr><th>Source</th><th>Automation</th><th>Status</th><th>Authority / region</th><th>Action</th></tr></thead><tbody>${records.map(record => `<tr><td><strong>${escapeHtml(record.name)}</strong><br><span style="font-size:11px;color:var(--text-secondary)">${escapeHtml(record.id)} · ${escapeHtml(record.kind)}</span></td><td>${escapeHtml(record.automation)}</td><td>${sourceStatusLabel(record.operationalStatus)}<br><span style="font-size:11px;color:var(--text-secondary)">${record.itemCount ?? 0} item(s)${record.error ? ` · ${escapeHtml(record.error)}` : ''}</span></td><td>${escapeHtml(record.authority)} · ${escapeHtml(record.region)}</td><td><button class="btn source-inspect" type="button" data-source-id="${escapeHtmlAttr(record.id)}">Inspect</button> <a href="${escapeHtmlAttr(record.canonicalUrl)}" target="_blank" rel="noopener">open</a></td></tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No sources match the selected filters.</p>';
      const selected = sourceCoverageRecords.find(record => record.id === sourceSelectedId);
      document.getElementById('source-detail').innerHTML = selected ? `<div class="intel-card"><h4>${escapeHtml(selected.name)}</h4><div style="color:var(--text-secondary);font-size:12px">${sourceStatusLabel(selected.operationalStatus)} · ${escapeHtml(selected.provenance || 'provenance not recorded')}</div><p style="margin:8px 0"><a href="${escapeHtmlAttr(selected.canonicalUrl)}" target="_blank" rel="noopener">${escapeHtml(selected.canonicalUrl)}</a></p><pre style="white-space:pre-wrap;max-height:360px;overflow:auto">${escapeHtml(JSON.stringify(selected, null, 2))}</pre></div>` : '<p style="color:var(--text-secondary)">Select a source row to inspect its full structured record.</p>';
      const gaps = Array.isArray(discovery.coverageGaps) ? discovery.coverageGaps : [];
      document.getElementById('source-gaps').innerHTML = gaps.length ? `<div class="intel-card"><h4>Known coverage gaps</h4><ul>${gaps.map(gap => `<li>${escapeHtml(gap)}</li>`).join('')}</ul></div>` : '';
    }

    async function loadSourceCoverage() {
      const table = document.getElementById('source-table');
      table.innerHTML = '<p style="color:var(--text-secondary)">Loading source coverage…</p>';
      try {
        const response = await apiFetch('/api/sources');
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        sourceCoverageData = await response.json();
        sourceCoverageRecords = sourceCoverageData.discovery?.sources || (sourceCoverageData.registry || []).map(source => ({ ...source, operationalStatus: 'not-checked', itemCount: 0 }));
        renderSourceCoverage();
      } catch (error) {
        table.innerHTML = `<p style="color:#f97316">Source coverage unavailable: ${escapeHtml(error.message || error)}</p>`;
      }
    }

    async function loadSourceJson() {
      if (!sourceCoverageData) await loadSourceCoverage();
      const output = document.getElementById('source-json-output');
      output.textContent = sourceCoverageData ? JSON.stringify(sourceCoverageData, null, 2) : 'Source coverage unavailable.';
    }

    // ─── Corpus intelligence panels ──────────────────────────────────
    //
    // Section graph, word frequency, and section longevity each mirror one
    // pure server module (src/section_graph.ts, src/word_frequency.ts,
    // src/section_longevity.ts). Every number rendered here comes from that
    // module's report — nothing is recomputed in the browser, so the panel
    // and the API can never disagree.

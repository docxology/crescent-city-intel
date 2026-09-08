// 130-readability.js — readability panel.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // ─ Readability Panel ─
    async function loadReadabilityPanel() {
      const el = document.getElementById('readability-content');
      try {
        const resp = await apiFetch('/api/readability');
        if (!resp.ok) { el.innerHTML = '<p style="color:var(--text-secondary)">No readability data. Run: bun run readability</p>'; return; }
        const data = await resp.json();
        let html = '';
        // Actual /api/readability shape: { totalSections, scored, averageGradeLevel, hardestSections, easiestSections, allScores? }
        if (typeof data.averageGradeLevel === 'number') {
          html += `<div class="intel-grid"><div class="intel-card"><h4>Avg Grade Level</h4><div class="metric">${data.averageGradeLevel.toFixed(1)}</div></div><div class="intel-card"><h4>Scored Sections</h4><div class="metric">${data.scored ?? '—'}</div></div><div class="intel-card"><h4>Total Sections</h4><div class="metric">${data.totalSections ?? '—'}</div></div></div>`;
          // Difficulty distribution — only computable when the full score list is present
          if (Array.isArray(data.allScores) && data.allScores.length > 0) {
            const distribution = {};
            for (const row of data.allScores) {
              const d = row.score?.difficulty ?? 'unknown';
              distribution[d] = (distribution[d] ?? 0) + 1;
            }
            html += '<table class="intel-table" style="margin-top:16px"><thead><tr><th>Difficulty</th><th>Count</th></tr></thead><tbody>';
            for (const [k, v] of Object.entries(distribution)) { html += `<tr><td>${k}</td><td>${v}</td></tr>`; }
            html += '</tbody></table>';
          }
          if (Array.isArray(data.hardestSections) && data.hardestSections.length > 0) {
            html += '<h4 style="margin:16px 0 8px">Hardest Sections</h4><table class="intel-table"><thead><tr><th>Section</th><th>Title</th><th>Grade Level</th><th>Difficulty</th></tr></thead><tbody>';
            for (const row of data.hardestSections) {
              html += `<tr><td>${escapeHtml(row.number)}</td><td>${escapeHtml(row.title)}</td><td>${row.score?.gradeLevel ?? '—'}</td><td>${row.score?.difficulty ?? '—'}</td></tr>`;
            }
            html += '</tbody></table>';
          }
        }
        el.innerHTML = html || '<p style="color:var(--text-secondary)">No readability data</p>';
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load readability</p>'; }
    }

    // ─ Readability history trend (additive; wave-2 endpoint) ────────
    // GET /api/readability/history?limit=60 → { total, count, offset, limit,
    // entries: [...], trend: { buckets: [{ windowStart, windowEnd, avgEase,
    // runs }], latest, delta } }. The route goes live in wave 2; until then
    // the fetch fails and the graceful empty state below stays visible.
    // Every field is read defensively — a missing or malformed field renders
    // the empty state, never a throw.
    const READABILITY_HISTORY_EMPTY_HTML = '<p style="color:var(--text-secondary)">No readability history recorded yet \u2014 run <code>bun run readability</code></p>';

    function readabilityHistoryEmpty(el) {
      el.innerHTML = READABILITY_HISTORY_EMPTY_HTML;
    }

    function readabilityHistoryRow(entry) {
      if (!entry || typeof entry !== 'object') return '';
      const when = escapeHtml(String(entry.date ?? entry.timestamp ?? entry.runAt ?? entry.generatedAt ?? 'unknown run'));
      const ease = typeof entry.ease === 'number' ? entry.ease : (typeof entry.fleschReadingEase === 'number' ? entry.fleschReadingEase : null);
      const fog = typeof entry.fog === 'number' ? entry.fog : (typeof entry.gunningFog === 'number' ? entry.gunningFog : null);
      const deltaEase = typeof entry.easeDelta === 'number' ? entry.easeDelta : null;
      const deltaFog = typeof entry.fogDelta === 'number' ? entry.fogDelta : null;
      const fmt = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '\u2014');
      const deltaPart = (d, label) => (typeof d === 'number' && isFinite(d)
        ? `<span style="color:${d >= 0 ? '#22c55e' : '#ef4444'}">${d >= 0 ? '+' : ''}${d.toFixed(1)} ${label}</span>`
        : '');
      return `<tr><td>${when}</td><td>ease ${fmt(ease)} ${deltaPart(deltaEase, 'ease')}</td><td>fog ${fmt(fog)} ${deltaPart(deltaFog, 'fog')}</td></tr>`;
    }

    function readabilityHistoryTrendSvg(trend) {
      const buckets = Array.isArray(trend?.buckets) ? trend.buckets.filter(b => b && typeof b.avgEase === 'number') : [];
      if (buckets.length < 2) return '';
      const W = 560, H = 90, pad = 8;
      const values = buckets.map(b => b.avgEase);
      const min = Math.min(...values), max = Math.max(...values);
      const span = (max - min) || 1;
      const points = values.map((v, i) => {
        const x = pad + (i / (values.length - 1)) * (W - 2 * pad);
        const y = H - pad - ((v - min) / span) * (H - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;margin-top:8px" role="img" aria-label="30-day average ease trend"><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>`;
    }

    async function loadReadabilityHistory() {
      const el = document.getElementById('readability-history-content');
      if (!el) return;
      try {
        const resp = await apiFetch('/api/readability/history?limit=60');
        if (!resp.ok) { readabilityHistoryEmpty(el); return; }
        const data = await resp.json();
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        if (entries.length === 0) { readabilityHistoryEmpty(el); return; }
        let html = '<p style="color:var(--text-secondary);margin-bottom:8px">'
          + `${entries.length} run${entries.length === 1 ? '' : 's'} recorded`;
        if (typeof data?.trend?.latest === 'number' && isFinite(data.trend.latest)) {
          html += ` \u00b7 latest ease ${data.trend.latest.toFixed(1)}`;
        }
        if (typeof data?.trend?.delta === 'number' && isFinite(data.trend.delta)) {
          html += ` \u00b7 30-day delta <span style="color:${data.trend.delta >= 0 ? '#22c55e' : '#ef4444'}">${data.trend.delta >= 0 ? '+' : ''}${data.trend.delta.toFixed(1)}</span>`;
        }
        html += '</p>';
        html += '<table class="intel-table"><thead><tr><th>Run</th><th>Flesch ease</th><th>Gunning fog</th></tr></thead><tbody>';
        for (const entry of entries) html += readabilityHistoryRow(entry);
        html += '</tbody></table>';
        html += readabilityHistoryTrendSvg(data?.trend);
        el.innerHTML = html;
      } catch { readabilityHistoryEmpty(el); }
    }

    // Wrap the panel loader so the history trend loads alongside the panel;
    // the verbatim function above is only relocated, never rewritten.
    const _baseLoadReadabilityPanel = loadReadabilityPanel;
    loadReadabilityPanel = async function () {
      await _baseLoadReadabilityPanel();
      try { await loadReadabilityHistory(); } catch { /* non-fatal */ }
    };

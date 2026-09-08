// 90-intel-panels.js — corpus panels: graph, lexicon, longevity, chronology, civic insights.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    /** Percent with one decimal; renders a dash rather than "NaN%" for null. */
    function pct1(value) {
      return typeof value === 'number' && isFinite(value) ? (value * 100).toFixed(1) + '%' : '—';
    }

    /** A number, or an em dash when the value is genuinely unknown. */
    function orDash(value) {
      return value === null || value === undefined ? '—' : value;
    }

    function degreeTable(rows, degreeLabel) {
      if (!rows || rows.length === 0) return '<p style="color:var(--text-secondary)">None.</p>';
      let html = '<table class="intel-table"><thead><tr><th>Section</th><th>Title</th><th>' + escapeHtml(degreeLabel) + '</th></tr></thead><tbody>';
      for (const row of rows) {
        html += '<tr><td>&sect;&nbsp;' + escapeHtml(row.number) + '</td><td>' + escapeHtml(row.title) + '</td><td>' + row.degree + '</td></tr>';
      }
      return html + '</tbody></table>';
    }

    /**
     * Radial ego-network drawing. Deterministic layout (no physics, no
     * library): the focus sits at the centre and its neighbourhood is placed
     * on a circle in report order, so the same report always draws the same
     * picture. Only drawn for an ego network — a whole-corpus graph has far
     * too many nodes for a radial plot to say anything true.
     */
    function egoNetworkSvg(report) {
      const nodes = report.nodes.slice(0, 40);
      if (!report.focus || nodes.length === 0) return '';
      const size = 520, cx = size / 2, cy = size / 2, radius = size / 2 - 70;
      const focusGuid = report.focus.guid;
      const others = nodes.filter(n => n.guid !== focusGuid);
      const pos = { [focusGuid]: { x: cx, y: cy } };
      others.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / Math.max(1, others.length) - Math.PI / 2;
        pos[node.guid] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      });
      let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="100%" style="max-width:' + size + 'px;display:block;margin:0 auto" role="img" aria-label="Ego network around section ' + escapeHtmlAttr(report.focus.number) + '">';
      svg += '<defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.55"/></marker></defs>';
      for (const edge of report.edges) {
        const from = pos[edge.fromGuid], to = pos[edge.toGuid];
        if (!from || !to) continue;
        svg += '<line x1="' + from.x.toFixed(1) + '" y1="' + from.y.toFixed(1) + '" x2="' + to.x.toFixed(1) + '" y2="' + to.y.toFixed(1) + '" stroke="currentColor" stroke-opacity="0.32" stroke-width="' + Math.min(4, edge.weight) + '" marker-end="url(#graph-arrow)"/>';
      }
      for (const node of nodes) {
        const point = pos[node.guid];
        if (!point) continue;
        const isFocus = node.guid === focusGuid;
        svg += '<circle cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="' + (isFocus ? 11 : 7) + '" fill="' + (isFocus ? 'var(--accent)' : 'currentColor') + '" fill-opacity="' + (isFocus ? '1' : '0.55') + '"><title>' + escapeHtmlAttr('§ ' + node.number + ' — ' + node.title + ' (in ' + node.inDegree + ' / out ' + node.outDegree + ')') + '</title></circle>';
        svg += '<text x="' + point.x.toFixed(1) + '" y="' + (point.y - (isFocus ? 16 : 12)).toFixed(1) + '" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.75">' + escapeHtml(node.number) + '</text>';
      }
      return svg + '</svg>';
    }

    async function loadSectionGraphPanel() {
      const el = document.getElementById('graph-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Building the citation graph…</p>';
      const guid = document.getElementById('graph-guid-input').value.trim();
      const depth = document.getElementById('graph-depth').value;
      const title = document.getElementById('graph-title-input').value.trim();
      const params = new URLSearchParams({ limit: '40' });
      if (guid) { params.set('guid', guid); params.set('depth', depth); }
      if (title) params.set('title', title);
      try {
        const resp = await apiFetch('/api/sections/graph?' + params.toString());
        const data = await resp.json();
        if (!resp.ok) { el.innerHTML = '<p style="color:#f97316">' + escapeHtml(data.error || 'Graph unavailable') + '</p>'; return; }
        const summary = data.summary;
        let html = '<div class="intel-grid" style="margin-bottom:16px">'
          + '<div class="intel-card"><h4>Sections</h4><div class="metric">' + summary.nodes + '</div></div>'
          + '<div class="intel-card"><h4>Citation edges</h4><div class="metric">' + summary.edges + '</div></div>'
          + '<div class="intel-card"><h4>Resolution rate</h4><div class="metric">' + pct1(summary.resolutionRate) + '</div></div>'
          + '<div class="intel-card"><h4>Density</h4><div class="metric">' + summary.density.toFixed(5) + '</div></div>'
          + '<div class="intel-card"><h4>Components</h4><div class="metric">' + summary.components + '</div><span style="font-size:11px;color:var(--text-secondary)">largest ' + summary.largestComponentSize + '</span></div>'
          + '<div class="intel-card"><h4>Isolated</h4><div class="metric">' + summary.isolatedNodes + '</div></div>'
          + '<div class="intel-card"><h4>Mutual pairs</h4><div class="metric">' + summary.reciprocalPairs + '</div></div>'
          + '<div class="intel-card"><h4>Dangling citations</h4><div class="metric" style="color:#ef4444">' + summary.unresolvedCitations + '</div><span style="font-size:11px;color:var(--text-secondary)">' + summary.distinctUnresolvedTargets + ' distinct target(s)</span></div>'
          + '<div class="intel-card"><h4>Self-references</h4><div class="metric">' + summary.selfReferences + '</div><span style="font-size:11px;color:var(--text-secondary)">counted, never edged</span></div>'
          + '</div>';
        if (data.focus) {
          html += '<h4 style="margin:16px 0 8px">Ego network of &sect;&nbsp;' + escapeHtml(data.focus.number) + ' — ' + data.focus.depth + ' hop(s), ' + data.focus.neighborhoodSize + ' section(s)</h4>'
            + egoNetworkSvg(data);
        } else {
          html += '<p style="color:var(--text-secondary);font-size:12px">Enter a section GUID above to draw an ego network. A whole-corpus plot is omitted deliberately: at this node count a radial drawing would show shape without meaning.</p>';
        }
        html += '<h4 style="margin:20px 0 8px">Authorities — most cited by other sections</h4>' + degreeTable(data.authorities.slice(0, 15), 'Cited by');
        html += '<h4 style="margin:20px 0 8px">Hubs — cite the most other sections</h4>' + degreeTable(data.hubs.slice(0, 15), 'Cites');
        if (data.unresolved.length > 0) {
          html += '<h4 style="margin:20px 0 8px">Dangling citations</h4><table class="intel-table"><thead><tr><th>In section</th><th>Citation</th><th>Names</th><th>Times</th></tr></thead><tbody>';
          for (const u of data.unresolved.slice(0, 15)) {
            html += '<tr><td>&sect;&nbsp;' + escapeHtml(u.fromNumber) + '</td><td>' + escapeHtml(u.citation) + '</td><td>' + escapeHtml(u.target) + '</td><td>' + u.count + '</td></tr>';
          }
          html += '</tbody></table>';
        }
        if (data.truncated) html += '<p style="color:var(--text-secondary);font-size:12px;margin-top:12px">Lists bounded at 40 entries; the summary above reports the true totals.</p>';
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to build the section graph</p>'; }
    }
    document.getElementById('graph-load-btn').addEventListener('click', loadSectionGraphPanel);

    async function loadLexiconPanel() {
      const el = document.getElementById('lexicon-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Counting terms…</p>';
      const title = document.getElementById('lexicon-title-input').value.trim();
      const minLength = document.getElementById('lexicon-minlen').value;
      const params = new URLSearchParams({ limit: '30', minLength });
      if (title) params.set('title', title);
      try {
        const resp = await apiFetch('/api/lexicon/frequency?' + params.toString());
        const data = await resp.json();
        if (!resp.ok) { el.innerHTML = '<p style="color:#f97316">' + escapeHtml(data.error || 'Word frequency unavailable') + '</p>'; return; }
        const summary = data.summary;
        let html = '<div class="intel-grid" style="margin-bottom:16px">'
          + '<div class="intel-card"><h4>Sections scanned</h4><div class="metric">' + summary.sectionsScanned + '</div></div>'
          + '<div class="intel-card"><h4>Indexed tokens</h4><div class="metric">' + summary.totalTokens.toLocaleString() + '</div></div>'
          + '<div class="intel-card"><h4>Distinct terms</h4><div class="metric">' + summary.distinctTerms.toLocaleString() + '</div></div>'
          + '<div class="intel-card"><h4>Used once only</h4><div class="metric">' + summary.hapaxCount.toLocaleString() + '</div></div>'
          + '<div class="intel-card"><h4>Type/token ratio</h4><div class="metric">' + summary.typeTokenRatio.toFixed(4) + '</div></div>'
          + '<div class="intel-card"><h4>Tokens per section</h4><div class="metric">' + summary.meanTokensPerSection + '</div></div>'
          + '</div>';
        const maxCount = data.topByFrequency[0] ? data.topByFrequency[0].count : 1;
        html += '<h4 style="margin:16px 0 8px">Most frequent terms</h4><table class="intel-table"><thead><tr><th>Term</th><th>Count</th><th>In sections</th><th></th></tr></thead><tbody>';
        for (const term of data.topByFrequency) {
          const width = Math.max(2, Math.round((term.count / maxCount) * 100));
          html += '<tr><td>' + escapeHtml(term.surface) + '</td><td>' + term.count + '</td><td>' + term.documentFrequency + ' (' + pct1(term.documentFrequencyRatio) + ')</td>'
            + '<td style="width:40%"><div style="height:8px;border-radius:4px;background:var(--accent);opacity:.6;width:' + width + '%"></div></td></tr>';
        }
        html += '</tbody></table>';
        html += '<h4 style="margin:20px 0 8px">Most distinctive terms (tf&middot;idf)</h4><table class="intel-table"><thead><tr><th>Term</th><th>Salience</th><th>Count</th><th>In sections</th></tr></thead><tbody>';
        for (const term of data.topBySalience) {
          html += '<tr><td>' + escapeHtml(term.surface) + '</td><td>' + term.salience.toFixed(1) + '</td><td>' + term.count + '</td><td>' + term.documentFrequency + '</td></tr>';
        }
        html += '</tbody></table>';
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to build the word-frequency profile</p>'; }
    }
    document.getElementById('lexicon-load-btn').addEventListener('click', loadLexiconPanel);

    /** Decade histogram as inline bars; the API guarantees contiguous decades. */
    function decadeHistogram(buckets) {
      if (!buckets || buckets.length === 0) return '<p style="color:var(--text-secondary)">No dated sections.</p>';
      const peak = Math.max(1, ...buckets.map(b => Math.max(b.enacted, b.lastTouched)));
      let html = '<div style="display:flex;gap:6px;align-items:flex-end;height:150px;overflow-x:auto;padding-bottom:4px">';
      for (const bucket of buckets) {
        const enacted = Math.round((bucket.enacted / peak) * 110);
        const touched = Math.round((bucket.lastTouched / peak) * 110);
        html += '<div style="display:flex;flex-direction:column;align-items:center;min-width:44px">'
          + '<div style="display:flex;gap:2px;align-items:flex-end;height:115px">'
          + '<div title="' + bucket.enacted + ' enacted in the ' + bucket.decade + 's" style="width:12px;height:' + enacted + 'px;background:var(--accent);opacity:.75;border-radius:2px 2px 0 0"></div>'
          + '<div title="' + bucket.lastTouched + ' last touched in the ' + bucket.decade + 's" style="width:12px;height:' + touched + 'px;background:currentColor;opacity:.35;border-radius:2px 2px 0 0"></div>'
          + '</div><span style="font-size:10px;color:var(--text-secondary);margin-top:4px">' + bucket.decade + '</span></div>';
      }
      html += '</div><p style="font-size:11px;color:var(--text-secondary);margin-top:6px"><span style="color:var(--accent)">&#9632;</span> enacted &nbsp; <span style="opacity:.5">&#9632;</span> last touched</p>';
      return html;
    }

    function longevityTable(rows, columns) {
      if (!rows || rows.length === 0) return '<p style="color:var(--text-secondary)">None.</p>';
      let html = '<table class="intel-table"><thead><tr><th>Section</th><th>Title</th>' + columns.map(c => '<th>' + escapeHtml(c.label) + '</th>').join('') + '</tr></thead><tbody>';
      for (const row of rows) {
        html += '<tr><td>&sect;&nbsp;' + escapeHtml(row.number) + '</td><td>' + escapeHtml(row.title) + '</td>'
          + columns.map(c => '<td>' + orDash(row[c.key]) + '</td>').join('') + '</tr>';
      }
      return html + '</tbody></table>';
    }

    async function loadLongevityPanel() {
      const el = document.getElementById('longevity-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Reading legislative history…</p>';
      const title = document.getElementById('longevity-title-input').value.trim();
      const params = new URLSearchParams({ limit: '10' });
      if (title) params.set('title', title);
      try {
        const resp = await apiFetch('/api/sections/longevity?' + params.toString());
        const data = await resp.json();
        if (!resp.ok) { el.innerHTML = '<p style="color:#f97316">' + escapeHtml(data.error || 'Longevity unavailable') + '</p>'; return; }
        const summary = data.summary;
        let html = '<div class="intel-grid" style="margin-bottom:16px">'
          + '<div class="intel-card"><h4>Dated sections</h4><div class="metric">' + summary.withHistory + '</div><span style="font-size:11px;color:var(--text-secondary)">' + summary.withoutHistory + ' undatable, excluded</span></div>'
          + '<div class="intel-card"><h4>Median age</h4><div class="metric">' + orDash(summary.medianAgeYears) + '</div><span style="font-size:11px;color:var(--text-secondary)">years, as of ' + data.asOfYear + '</span></div>'
          + '<div class="intel-card"><h4>Median years since amendment</h4><div class="metric">' + orDash(summary.medianYearsSinceLastAmendment) + '</div></div>'
          + '<div class="intel-card"><h4>Never amended</h4><div class="metric">' + summary.neverAmended + '</div></div>'
          + '<div class="intel-card"><h4>Dormant 20+ years</h4><div class="metric">' + summary.dormantOver20Years + '</div></div>'
          + '<div class="intel-card"><h4>Year range</h4><div class="metric" style="font-size:20px">' + orDash(summary.oldestYear) + '–' + orDash(summary.newestYear) + '</div></div>'
          + '</div>';
        html += '<h4 style="margin:16px 0 8px">Activity by decade</h4>' + decadeHistogram(data.byDecade);
        html += '<h4 style="margin:20px 0 8px">Oldest enactments</h4>' + longevityTable(data.oldest, [{ key: 'enactedYear', label: 'Enacted' }, { key: 'ageYears', label: 'Age (yrs)' }]);
        html += '<h4 style="margin:20px 0 8px">Longest untouched</h4>' + longevityTable(data.stalest, [{ key: 'lastAmendedYear', label: 'Last touched' }, { key: 'yearsSinceLastAmendment', label: 'Years since' }]);
        html += '<h4 style="margin:20px 0 8px">Most amended</h4>' + longevityTable(data.mostAmended, [{ key: 'amendmentCount', label: 'Actions' }, { key: 'churnPerDecade', label: 'Per decade' }]);
        html += '<h4 style="margin:20px 0 8px">Most recently amended</h4>' + longevityTable(data.recentlyAmended, [{ key: 'lastAmendedYear', label: 'Last touched' }, { key: 'amendmentCount', label: 'Actions' }]);
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to build the longevity profile</p>'; }
    }
    document.getElementById('longevity-load-btn').addEventListener('click', loadLongevityPanel);

    /**
     * Ordinance timeline. Bars are per-decade ordinance counts; undated
     * ordinances are excluded from the bars and reported separately, because
     * putting an undated ordinance somewhere on a timeline is a guess the
     * data does not support.
     */
    function ordinanceTimeline(entries) {
      const dated = entries.filter(o => typeof o.year === 'number');
      const undated = entries.length - dated.length;
      if (dated.length === 0) {
        return '<p style="color:var(--text-secondary)">No dated ordinances in this slice' + (undated ? ' (' + undated + ' undated).' : '.') + '</p>';
      }
      const counts = new Map();
      for (const entry of dated) {
        const decade = Math.floor(entry.year / 10) * 10;
        counts.set(decade, (counts.get(decade) || 0) + 1);
      }
      const decades = [...counts.keys()].sort((a, b) => a - b);
      const peak = Math.max(...counts.values());
      let html = '<div style="display:flex;gap:6px;align-items:flex-end;height:140px;overflow-x:auto;padding-bottom:4px">';
      for (let decade = decades[0]; decade <= decades[decades.length - 1]; decade += 10) {
        const count = counts.get(decade) || 0;
        html += '<div style="display:flex;flex-direction:column;align-items:center;min-width:44px">'
          + '<div title="' + count + ' ordinance(s) in the ' + decade + 's" style="width:22px;height:' + Math.round((count / peak) * 105) + 'px;background:var(--accent);opacity:.7;border-radius:2px 2px 0 0"></div>'
          + '<span style="font-size:10px;color:var(--text-secondary);margin-top:4px">' + decade + '</span></div>';
      }
      html += '</div>';
      if (undated > 0) html += '<p style="font-size:11px;color:var(--text-secondary);margin-top:6px">' + undated + ' ordinance(s) carry no parseable year and are not placed on the timeline.</p>';
      return html;
    }

    async function loadChronologyPanel() {
      const el = document.getElementById('chronology-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Reading ordinance history…</p>';
      const guid = document.getElementById('chronology-guid-input').value.trim();
      const params = new URLSearchParams({ limit: '60' });
      if (guid) params.set('guid', guid);
      try {
        const resp = await apiFetch('/api/ordinance/chronology?' + params.toString());
        const data = await resp.json();
        if (!resp.ok) { el.innerHTML = '<p style="color:#f97316">' + escapeHtml(data.error || 'Chronology unavailable') + '</p>'; return; }
        const summary = data.summary;
        let html = '<div class="intel-grid" style="margin-bottom:16px">'
          + '<div class="intel-card"><h4>Sections scanned</h4><div class="metric">' + summary.sectionsScanned + '</div></div>'
          + '<div class="intel-card"><h4>With ordinance history</h4><div class="metric">' + summary.sectionsWithOrdinanceHistory + '</div></div>'
          + '<div class="intel-card"><h4>Distinct ordinances</h4><div class="metric">' + summary.distinctOrdinances + '</div></div>'
          + '<div class="intel-card"><h4>Recorded actions</h4><div class="metric">' + summary.totalAmendments + '</div></div>'
          + '<div class="intel-card"><h4>Year range</h4><div class="metric" style="font-size:20px">' + orDash(summary.earliestYear) + '–' + orDash(summary.latestYear) + '</div></div>'
          + '</div>';
        html += '<h4 style="margin:16px 0 8px">Ordinances per decade</h4>' + ordinanceTimeline(data.cityTimeline);
        html += '<h4 style="margin:20px 0 8px">City-wide lineage — newest first</h4><table class="intel-table"><thead><tr><th>Ordinance</th><th>Year</th><th>Actions</th><th>Sections touched</th></tr></thead><tbody>';
        for (const entry of data.cityTimeline.slice(0, 25)) {
          html += '<tr><td>' + escapeHtml(entry.ordinance) + '</td><td>' + orDash(entry.year) + '</td><td>' + escapeHtml(entry.actions.join(', ')) + '</td>'
            + '<td>' + entry.sectionCount + '<br><span style="font-size:11px;color:var(--text-secondary)">' + escapeHtml(entry.sectionNumbers.slice(0, 6).join(', ')) + (entry.sectionNumbers.length > 6 ? ' …' : '') + '</span></td></tr>';
        }
        html += '</tbody></table>';
        if (data.sectionChronologies.length > 0) {
          html += '<h4 style="margin:20px 0 8px">Per-section amendment trails</h4><table class="intel-table"><thead><tr><th>Section</th><th>Article</th><th>Trail</th><th>Span</th></tr></thead><tbody>';
          for (const section of data.sectionChronologies.slice(0, 25)) {
            const trail = section.amendments.map(a => escapeHtml(a.ordinance) + ' <span style="color:var(--text-secondary)">' + escapeHtml(a.action) + ' ' + (a.year === null ? '(undated)' : a.year) + '</span>').join(' → ');
            html += '<tr><td>&sect;&nbsp;' + escapeHtml(section.sectionNumber) + '</td><td>' + escapeHtml(section.articleTitle) + '</td><td style="line-height:1.6">' + trail + '</td>'
              + '<td>' + orDash(section.firstYear) + '–' + orDash(section.lastYear) + '</td></tr>';
          }
          html += '</tbody></table>';
        }
        if (data.truncated) html += '<p style="color:var(--text-secondary);font-size:12px;margin-top:12px">Lists bounded at 60 entries; the summary above reports the true totals.</p>';
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to build the ordinance timeline</p>'; }
    }
    document.getElementById('chronology-load-btn').addEventListener('click', loadChronologyPanel);

    const TREND_BADGE = { rising: 'badge-green', falling: 'badge-red', steady: 'badge-yellow', insufficient: 'badge-yellow' };

    async function loadInsightsPanel() {
      const el = document.getElementById('insights-content');
      el.innerHTML = '<p style="color:var(--text-secondary)">Loading the civic insight brief…</p>';
      try {
        const resp = await apiFetch('/api/insights');
        const data = await resp.json();
        if (!resp.ok) { el.innerHTML = '<p style="color:#f97316">' + escapeHtml(data.error || 'Insights unavailable') + '</p>'; return; }
        let html = '<p style="color:var(--text-secondary);font-size:12px;margin-bottom:12px">'
          + escapeHtml(data.source === 'persisted' ? 'Persisted report' : 'Computed on request')
          + ' · ' + data.windowDays + '-day window · generated ' + escapeHtml(String(data.generatedAt).slice(0, 19).replace('T', ' ')) + ' UTC'
          + ' · narrative: ' + escapeHtml(data.narrative.status) + '</p>';
        if (data.top && data.top.length > 0) {
          html += '<h4 style="margin:8px 0">Headline movements</h4>';
          for (const item of data.top) {
            const badge = TREND_BADGE[item.direction] || 'badge-yellow';
            html += '<div class="intel-card" style="margin-bottom:10px"><h4>#' + item.rank + ' ' + escapeHtml(item.domainId)
              + ' <span class="intel-badge ' + badge + '">' + escapeHtml(item.direction) + '</span></h4>'
              + '<p style="margin:6px 0;line-height:1.5">' + escapeHtml(item.paragraph) + '</p>'
              + '<p style="font-size:11px;color:var(--text-secondary)">&Delta; ' + item.deltaTotal
              + (item.momentumPct === null ? '' : ' · momentum ' + item.momentumPct + '%')
              + ' · evidence: ' + escapeHtml((item.evidenceSources || []).join(', ') || 'none') + '</p></div>';
          }
        } else {
          html += '<p style="color:var(--text-secondary)">No domain has enough data in both windows to headline a movement.</p>';
        }
        if (data.trends && data.trends.length > 0) {
          html += '<h4 style="margin:20px 0 8px">All domains</h4><table class="intel-table"><thead><tr><th>Domain</th><th>Direction</th><th>Current</th><th>Previous</th><th>&Delta;</th></tr></thead><tbody>';
          for (const trend of data.trends) {
            const badge = TREND_BADGE[trend.direction] || 'badge-yellow';
            html += '<tr><td>' + escapeHtml(trend.domainId) + '</td><td><span class="intel-badge ' + badge + '">' + escapeHtml(trend.direction) + '</span></td>'
              + '<td>' + orDash(trend.current && trend.current.total) + '</td><td>' + orDash(trend.previous && trend.previous.total) + '</td><td>' + orDash(trend.deltaTotal) + '</td></tr>';
          }
          html += '</tbody></table>';
        }
        if (data.coverageGaps && data.coverageGaps.length > 0) {
          html += '<h4 style="margin:20px 0 8px">Coverage gaps</h4><table class="intel-table"><thead><tr><th>Domain</th><th>Detail</th></tr></thead><tbody>';
          for (const gap of data.coverageGaps) {
            html += '<tr><td>' + escapeHtml(gap.domainId) + '</td><td>' + escapeHtml(gap.detail || gap.reason || '') + '</td></tr>';
          }
          html += '</tbody></table>';
        }
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load the civic insight brief</p>'; }
    }

    // ─── Chat model picker ───────────────────────────────────────────
    //
    // /api/chat has accepted a per-request `model` override for some time with
    // no way to discover a valid value. This populates the picker from
    // /api/llm/models and degrades to "Default model" alone when the provider

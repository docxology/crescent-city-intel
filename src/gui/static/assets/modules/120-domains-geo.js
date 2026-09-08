// 120-domains-geo.js — civic domains and hazard geo panels.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // ─ Domains Panel ─
    async function loadDomainsPanel() {
      const el = document.getElementById('domains-content');
      try {
        const domains = await apiFetch('/api/domains').then(r => r.json());
        let html = '<div class="intel-grid">';
        for (const d of domains) {
          html += `<div class="intel-card"><h4>${d.icon} ${d.name}</h4><div class="label">${d.topicCount} topics</div><p style="font-size:12px;color:var(--text-secondary);margin-top:8px">${d.description.substring(0,150)}...</p></div>`;
        }
        html += '</div>';
        el.innerHTML = html;
      } catch { el.innerHTML = '<p style="color:var(--text-secondary)">Failed to load domains</p>'; }
    }

    // ─ Geo Panel ─ (Crescent City civic/hazard map view; tiles-free)
    const GEO_PALETTE = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#ef4444', '#14b8a6', '#f43f5e', '#a855f7', '#0ea5e9', '#eab308'];
    function geoColor(index) { return GEO_PALETTE[index % GEO_PALETTE.length]; }

    /** Render the contract's feature view as a compact inline SVG map (no tiles). */
    function renderGeoMap(view) {
      const b = (view && view.anchor && view.anchor.bounds) || { west: -124.408, south: 41.458, east: -123.536, north: 42.006 };
      const W = 720, H = 460, pad = 30;
      const x = lon => pad + ((lon - b.west) / (b.east - b.west)) * (W - 2 * pad);
      const y = lat => pad + ((b.north - lat) / (b.north - b.south)) * (H - 2 * pad);
      const features = (view && view.features) || [];
      const anchorLat = (view && view.anchor.latitude) ?? 41.76;
      const anchorLon = (view && view.anchor.longitude) ?? -124.2;
      const hazardPoints = features.filter(f => f.properties && f.properties.kind === 'hazard-domain');
      const svg = [];
      svg.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Crescent City / Del Norte County hazard-domain map" style="width:100%;max-height:480px;height:auto;display:block;margin:0 auto">`);
      svg.push('<defs><marker id="geo-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10" fill="#8a94a6"/></marker></defs>');
      // Ocean (Pacific to the west) + land hint
      svg.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#10131f"/>`);
      svg.push(`<rect x="${pad}" y="${pad}" width="${W - 2 * pad}" height="${H - 2 * pad}" rx="8" fill="#12263a" stroke="#335c81" stroke-width="1"/>`);
      // Bounds polygon
      const corners = [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
      const boundsPts = corners.map(c => `${x(c[0]).toFixed(1)},${y(c[1]).toFixed(1)}`).join(' ');
      svg.push(`<polygon points="${boundsPts}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-dasharray="8,4"/>`);
      // North arrow
      svg.push(`<line x1="${W - 42}" y1="${pad + 16}" x2="${W - 42}" y2="${pad + 2}" stroke="#8a94a6" stroke-width="2" marker-end="url(#geo-arrow)"/><text x="${W - 62}" y="${pad + 13}" font-size="11" fill="#8a94a6">N</text>`);
      // Anchor
      svg.push(`<circle cx="${x(anchorLon).toFixed(1)}" cy="${y(anchorLat).toFixed(1)}" r="7" fill="#fff" stroke="#3b82f6" stroke-width="2.5"/><text x="${x(anchorLon).toFixed(1) + 10}" y="${y(anchorLat).toFixed(1) + 4}" font-size="12" fill="#e2e8f0">Crescent City</text>`);
      // Hazard-domain points
      hazardPoints.forEach((f, i) => {
        const pt = f.geometry.coordinates || [0, 0];
        const [lon, lat] = pt;
        const cx = x(lon).toFixed(1), cy = y(lat).toFixed(1);
        const label = `${f.properties.icon} ${f.properties.name}`;
        svg.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="${geoColor(i)}" stroke="#fff" stroke-width="1.5"><title>${escapeHtml(label)}</title></circle>`);
        svg.push(`<text x="${cx}" y="${cy - 9}" font-size="10" fill="${geoColor(i)}">${escapeHtml(f.properties.icon)}</text>`);
      });
      // Legend
      const lx = W - 150, lyStart = pad + 30;
      svg.push(`<rect x="${lx - 16}" y="${lyStart - 18}" width="160" height="${22 + hazardPoints.length * 18}" rx="6" fill="#101828" stroke="#335c81"/>`);
      svg.push(`<text x="${lx}" y="${lyStart}" font-size="12" fill="#cbd5e1" font-weight="600">Hazard domains</text>`);
      hazardPoints.forEach((f, i) => {
        svg.push(`<circle cx="${lx}" cy="${lyStart + 18 + i * 18}" r="5" fill="${geoColor(i)}"/>`);
        svg.push(`<text x="${lx + 10}" y="${lyStart + 21 + i * 18}" font-size="11" fill="#cbd5e1">${escapeHtml(f.properties.name)}</text>`);
      });
      svg.push('</svg>');
      return svg.join('\n');
    }

    /** Load and render the Crescent City civic/hazard geo panel. */
    async function loadGeoIntelPanel() {
      const mapEl = document.getElementById('geo-map');
      const gridEl = document.getElementById('geo-hazard-grid');
      const sectionsEl = document.getElementById('geo-sections');
      try {
        const data = await apiFetch('/api/geo-intel').then(r => r.json());
        const view = data.view || {};
        mapEl.innerHTML = renderGeoMap(view);

        // Hazard-relevant civic domains (from the contract's hazard subset)
        const relevant = (data.hazard && data.hazard.relevantDomains) || [];
        gridEl.innerHTML = relevant.length === 0
          ? '<p style="color:var(--text-secondary)">No hazard-relevant domains in the contract.</p>'
          : `<div class="intel-grid">${relevant.map((d, i) => `
            <div class="intel-card">
              <h4><span class="geo-swatch" style="background:${geoColor(i)}"></span>${d.icon} ${escapeHtml(d.name)}</h4>
              <div style="margin:6px 0">${(d.hazardTags || []).map(t => `<span class="geo-tag">${escapeHtml(t)}</span>`).join('')}</div>
              <p style="font-size:12px;color:var(--text-secondary);margin-top:8px">${(d.topics || []).length} hazard-weighted topic(s) · ${view.hazard ? view.hazard.domainCount : relevant.length} hazard-relevant domain(s)</p>
            </div>`).join('')}</div>`;

        // Hazard-weighted municipal-code sections
        const sections = view.sections || [];
        sectionsEl.innerHTML = sections.length === 0
          ? '<p style="color:var(--text-secondary)">No sections cross-reference hazard-relevant domains.</p>'
          : `<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden">${sections.map(s => `
            <div class="geo-section-row">
              <span class="num">${escapeHtml(s.sectionNumber)}</span>
              <div class="rel">${escapeHtml(s.relevance)}<div class="dom">${escapeHtml(s.domains.join(' · '))}</div></div>
            </div>`).join('')}</div>`;
      } catch (err) {
        mapEl.innerHTML = '<p style="color:var(--text-secondary)">Geo view unavailable.</p>';
        gridEl.innerHTML = '<p style="color:var(--text-secondary)">Could not load hazard domains.</p>';
        sectionsEl.innerHTML = '<p style="color:var(--text-secondary)">Could not load sections.</p>';
      }
    }

    // ─ Live hazard observations (additive; wave-2 endpoint) ─────────
    // GET /api/geo-observations → the crescent-city-geo-observations/v1
    // envelope: { schema, anchor, composite, monitors[], hazardSummary[],
    // freshness }. The route goes live in wave 2; until then the fetch fails
    // and the graceful empty state below stays visible. Every field is read
    // defensively — a missing or malformed field renders the empty state,
    // never a throw.
    function geoObservationsEmpty(el, message) {
      el.innerHTML = `<p style="color:var(--text-secondary)">${escapeHtml(message || 'No live hazard observations available yet.')}</p>`;
    }

    function geoCompositeBadge(composite) {
      const level = String(composite?.level ?? '').toUpperCase();
      if (!level) return '';
      const colors = { CALM: '#22c55e', GOOD: '#22c55e', NONE: '#22c55e', WATCH: '#eab308', ADVISORY: '#eab308', WARNING: '#f97316', EMERGENCY: '#ef4444' };
      const color = colors[level] || '#888';
      const reason = geoObsText(composite?.reason, 240);
      return `<div style="padding:0.6rem;border-radius:8px;background:${color}22;border:1px solid ${color};margin-bottom:0.75rem">`
        + `<strong style="color:${color};font-size:1.05rem">${escapeHtml(level)}</strong>`
        + (reason ? `<span style="margin-left:0.5rem;color:var(--text-secondary)">${escapeHtml(reason)}</span>` : '')
        + '</div>';
    }

    function geoObsText(value, maxLength = 160) {
      return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
    }

    function geoMonitorChip(monitor) {
      const name = geoObsText(monitor?.name ?? monitor?.type, 40) || 'monitor';
      const status = geoObsText(monitor?.status ?? monitor?.level ?? monitor?.condition, 40) || 'not-checked';
      const colors = { ok: '#22c55e', calm: '#22c55e', empty: '#60a5fa', stale: '#eab308', unavailable: '#ef4444', 'not-checked': '#eab308', warning: '#f97316', emergency: '#ef4444' };
      const color = colors[String(status).toLowerCase()] || '#888';
      return `<span class="geo-obs-chip" title="${escapeHtmlAttr(name + ': ' + status)}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;margin:0 6px 6px 0;border:1px solid var(--border);border-radius:999px;font-size:11px">`
        + `<span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span>`
        + `${escapeHtml(name)} \u00b7 ${escapeHtml(status)}</span>`;
    }

    async function loadGeoObservations() {
      const el = document.getElementById('geo-observations-content');
      if (!el) return;
      try {
        const resp = await apiFetch('/api/geo-observations');
        if (!resp.ok) { geoObservationsEmpty(el, 'Live hazard observations unavailable (route not live yet).'); return; }
        const data = await resp.json();
        const monitors = Array.isArray(data?.monitors) ? data.monitors : [];
        if (!data || typeof data !== 'object' || (monitors.length === 0 && !data.composite && !Array.isArray(data.hazardSummary))) {
          geoObservationsEmpty(el);
          return;
        }
        let html = '';
        if (data.schema) {
          html += `<p style="color:var(--text-secondary);font-size:11px;margin-bottom:6px">schema ${escapeHtml(String(data.schema))}</p>`;
        }
        html += geoCompositeBadge(data.composite);
        html += '<div>';
        for (const monitor of monitors) html += geoMonitorChip(monitor);
        html += '</div>';
        if (Array.isArray(data.hazardSummary) && data.hazardSummary.length > 0) {
          html += '<div style="margin-top:8px;color:var(--text-secondary);font-size:12px">'
            + data.hazardSummary.map((h) => escapeHtml(geoObsText(h?.label ?? h?.hazard ?? h, 80)) || '').filter(Boolean).map((s) => `\u2022 ${s}`).join(' ')
            + '</div>';
        }
        if (data.freshness) {
          html += `<div style="margin-top:6px;color:var(--text-secondary);font-size:11px">freshness: ${escapeHtml(geoObsText(data.freshness, 120) || String(data.freshness))}</div>`;
        }
        el.innerHTML = html;
      } catch { geoObservationsEmpty(el, 'Live hazard observations unavailable.'); }
    }

    // Wrap the panel loader so live observations load alongside the geo
    // panel; the verbatim function above is only relocated, never rewritten.
    const _baseLoadGeoIntelPanel = loadGeoIntelPanel;
    loadGeoIntelPanel = async function () {
      await _baseLoadGeoIntelPanel();
      try { await loadGeoObservations(); } catch { /* non-fatal */ }
    };

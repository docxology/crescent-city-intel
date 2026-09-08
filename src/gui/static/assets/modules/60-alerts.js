// 60-alerts.js — analytics-toggle wiring, alert trends/heatmap/correlations, alerts dashboard.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // ─── Analytics ─────────────────────────────────────────
    const TITLE_COLORS = [
      '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db',
      '#2980b9', '#9b59b6', '#8e44ad', '#e91e63', '#00bcd4', '#4caf50',
      '#ff9800', '#795548', '#607d8b', '#673ab7', '#009688', '#cddc39',
      '#ff5722', '#3f51b5'
    ];

    function titleColor(title) {
      const num = parseInt(title.replace(/\D/g, ''), 10);
      if (!isNaN(num) && num >= 1 && num <= 17) return TITLE_COLORS[num - 1];
      return TITLE_COLORS[17 + (title.charCodeAt(0) % 3)];
    }

    // Lazy-load tracking shared by every sub-tab across all 3 tabbed
    // overlays (Code Analytics / News & Feeds / Developer) — tab names are
    // unique across the whole app, so one flat map is enough.
    const tabLoaded = {};

    document.getElementById('analytics-toggle').addEventListener('click', () => {
      const overlay = document.getElementById('analytics-overlay');
      const wasOpen = overlay.classList.contains('open');
      closeAllOverlays();
      if (!wasOpen) {
        overlay.classList.add('open');
        document.getElementById('analytics-toggle').classList.add('active');
        if (!tabLoaded.stats) { tabLoaded.stats = true; loadAnalytics(); }
      }
    });

    // ─── Alert trends (no-build browser mirror of gui/alert_trends.ts) ──
    // The pure TypeScript implementation is the tested contract. This local
    // SPA has no build step, so the browser keeps a small equivalent view-model
    // builder and is exercised end-to-end by scripts/browser-smoke.ts.
    const ALERT_TREND_TYPES = ['tsunami', 'earthquake', 'weather', 'tides', 'airquality', 'wildfire', 'marine', 'fishing', 'uscg'];
    const ALERT_TREND_SOURCE_BY_TYPE = {
      tsunami: 'NOAA Tsunami', earthquake: 'USGS Earthquake', weather: 'NWS Weather', tides: 'NOAA Tides',
      airquality: 'EPA AirNow', wildfire: 'CAL FIRE Wildfire', marine: 'NDBC Marine', fishing: 'CDFW Fishing',
      uscg: 'USCG Notice to Mariners',
    };
    const ALERT_TREND_ICONS = { tsunami: '🌊', earthquake: '🌍', weather: '⛈️', tides: '🕐', fishing: '🦀', airquality: '🌫️', wildfire: '🔥', marine: '⚓', uscg: '📻' };
    const ALERT_TREND_DAY_MS = 24 * 60 * 60 * 1000;
    const ALERT_TREND_WINDOW_DAYS = 14;
    const ALERT_TREND_HISTORY_LIMIT = 500;
    const ALERT_TREND_EVENT_LIMIT = 5000;
    const ALERT_TREND_HEALTH_STATES = new Set(['ok', 'empty', 'stale', 'unavailable']);
    const ALERT_TREND_CALM_LEVELS = new Set(['CALM', 'GOOD', 'NONE', 'NORMAL', 'OK']);
    let alertTrendViewModel = null;
    let alertTrendFetchMeta = null;

    function alertTrendText(value, maxLength = 160) {
      return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
    }

    function alertTrendUtcDate(timestampMs) {
      return new Date(timestampMs).toISOString().slice(0, 10);
    }

    function alertTrendDisplayDate(date) {
      const timestamp = Date.parse(`${date}T00:00:00.000Z`);
      return Number.isFinite(timestamp)
        ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
        : 'unknown';
    }

    function alertTrendTimestamp(value) {
      const timestamp = Date.parse(String(value || ''));
      return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'unknown time';
    }

    function alertTrendCurrentLevels(alertsPayload) {
      const levels = {};
      for (const type of ALERT_TREND_TYPES) {
        const data = alertsPayload?.alerts?.[type];
        if (!data || typeof data !== 'object') continue;
        const candidates = [data.level, data.severityLevel, data.overallStatus, data.alertLevel, data.currentLevel, data.status, data.report?.level];
        const level = candidates.find(value => typeof value === 'string' && value.trim());
        if (level) levels[type] = level;
      }
      return levels;
    }

    function buildAlertTrendViewClient(events, sourceHealth, currentLevels, now = Date.now()) {
      const nowDate = new Date(now);
      const endDayMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
      const startDayMs = endDayMs - (ALERT_TREND_WINDOW_DAYS - 1) * ALERT_TREND_DAY_MS;
      const endExclusiveMs = endDayMs + ALERT_TREND_DAY_MS;
      const dates = Array.from({ length: ALERT_TREND_WINDOW_DAYS }, (_, index) => alertTrendUtcDate(startDayMs + index * ALERT_TREND_DAY_MS));
      const dateIndex = new Map(dates.map((date, index) => [date, index]));
      const healthBySource = new Map();
      for (const value of Array.isArray(sourceHealth) ? sourceHealth : []) {
        if (!value || typeof value !== 'object') continue;
        const source = alertTrendText(value.source, 120);
        if (!source) continue;
        const status = ALERT_TREND_HEALTH_STATES.has(value.status) ? value.status : 'unknown';
        const checkedAt = Number.isFinite(Date.parse(String(value.checkedAt || ''))) ? String(value.checkedAt) : null;
        const itemCount = Number.isInteger(value.itemCount) && value.itemCount >= 0 ? value.itemCount : null;
        healthBySource.set(source, { status, checkedAt, itemCount, error: alertTrendText(value.error, 240) || null });
      }

      const rows = new Map(ALERT_TREND_TYPES.map(type => [type, {
        type,
        source: ALERT_TREND_SOURCE_BY_TYPE[type],
        buckets: dates.map(date => ({ date, count: 0, severityCounts: {} })),
        sampledEvents: 0,
        mostRecentAt: null,
      }]));
      const boundedEvents = (Array.isArray(events) ? events : []).slice(-ALERT_TREND_EVENT_LIMIT);
      const seen = new Set();
      let duplicateEvents = 0;
      let invalidEvents = 0;
      let processedEvents = 0;

      for (const value of boundedEvents) {
        if (!value || typeof value !== 'object' || !ALERT_TREND_TYPES.includes(value.type)) {
          invalidEvents += 1;
          continue;
        }
        const timestampMs = typeof value.timestamp === 'number' ? value.timestamp : Date.parse(String(value.timestamp || ''));
        if (!Number.isFinite(timestampMs)) {
          invalidEvents += 1;
          continue;
        }
        const timestamp = new Date(timestampMs).toISOString();
        const severity = (alertTrendText(value.severity, 40) || 'UNKNOWN').toUpperCase();
        const recordId = alertTrendText(value.record?.id, 160);
        const description = alertTrendText(value.description, 240);
        const key = `${value.type}|${timestamp}|${recordId || `${severity}|${description}`}`;
        if (seen.has(key)) {
          duplicateEvents += 1;
          continue;
        }
        seen.add(key);
        processedEvents += 1;
        const row = rows.get(value.type);
        row.sampledEvents += 1;
        if (!row.mostRecentAt || timestamp > row.mostRecentAt) row.mostRecentAt = timestamp;
        if (timestampMs < startDayMs || timestampMs >= endExclusiveMs) continue;
        const bucket = row.buckets[dateIndex.get(alertTrendUtcDate(timestampMs))];
        bucket.count += 1;
        bucket.severityCounts[severity] = (bucket.severityCounts[severity] || 0) + 1;
      }

      const maxCellCount = Math.max(0, ...[...rows.values()].flatMap(row => row.buckets.map(bucket => bucket.count)));
      const normalizedRows = ALERT_TREND_TYPES.map(type => {
        const row = rows.get(type);
        const health = healthBySource.get(row.source) || { status: 'unknown', checkedAt: null, itemCount: null, error: null };
        const currentLevel = alertTrendText(currentLevels?.[type], 40).toUpperCase() || null;
        const conditionState = !currentLevel ? 'unknown' : ALERT_TREND_CALM_LEVELS.has(currentLevel) ? 'calm' : 'active';
        const displayState = ['empty', 'stale', 'unavailable'].includes(health.status)
          ? health.status
          : health.status === 'unknown'
            ? 'unknown'
            : conditionState === 'calm'
              ? 'calm'
              : conditionState === 'active' ? 'active' : 'available';
        const buckets = row.buckets.map(bucket => ({
          ...bucket,
          intensity: bucket.count <= 0 || maxCellCount <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((bucket.count / maxCellCount) * 4))),
        }));
        return {
          ...row,
          ...health,
          currentLevel,
          conditionState,
          displayState,
          buckets,
          windowEvents: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
        };
      });

      return {
        generatedAt: nowDate.toISOString(),
        startDate: dates[0],
        endDate: dates[dates.length - 1],
        rows: normalizedRows,
        maxCellCount,
        processedEvents,
        duplicateEvents,
        invalidEvents,
        truncatedEvents: Math.max(0, (Array.isArray(events) ? events.length : 0) - boundedEvents.length),
      };
    }

    function alertTrendStateLabel(row) {
      if (row.displayState === 'active') return row.currentLevel || 'ACTIVE';
      if (row.displayState === 'calm') return row.currentLevel || 'CALM';
      return row.displayState.toUpperCase();
    }

    function renderAlertTrends(selectedType) {
      const root = document.getElementById('alert-trends-content');
      const select = document.getElementById('alert-trend-type');
      if (!alertTrendViewModel || !root || !select) return;
      if (!select.options.length) {
        select.innerHTML = ALERT_TREND_TYPES.map(type => `<option value="${escapeHtmlAttr(type)}">${ALERT_TREND_ICONS[type]} ${escapeHtml(type)}</option>`).join('');
      }
      const type = ALERT_TREND_TYPES.includes(selectedType) ? selectedType : (select.value || 'tsunami');
      select.value = type;
      const row = alertTrendViewModel.rows.find(item => item.type === type);
      const selectedMax = Math.max(0, ...row.buckets.map(bucket => bucket.count));
      const statusText = alertTrendStateLabel(row);
      const conditionText = row.currentLevel
        ? `${row.status === 'ok' ? 'current' : 'last reported'} level ${row.currentLevel}`
        : 'no explicit current level';
      const healthText = row.status === 'ok'
        ? 'source available'
        : row.status === 'empty'
          ? 'source checked successfully with no matching items'
          : row.status === 'stale'
            ? 'source data is stale'
            : row.status === 'unavailable'
              ? 'source unavailable' : 'source health unknown';
      const mostRecent = row.mostRecentAt ? `Most recent sampled event: ${alertTrendTimestamp(row.mostRecentAt)}.` : 'No sampled event timestamp.';
      const bars = row.buckets.map(bucket => {
        const height = bucket.count === 0 ? 2 : Math.max(8, Math.round((bucket.count / Math.max(1, selectedMax)) * 76));
        const label = `${row.source} on ${alertTrendDisplayDate(bucket.date)}: ${bucket.count} recorded event${bucket.count === 1 ? '' : 's'}`;
        return `<div class="alert-trend-column" role="listitem" aria-label="${escapeHtmlAttr(label)}"><div class="alert-trend-count" aria-hidden="true">${bucket.count}</div><div class="alert-trend-bar-track" aria-hidden="true"><span class="alert-trend-bar${bucket.count === 0 ? ' zero' : ''}" style="height:${height}px"></span></div><div class="alert-trend-date" aria-hidden="true">${escapeHtml(alertTrendDisplayDate(bucket.date))}</div></div>`;
      }).join('');

      const dateHeaders = alertTrendViewModel.rows[0].buckets
        .map(bucket => `<th scope="col"><span aria-hidden="true">${escapeHtml(alertTrendDisplayDate(bucket.date))}</span><span class="visually-hidden">${escapeHtml(bucket.date)}</span></th>`)
        .join('');
      const heatRows = alertTrendViewModel.rows.map(heatRow => {
        const heatState = alertTrendStateLabel(heatRow);
        const cells = heatRow.buckets.map(bucket => {
          const cellLabel = `${heatRow.source}, ${bucket.date}: ${bucket.count} recorded event${bucket.count === 1 ? '' : 's'}; source ${heatRow.status}; state ${heatState}`;
          return `<td class="heat-${bucket.intensity}" aria-label="${escapeHtmlAttr(cellLabel)}"><span aria-hidden="true">${bucket.count || '·'}</span></td>`;
        }).join('');
        return `<tr data-state="${escapeHtmlAttr(heatRow.displayState)}"><th scope="row">${ALERT_TREND_ICONS[heatRow.type]} ${escapeHtml(heatRow.type)} <span class="alert-state-chip" data-state="${escapeHtmlAttr(heatRow.displayState)}">${escapeHtml(heatState)}</span></th>${cells}</tr>`;
      }).join('');
      const failures = alertTrendFetchMeta?.failures || [];
      const fetchWarning = failures.length
        ? ` Endpoint gaps: ${failures.map(value => escapeHtml(value)).join(', ')}.`
        : '';
      const historyTotal = Number.isFinite(alertTrendFetchMeta?.reportedHistoryTotal) ? alertTrendFetchMeta.reportedHistoryTotal : 0;

      root.innerHTML = `
        <div class="alert-trend-summary">
          <span class="alert-state-chip" data-state="${escapeHtmlAttr(row.displayState)}">${escapeHtml(statusText)}</span>
          <strong>${ALERT_TREND_ICONS[row.type]} ${escapeHtml(row.source)}</strong> · ${row.windowEvents} recorded event${row.windowEvents === 1 ? '' : 's'} from ${escapeHtml(alertTrendViewModel.startDate)} through ${escapeHtml(alertTrendViewModel.endDate)} UTC · ${escapeHtml(healthText)} · ${escapeHtml(conditionText)}. ${escapeHtml(mostRecent)}
          ${row.error ? `<div style="margin-top:4px;color:#b45309">Source detail: ${escapeHtml(row.error)}</div>` : ''}
        </div>
        <div id="alert-trend-chart" class="alert-trend-bars" role="list" aria-label="${escapeHtmlAttr(`${row.source} daily recorded event trend for ${alertTrendViewModel.startDate} through ${alertTrendViewModel.endDate} UTC`)}">${bars}</div>
        <div class="alert-heatmap-wrap">
          <table class="alert-heatmap">
            <caption>All monitor types by UTC day; cell color represents recorded event count, not current safety.</caption>
            <thead><tr><th scope="col">Monitor / source state</th>${dateHeaders}</tr></thead>
            <tbody>${heatRows}</tbody>
          </table>
        </div>
        <p class="alert-trend-note">Bounded union of the latest timeline (maximum 1,000 entries) and at most ${ALERT_TREND_HISTORY_LIMIT} history entries per type; exact overlaps are deduplicated and rendering is capped at ${ALERT_TREND_EVENT_LIMIT.toLocaleString()} records. Processed ${alertTrendViewModel.processedEvents.toLocaleString()} unique sampled records (${alertTrendViewModel.duplicateEvents.toLocaleString()} overlaps, ${alertTrendViewModel.invalidEvents.toLocaleString()} invalid, ${alertTrendViewModel.truncatedEvents.toLocaleString()} truncated); the per-type endpoints currently expose ${historyTotal.toLocaleString()} records before paging.${fetchWarning}</p>`;
      root.setAttribute('aria-busy', 'false');
    }

    async function loadAlertTrends() {
      const root = document.getElementById('alert-trends-content');
      root.setAttribute('aria-busy', 'true');
      const failures = [];
      async function boundedJson(path, label) {
        try {
          const response = await apiFetch(path);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json();
        } catch (error) {
          failures.push(`${label}: ${alertTrendText(error?.message || error, 100) || 'request failed'}`);
          return null;
        }
      }

      const [timeline, health, monitor, histories] = await Promise.all([
        boundedJson('/api/alerts/timeline', 'timeline'),
        boundedJson('/api/health', 'source health'),
        boundedJson('/api/monitor/alerts', 'current monitors'),
        Promise.all(ALERT_TREND_TYPES.map(type =>
          boundedJson(`/api/alerts/${encodeURIComponent(type)}/history?limit=${ALERT_TREND_HISTORY_LIMIT}`, `${type} history`))),
      ]);
      const events = Array.isArray(timeline?.timeline) ? [...timeline.timeline] : [];
      let reportedHistoryTotal = 0;
      histories.forEach((history, index) => {
        if (!history) return;
        const type = ALERT_TREND_TYPES[index];
        if (Number.isFinite(history.total) && history.total >= 0) reportedHistoryTotal += Math.floor(history.total);
        for (const value of Array.isArray(history.alerts) ? history.alerts : []) {
          events.push(value && typeof value === 'object' && !value.type ? { ...value, type } : value);
        }
      });

      alertTrendViewModel = buildAlertTrendViewClient(
        events,
        Array.isArray(health?.alertSources) ? health.alertSources : monitor?.alerts?.sourceHealth?.sources,
        alertTrendCurrentLevels(monitor),
      );
      alertTrendFetchMeta = { failures, reportedHistoryTotal };
      renderAlertTrends(document.getElementById('alert-trend-type').value || 'tsunami');
    }

    document.getElementById('alert-trend-type').addEventListener('change', event => renderAlertTrends(event.target.value));

    // ─── Cross-monitor correlations ──────────────────────────────────
    async function loadAlertCorrelations() {
      const root = document.getElementById('alert-correlations-content');
      if (!root) return;
      root.setAttribute('aria-busy', 'true');
      try {
        const data = await apiFetch('/api/alerts/correlation').then(r => r.json());
        const pairs = Array.isArray(data.pairs) ? data.pairs : [];
        if (pairs.length === 0) {
          root.innerHTML = '<p style="color:var(--text-muted, #888);">No correlation pairs configured.</p>';
        } else {
          const rows = pairs.map(p => {
            const observed = `${p.observedPairs} pair${p.observedPairs === 1 ? '' : 's'}`;
            const lift = p.lift === null ? '–' : `${p.lift}× uniform-rate expectation`;
            const lag = p.medianLagMinutes === null ? '–' : `${p.medianLagMinutes} min median lag`;
            const cadence = p.cadenceSensitive ? ' · <span style="color:#b45309">cadence-sensitive</span>' : '';
            const sample = p.samples && p.samples[0]
              ? `<div style="font-size:0.75rem; color:var(--text-muted, #888); margin-top:0.15rem;">e.g. ${escapeHtml(p.samples[0].aDescription)} then ${escapeHtml(p.samples[0].bDescription)} (${p.samples[0].lagMinutes} min)</div>`
              : '';
            return `<div style="padding:0.5rem; border:1px solid var(--border, #333); border-radius:6px; background:var(--bg-primary, #111); margin-bottom:0.4rem;">
<strong style="font-size:0.85rem;">${escapeHtml(p.typeA)} → ${escapeHtml(p.typeB)}</strong> <span style="color:var(--text-muted, #888); font-size:0.75rem;">window ${p.windowMinutes} min</span>
<div style="font-size:0.8rem;">${observed} · ${lift} · ${lag}${cadence}</div>
${sample}
</div>`;
          }).join('');
          const notes = Array.isArray(data.notes) && data.notes.length
            ? `<div style="font-size:0.75rem; color:var(--text-muted, #888); margin-top:0.4rem;">${data.notes.map(n => escapeHtml(n)).join(' ')}</div>`
            : '';
          root.innerHTML = rows + notes;
        }
      } catch (err) {
        root.innerHTML = '<p style="color:#b45309;">Correlations unavailable: ' + escapeHtml(String(err && err.message || err)) + '</p>';
      } finally {
        root.setAttribute('aria-busy', 'false');
      }
    }

    // ─── Alerts Dashboard (15 real-time monitors + timeline) ─────────
    document.getElementById('alerts-toggle').addEventListener('click', () => {
      const panel = document.getElementById('alerts-panel');
      const wasOpen = panel.style.display !== 'none';
      closeAllOverlays();
      if (!wasOpen) {
        panel.style.display = 'block';
        document.getElementById('alerts-toggle').classList.add('active');
        if (!tabLoaded.alertsPanel) {
          tabLoaded.alertsPanel = true;
          loadAlertsDashboard();
          loadAlertTrends();
          loadAlertTimeline();
          loadAlertCorrelations();
        }
      }
    });

    async function loadAlertsDashboard() {
      const container = document.getElementById('alerts-content');
      try {
        // Fetch composite severity + all monitor data
        const [alertsResp, timelineResp] = await Promise.all([
          apiFetch('/api/monitor/alerts'),
          apiFetch('/api/alerts/timeline'),
        ]);
        const alertsData = await alertsResp.json();
        const timelineData = await timelineResp.ok ? await timelineResp.json() : null;

        let html = '';

        // Composite severity banner
        const composite = alertsData.alerts?.composite;
        if (composite) {
          const levelColors = { CALM: '#22c55e', WATCH: '#eab308', WARNING: '#f97316', EMERGENCY: '#ef4444' };
          const compositeLevel = alertTrendText(composite.level, 40).toUpperCase() || 'UNKNOWN';
          const color = levelColors[compositeLevel] || '#888';
          html += `<div style="padding:0.75rem; border-radius:8px; background:${color}22; border:1px solid ${color}; margin-bottom:0.5rem;">`;
          html += `<strong style="color:${color}; font-size:1.1rem;">${escapeHtml(compositeLevel)}</strong>`;
          html += `<span style="margin-left:0.5rem; color:var(--text-muted, #888);">${escapeHtml(alertTrendText(composite.reason, 300) || 'No reason recorded')}</span>`;
          html += `<span style="float:right; font-size:0.8rem; color:var(--text-muted, #888);">${escapeHtml(alertTrendTimestamp(composite.assessedAt))}</span>`;
          html += '</div>';
        }

        // Per-monitor grid
        const monitorOrder = ['tsunami', 'earthquake', 'weather', 'tides', 'fishing', 'airquality', 'wildfire', 'marine', 'uscg'];
        const monitorIcons = { tsunami: '🌊', earthquake: '🌍', weather: '⛈️', tides: '🕐', fishing: '🦀', airquality: '🌫️', wildfire: '🔥', marine: '⚓', uscg: '📻' };

        html += '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:0.5rem; margin-bottom:1rem;">';
        for (const type of monitorOrder) {
          const data = alertsData.alerts?.[type];
          const icon = monitorIcons[type] || '📊';
          if (data) {
            const summary = alertTrendText(data.summary, 80) || alertTrendText(data.level, 40) || 'Data available';
            const level = (alertTrendText(data.level, 40) || (data.overallStatus ? 'CHECK' : 'OK')).toUpperCase();
            const levelColors = { CALM: '#22c55e', WATCH: '#eab308', WARNING: '#f97316', EMERGENCY: '#ef4444', GOOD: '#22c55e', ADVISORY: '#eab308', NONE: '#22c55e' };
            const color = levelColors[level] || '#888';
            html += `<div style="padding:0.5rem; border-radius:6px; background:var(--bg-primary, #111); border:1px solid var(--border, #333);">`;
            html += `<div style="font-size:0.9rem;">${icon} <strong>${escapeHtml(type)}</strong></div>`;
            html += `<div style="font-size:0.8rem; color:${color};">${escapeHtml(level)}</div>`;
            html += `<div style="font-size:0.75rem; color:var(--text-muted, #888); margin-top:0.25rem;">${escapeHtml(summary)}</div>`;
            html += '</div>';
          } else {
            html += `<div style="padding:0.5rem; border-radius:6px; background:var(--bg-primary, #111); border:1px solid var(--border, #333); opacity:0.5;">`;
            html += `<div style="font-size:0.9rem;">${icon} <strong>${type}</strong></div>`;
            html += `<div style="font-size:0.75rem; color:var(--text-muted, #888);">No data</div>`;
            html += '</div>';
          }
        }
        html += '</div>';

        // Timeline summary
        if (timelineData && timelineData.totalEvents > 0) {
          const totalEvents = Number.isFinite(timelineData.totalEvents) ? Math.max(0, Math.floor(timelineData.totalEvents)) : 0;
          html += `<div style="margin-top:0.5rem;">`;
          html += `<strong>📊 Alert Timeline:</strong> ${totalEvents} total events`;
          if (timelineData.mostActiveType) {
            html += ` · Most active: <strong>${escapeHtml(alertTrendText(timelineData.mostActiveType, 40))}</strong>`;
          }
          if (timelineData.mostRecentAlert) {
            const recent = timelineData.mostRecentAlert;
            const recentDescription = alertTrendText(recent.description, 80) || 'No description';
            html += `<div style="font-size:0.8rem; color:var(--text-muted, #888); margin-top:0.25rem;">`;
            html += `Most recent: [${escapeHtml(alertTrendText(recent.type, 40) || 'unknown')}] ${escapeHtml(recentDescription)} — ${escapeHtml(alertTrendTimestamp(recent.timestamp))}</div>`;
          }
          html += '</div>';
        }

        container.innerHTML = html || '<p style="color:var(--text-muted, #888);">No alert data available. Run: bun run alerts</p>';
      } catch (err) {
        container.innerHTML = '<p style="color:#f97316;">Failed to load alerts. Is the GUI running?</p>';
      }
    }

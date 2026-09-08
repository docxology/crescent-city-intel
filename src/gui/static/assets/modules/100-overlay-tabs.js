// 100-overlay-tabs.js — chat model discovery, tabbed overlay machinery, sources/feeds/dev toggles.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // is unreachable — an unreachable provider must not look like a choice.
    async function loadChatModels() {
      const select = document.getElementById('chat-model');
      if (!select) return;
      try {
        const resp = await apiFetch('/api/llm/models');
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.status !== 'ok' || !Array.isArray(data.models)) return;
        for (const model of data.models) {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model === data.configured ? model + ' (default)' : model;
          select.appendChild(option);
        }
        select.title = data.provider + ' · ' + data.count + ' model(s)';
      } catch { /* picker stays at "Default model" — never block chat on discovery */ }
    }

    // ─── News & Feeds / Developer: shared sub-tab wiring ─────────────
    //
    // Three top-level overlays (Code Analytics, News & Feeds, Developer)
    // all use the same .intel-tabs/.intel-tab/.intel-panel markup. Tab
    // clicks must only affect tabs/panels within their OWN overlay — a
    // single document-wide querySelectorAll (the old approach, when there
    // was only one such overlay) would deactivate tabs in a different
    // overlay than the one clicked. initTabbedOverlay() scopes every query
    // to the overlay element passed in.
    const TAB_LOADERS = {
      readability: loadReadabilityPanel,
      glossary: loadGlossary,
      xrefs: loadXRefs,
      domains: loadDomainsPanel,
      overview: loadIntelOverview,
      curated: loadCuratedFeed,
      report: loadReport,
      api: loadApiExplorer,
      search: loadSearchAnalytics,
      sources: loadSourceCoverage,
      'source-json': loadSourceJson,
      geo: loadGeoIntelPanel,
      graph: loadSectionGraphPanel,
      lexicon: loadLexiconPanel,
      longevity: loadLongevityPanel,
      chronology: loadChronologyPanel,
      insights: loadInsightsPanel,
      // stats loads via the Code Analytics toggle-button open handler; compare/
      // history load via their own explicit "Compare"/"Load" button, not on tab-open.
    };

    function initTabbedOverlay(overlayId) {
      const overlay = document.getElementById(overlayId);
      overlay.querySelectorAll('.intel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          overlay.querySelectorAll('.intel-tab').forEach(t => t.classList.remove('active'));
          overlay.querySelectorAll('.intel-panel').forEach(p => p.classList.remove('active'));
          tab.classList.add('active');
          const tabName = tab.dataset.tab;
          document.getElementById('intel-' + tabName).classList.add('active');
          if (!tabLoaded[tabName] && TAB_LOADERS[tabName]) {
            tabLoaded[tabName] = true;
            TAB_LOADERS[tabName]();
          }
        });
      });
    }
    initTabbedOverlay('analytics-overlay');
    initTabbedOverlay('feeds-overlay');
    initTabbedOverlay('sources-overlay');
    initTabbedOverlay('dev-overlay');

    document.getElementById('sources-toggle').addEventListener('click', () => {
      const overlay = document.getElementById('sources-overlay');
      const wasOpen = overlay.classList.contains('open');
      closeAllOverlays();
      if (!wasOpen) {
        overlay.classList.add('open');
        document.getElementById('sources-toggle').classList.add('active');
        if (!tabLoaded.sources) { tabLoaded.sources = true; loadSourceCoverage(); }
      }
    });

    document.getElementById('source-filter').addEventListener('input', renderSourceCoverage);
    document.getElementById('source-automation-filter').addEventListener('change', renderSourceCoverage);
    document.getElementById('source-status-filter').addEventListener('change', renderSourceCoverage);
    document.getElementById('source-refresh').addEventListener('click', loadSourceCoverage);
    document.getElementById('source-table').addEventListener('click', event => {
      const button = event.target.closest('.source-inspect');
      if (!button) return;
      sourceSelectedId = button.dataset.sourceId;
      renderSourceCoverage();
    });
    document.getElementById('source-download').addEventListener('click', () => {
      if (sourceCoverageData) downloadStructuredJson('crescent-city-source-coverage.json', { ...sourceCoverageData, filteredSources: filteredSourceCoverageRecords() });
    });
    document.getElementById('source-json-download').addEventListener('click', () => {
      if (sourceCoverageData) downloadStructuredJson('crescent-city-source-envelope.json', sourceCoverageData);
    });
    document.getElementById('source-json-copy').addEventListener('click', async event => {
      if (!sourceCoverageData) await loadSourceJson();
      if (!sourceCoverageData) return;
      await navigator.clipboard?.writeText(JSON.stringify(sourceCoverageData, null, 2));
      event.currentTarget.textContent = 'Copied';
      document.getElementById('source-json-state').textContent = 'Structured source envelope copied.';
    });

    document.getElementById('feeds-toggle').addEventListener('click', () => {
      const overlay = document.getElementById('feeds-overlay');
      const wasOpen = overlay.classList.contains('open');
      closeAllOverlays();
      if (!wasOpen) {
        overlay.classList.add('open');
        document.getElementById('feeds-toggle').classList.add('active');
        if (!tabLoaded.overview) { tabLoaded.overview = true; loadIntelOverview(); }
      }
    });

    document.getElementById('dev-toggle').addEventListener('click', () => {
      const overlay = document.getElementById('dev-overlay');
      const wasOpen = overlay.classList.contains('open');
      closeAllOverlays();
      if (!wasOpen) {
        overlay.classList.add('open');
        document.getElementById('dev-toggle').classList.add('active');
        if (!tabLoaded.api) { tabLoaded.api = true; loadApiExplorer(); }
      }
    });

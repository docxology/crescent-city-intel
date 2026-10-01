import { cancelReaderTasks, announce } from "../reader-lifecycle.js";
import { loadReadabilityPanel } from "./130-readability.js";
import { loadAnalytics } from "./70-analytics.js";
import { loadApiExplorer, loadCuratedFeed, loadGlossary, loadIntelOverview, loadReport, loadSearchAnalytics, loadXRefs } from "./110-feeds.js";
import { loadDomainsPanel, loadGeoIntelPanel } from "./120-domains-geo.js";
import { downloadStructuredJson, filteredSourceCoverageRecords, loadSourceCoverage, loadSourceJson, renderSourceCoverage } from "./80-sources.js";
import { loadChronologyPanel, loadInsightsPanel, loadLexiconPanel, loadLongevityPanel, loadSectionGraphPanel } from "./90-intel-panels.js";
import { tabLoaded } from "./60-alerts.js";
import { closeAllOverlays } from "./40-overlays.js";
import { appState } from "../app-state.js";
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
      stats: loadAnalytics,
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
      // Compare/history load through their own explicit buttons.
    };

    function initTabbedOverlay(overlayId) {
      const overlay = document.getElementById(overlayId);
      const tabs = [...overlay.querySelectorAll('.intel-tab')];
      overlay.querySelector('.intel-tabs').setAttribute('role', 'tablist');
      for (const tab of tabs) { const panel = document.getElementById('intel-' + tab.dataset.tab); tab.id ||= 'tab-' + tab.dataset.tab; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id); tab.setAttribute('aria-selected', String(tab.classList.contains('active'))); tab.tabIndex = tab.classList.contains('active') ? 0 : -1; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.inert = !tab.classList.contains('active'); }
      overlay.querySelector('.intel-tabs').addEventListener('keydown', event => { const current = tabs.indexOf(event.target); if (current < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; tabs[index].click(); tabs[index].focus(); });
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          overlay.querySelectorAll('.intel-panel.active').forEach(panel => cancelReaderTasks(panel));
          tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); t.tabIndex = -1; });
          overlay.querySelectorAll('.intel-panel').forEach(p => { p.classList.remove('active'); p.inert = true; });
          tab.classList.add('active'); tab.tabIndex = 0; tab.setAttribute('aria-selected', 'true'); announce(tab.textContent.trim() + ' selected.');
          const tabName = tab.dataset.tab;
          document.getElementById('intel-' + tabName).classList.add('active'); document.getElementById('intel-' + tabName).inert = false;
          if (TAB_LOADERS[tabName]) {
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
      appState.sourceSelectedId = button.dataset.sourceId;
      renderSourceCoverage();
    });
    document.getElementById('source-download').addEventListener('click', () => {
      if (appState.sourceCoverageData) downloadStructuredJson('crescent-city-source-coverage.json', { ...appState.sourceCoverageData, filteredSources: filteredSourceCoverageRecords() });
    });
    document.getElementById('source-json-download').addEventListener('click', () => {
      if (appState.sourceCoverageData) downloadStructuredJson('crescent-city-source-envelope.json', appState.sourceCoverageData);
    });
    document.getElementById('source-json-copy').addEventListener('click', async event => {
      const button = event.currentTarget;
      if (!appState.sourceCoverageData) await loadSourceJson();
      if (!appState.sourceCoverageData) return;
      const status = document.getElementById('source-json-state');
      try {
        if (!navigator.clipboard?.writeText) throw new Error('unavailable');
        await navigator.clipboard.writeText(JSON.stringify(appState.sourceCoverageData, null, 2));
        button.textContent = 'Copied'; status.textContent = 'Structured source envelope copied.';
      } catch { status.textContent = 'The browser could not copy the source envelope. Use Download JSON.'; announce(status.textContent); }
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

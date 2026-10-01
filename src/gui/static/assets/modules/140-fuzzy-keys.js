import { searchInput } from "./10-core.js";
import { closeAllOverlays } from "./40-overlays.js";
// Keyboard shortcuts; fuzzy suggestions use the latest-search envelope in 30-search.
    // ─ Keyboard Shortcuts ─
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '/') { e.preventDefault(); searchInput.focus(); }
      if (e.key === 'i' && e.ctrlKey) { e.preventDefault(); document.getElementById('feeds-toggle').click(); }
      if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); document.getElementById('alerts-toggle').click(); }
    });

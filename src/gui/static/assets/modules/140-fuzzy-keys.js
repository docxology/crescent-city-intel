// 140-fuzzy-keys.js — fuzzy search suggestions and keyboard shortcuts.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // ─ Fuzzy Search Suggestions ─
    let fuzzyTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(fuzzyTimer);
      const q = searchInput.value.trim();
      if (q.length < 3) return;
      fuzzyTimer = setTimeout(async () => {
        // Only fetch fuzzy if search results are empty
        const results = searchResults.children;
        if (results.length === 0) {
          try {
            const data = await apiFetch(`/api/fuzzy?q=${encodeURIComponent(q)}`).then(r => r.json());
            if (data.corrections?.length > 0) {
              let html = '<div class="fuzzy-suggestions">Did you mean: ';
              for (const c of data.corrections) { html += `<span class="fuzzy-suggestion" data-suggestion="${c.suggestion}">${c.suggestion}</span> `; }
              html += '?</div>';
              searchResults.innerHTML = html;
              searchResults.querySelectorAll('.fuzzy-suggestion').forEach(s => {
                s.addEventListener('click', () => { searchInput.value = s.dataset.suggestion; searchInput.dispatchEvent(new Event('input')); });
              });
            }
          } catch { /* non-fatal */ }
        }
      }, 300);
    });

    // ─ Keyboard Shortcuts ─
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '/') { e.preventDefault(); searchInput.focus(); }
      if (e.key === 'Escape') { closeAllOverlays(); }
      if (e.key === 'i' && e.ctrlKey) { e.preventDefault(); document.getElementById('feeds-toggle').click(); }
      if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); document.getElementById('alerts-toggle').click(); }
    });

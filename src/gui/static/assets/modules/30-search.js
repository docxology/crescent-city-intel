// 30-search.js — header search wiring.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // Search
    let searchTimeout = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      const q = searchInput.value.trim();
      if (!q) {
        searchResults.style.display = "none";
        return;
      }
      searchTimeout = setTimeout(async () => {
        try {
          const resp = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
          const data = await resp.json();
          if (data.results.length === 0) {
            destroySearchVirtualList();
            searchResults.innerHTML = '<div class="search-result">No results found</div>';
          } else {
            renderSearchResults(data.results);
          }
          searchResults.style.display = "block";
        } catch { }
      }, 250);
    });

    // Windowed rendering for the results dropdown (virtual-list.js): sets
    // beyond SEARCH_VIRTUAL_THRESHOLD render through createVirtualList with
    // byte-identical per-item markup; smaller sets keep the legacy innerHTML
    // path. Click delegation below is unaffected (items remain descendants
    // of #search-results).
    let searchVirtualList = null;
    function destroySearchVirtualList() {
      if (searchVirtualList) { searchVirtualList.destroy(); searchVirtualList = null; }
    }
    function renderSearchResults(results) {
      if (results.length <= SEARCH_VIRTUAL_THRESHOLD) {
        destroySearchVirtualList();
        searchResults.innerHTML = results.map(r => `
          <div class="search-result" data-guid="${r.section.guid}" data-article-guid="${r.section.articleGuid}">
            <div class="sr-number">${escapeHtml(r.section.number)}</div>
            <div class="sr-title">${escapeHtml(r.section.title)}</div>
            <div class="sr-snippet">${escapeHtml(r.snippet)}</div>
          </div>
        `).join("");
        return;
      }
      if (!searchVirtualList) {
        searchVirtualList = createVirtualList({
          container: searchResults,
          renderItem: (r) => `
            <div class="search-result" data-guid="${r.section.guid}" data-article-guid="${r.section.articleGuid}">
              <div class="sr-number">${escapeHtml(r.section.number)}</div>
              <div class="sr-title">${escapeHtml(r.section.title)}</div>
              <div class="sr-snippet">${escapeHtml(r.snippet)}</div>
            </div>
          `,
        });
      }
      searchVirtualList.setItems(results);
    }

    searchResults.addEventListener("click", (e) => {
      const result = e.target.closest(".search-result");
      if (!result) return;
      const guid = result.dataset.guid;
      const articleGuid = result.dataset.articleGuid;
      if (guid) loadSection(guid, null);
      searchResults.style.display = "none";
      searchInput.value = "";
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#search-container")) {
        searchResults.style.display = "none";
      }
    });

import { apiFetch, loadSection, searchInput, searchResults } from "./10-core.js";
import { CCGui } from "../gui-runtime.js";
import { SEARCH_VIRTUAL_THRESHOLD, createVirtualList } from "../virtual-list.js";
// Search controller depends on CCGui request/render primitives and core DOM refs.
let searchTimeout = null, searchController = null, searchSequence = 0;
let searchVirtualList = null;
function destroySearchVirtualList() { searchVirtualList?.destroy(); searchVirtualList = null; }
function hideSearch() {
  searchSequence++; clearTimeout(searchTimeout); searchController?.abort();
  searchResults.style.display = "none"; searchInput.setAttribute("aria-expanded", "false");
}
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout); searchController?.abort();
  const sequence = ++searchSequence, q = searchInput.value.trim();
  if (!q) { hideSearch(); destroySearchVirtualList(); searchResults.replaceChildren(); return; }
  searchTimeout = setTimeout(async () => {
    const controller = new AbortController(); searchController = controller;
    try {
      const response = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`, { signal: controller.signal });
      if (!response.ok) throw new Error("Search unavailable");
      const data = await response.json();
      if (sequence !== searchSequence || searchInput.value.trim() !== q) return;
      renderSearchResults(Array.isArray(data.results) ? data.results : [], Array.isArray(data.fuzzyCorrections) ? data.fuzzyCorrections : []);
      const status = document.getElementById("search-status");
      if (status) status.textContent = `${data.results?.length ?? 0} matching sections`;
      searchResults.style.display = "block"; searchInput.setAttribute("aria-expanded", "true");
    } catch (error) {
      if (sequence !== searchSequence || controller.signal.aborted) return;
      searchResults.textContent = "Search is unavailable. Please retry.";
      searchResults.style.display = "block";
    } finally { if (searchController === controller) searchController = null; }
  }, 250);
});
function renderSearchResults(results, corrections = []) {
  const item = r => `<button type="button" class="search-result" data-guid="${CCGui.escape(r.section.guid)}" data-article-guid="${CCGui.escape(r.section.articleGuid)}"><span class="sr-number">${CCGui.escape(r.section.number)}</span><span class="sr-title">${CCGui.escape(r.section.title)}</span><span class="sr-snippet">${CCGui.escape(r.snippet)}</span></button>`;
  if (results.length <= SEARCH_VIRTUAL_THRESHOLD) {
    destroySearchVirtualList();
    CCGui.render(searchResults, results.length ? results.map(item).join("") : '<p class="search-result">No matching sections found. Try fewer words, or a section number like 12.04.</p>' + corrections.filter(row => typeof row.suggestion === "string" && row.suggestion.length <= 200).slice(0, 5).map(row => `<button type="button" class="search-result" data-suggestion="${CCGui.escape(row.suggestion)}">Try ${CCGui.escape(row.suggestion)}</button>`).join(""));
  } else {
    if (!searchVirtualList) searchVirtualList = createVirtualList({ container: searchResults, renderItem: item });
    searchVirtualList.setItems(results);
  }
}
searchResults.addEventListener("click", event => {
  const suggestion = event.target.closest("button[data-suggestion]");
  if (suggestion) { searchInput.value = suggestion.dataset.suggestion; searchInput.dispatchEvent(new Event("input", { bubbles: true })); searchInput.focus(); return; }
  const result = event.target.closest("button[data-guid]");
  if (!result) return;
  loadSection(result.dataset.guid, null); hideSearch(); searchInput.value = "";
  document.getElementById("content").setAttribute("tabindex", "-1"); document.getElementById("content").focus();
});
function searchKeys(event) {
  const buttons = [...searchResults.querySelectorAll("button[data-guid], button[data-suggestion]")];
  if (event.key === "Escape") { hideSearch(); searchInput.focus(); }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && buttons.length) {
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement), direction = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + direction + buttons.length) % buttons.length].focus();
  }
}
searchInput.addEventListener("keydown", searchKeys); searchResults.addEventListener("keydown", searchKeys);
document.addEventListener("click", event => { if (!event.target.closest("#search-container")) hideSearch(); });
window.addEventListener("pagehide", hideSearch);

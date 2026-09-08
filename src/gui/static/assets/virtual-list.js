// virtual-list.js — windowed list renderer for the Quadruplicate SPA (v2.7.0).
//
// The SPA has no build step and several panels render long flat lists. This
// module windows rendering to the visible slice plus `overscan` items above
// and below it: only the window's items exist in the DOM at any time, while
// fixed-height spacer elements preserve the scroll extent above and below.
// A ResizeObserver on the scroll container and a scroll listener re-render
// the window on scroll and size changes.
//
// Applications (v2.7.0), chosen as the SPA's longest safely-windowable flat
// list renderers:
// - Search results (#search-results): result sets larger than
//   SEARCH_VIRTUAL_THRESHOLD (24) render through this module; smaller sets
//   keep the exact legacy innerHTML path. Per-item markup (.search-result
//   with data-guid / data-article-guid and .sr-number/.sr-title/.sr-snippet
//   children) is byte-identical to the legacy template, so the first
//   rendered window is observably the same as the unwindowed list. Click
//   delegation on the container keeps working (items are still descendants).
// - Glossary (#glossary-content): definition tables with more than
//   GLOSSARY_VIRTUAL_THRESHOLD (40) rows window their <tbody> rows (table
//   mode). Row markup is unchanged; fixed-height spacer <tr> elements are
//   added around the window.
// - The recursive TOC tree is deliberately NOT windowed: it is a nested
//   collapsible structure whose children must exist in the DOM for
//   expand/collapse, so windowing would break item identity. /api/search
//   caps results at 20; the glossary (capped at 200 rows) is the longest
//   flat list in the SPA.
//
// Row height: callers pass a nominal fixed `rowHeight`. After each window
// render the module measures the tallest rendered item and grows the fixed
// row height to fit, so variable-height rows never overlap; the height is
// never shrunk, keeping spacer math stable while scrolling.

const VIRTUAL_LIST_DEFAULT_ROW_HEIGHT = 48;
const SEARCH_VIRTUAL_THRESHOLD = 24;
const GLOSSARY_VIRTUAL_THRESHOLD = 40;

function createVirtualList(options) {
  const scrollEl = options.container;
  const rowHost = options.rowHost || options.container;
  const renderItem = options.renderItem;
  const mode = options.mode === "table" ? "table" : "div";
  const isTable = mode === "table";
  const overscan = typeof options.overscan === "number" && options.overscan >= 0 ? options.overscan : 5;
  let rowHeight = typeof options.rowHeight === "number" && options.rowHeight > 0
    ? options.rowHeight
    : VIRTUAL_LIST_DEFAULT_ROW_HEIGHT;
  let items = [];
  let windowStart = 0;
  let windowEnd = 0;
  let frame = null;
  let destroyed = false;

  function spacerHeightTd(height) {
    return '<td colspan="4" style="height:' + height + 'px;padding:0;border:0"></td>';
  }

  function applySpacers() {
    const top = windowStart * rowHeight;
    const bottom = Math.max(0, (items.length - windowEnd) * rowHeight);
    if (isTable) {
      rowHost.firstElementChild.innerHTML = spacerHeightTd(top);
      rowHost.lastElementChild.innerHTML = spacerHeightTd(bottom);
    } else {
      rowHost.firstElementChild.style.height = top + "px";
      rowHost.lastElementChild.style.height = bottom + "px";
    }
  }

  function renderWindow() {
    if (destroyed || items.length === 0) return;
    const viewTop = Math.max(0, scrollEl.scrollTop);
    const viewH = scrollEl.clientHeight || 1;
    let start = Math.floor(viewTop / rowHeight) - overscan;
    start = Math.max(0, Math.min(start, items.length - 1));
    let end = Math.ceil((viewTop + viewH) / rowHeight) + overscan;
    end = Math.min(items.length, Math.max(end, start + 1));
    windowStart = start;
    windowEnd = end;
    const fragment = document.createDocumentFragment();
    if (!isTable) fragment.appendChild(rowHost.firstElementChild); // top spacer
    const host = isTable ? null : rowHost.children[1];
    const parts = [];
    for (let i = start; i < end; i++) parts.push(renderItem(items[i], i));
    if (isTable) {
      // tbody layout: [top spacer tr][window rows…][bottom spacer tr]
      const keep = [rowHost.firstElementChild, rowHost.lastElementChild];
      for (const row of Array.from(rowHost.children)) {
        if (!keep.includes(row)) rowHost.removeChild(row);
      }
      for (const html of parts) {
        const tr = document.createElement("tr");
        tr.setAttribute("data-virtual-row", "");
        tr.innerHTML = html;
        rowHost.insertBefore(tr, rowHost.lastElementChild);
      }
    } else {
      host.innerHTML = parts.join("");
    }
    applySpacers();
    growRowHeight();
  }

  function growRowHeight() {
    let maxH = 0;
    const rendered = isTable
      ? rowHost.querySelectorAll("tr[data-virtual-row]")
      : rowHost.children[1].children;
    for (const el of rendered) {
      maxH = Math.max(maxH, el.getBoundingClientRect().height);
    }
    if (maxH > rowHeight) {
      rowHeight = Math.ceil(maxH);
      applySpacers();
    }
  }

  function scheduleRender() {
    if (frame !== null || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      renderWindow();
    });
  }

  function setItems(nextItems) {
    items = Array.isArray(nextItems) ? nextItems : [];
    if (isTable) {
      rowHost.innerHTML = "";
      const top = document.createElement("tr");
      const bottom = document.createElement("tr");
      top.innerHTML = spacerHeightTd(0);
      bottom.innerHTML = spacerHeightTd(0);
      rowHost.appendChild(top);
      rowHost.appendChild(bottom);
    } else {
      rowHost.innerHTML = "";
      const top = document.createElement("div");
      const win = document.createElement("div");
      const bottom = document.createElement("div");
      top.style.height = "0px";
      bottom.style.height = "0px";
      win.className = "virtual-list-window";
      rowHost.appendChild(top);
      rowHost.appendChild(win);
      rowHost.appendChild(bottom);
    }
    scrollEl.scrollTop = 0;
    renderWindow();
  }

  function destroy() {
    destroyed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    scrollEl.removeEventListener("scroll", scheduleRender);
    if (resizeObserver && resizeObserver.observe) resizeObserver.disconnect();
  }

  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(scheduleRender);
    resizeObserver.observe(scrollEl);
  }
  scrollEl.addEventListener("scroll", scheduleRender, { passive: true });

  return {
    setItems,
    destroy,
    get rowCount() { return items.length; },
    get rowHeight() { return rowHeight; },
  };
}

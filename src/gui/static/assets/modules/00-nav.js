// 00-nav.js — navigation layer for the Quadruplicate SPA (v2.7.0).
//
// Loaded FIRST (after the CDN tags), before every extracted module. This
// layer is purely additive: it never removes or overrides an existing click
// handler, and it only ever *invokes* the existing toggle buttons and
// .intel-tab activators — the programmatic .click() calls in the browser
// smoke (scripts/browser-smoke.ts) keep working unchanged.
//
// Provides:
// (a) Hash deep-links: #<section> opens a top-level section,
//     #<section>/<tab-name> additionally activates an intel tab (e.g.
//     #analytics/readability, #feeds/insights). Applied on load and on
//     hashchange. Unknown/legacy hashes are left untouched. The active tab
//     button gets aria-current="true" (cleared from its siblings).
// (b) A "Go to…" jump <select> in the header (#nav-jump), grouped into
//     <optgroup>s per section, which navigates by setting location.hash.
// (c) Keyboard: Alt+ArrowRight / Alt+ArrowLeft cycle tabs within the
//     currently visible tabbed overlay.
//
// Section state is derived from the DOM, so adding an intel tab to an
// overlay in markup is picked up automatically.

(function () {
  "use strict";

  const SECTIONS = [
    { id: "code", toggleId: "code-toggle", label: "\uD83D\uDCD6 Code", overlayId: null },
    { id: "analytics", toggleId: "analytics-toggle", label: "\uD83D\uDCCA Code Analytics", overlayId: "analytics-overlay" },
    { id: "feeds", toggleId: "feeds-toggle", label: "\uD83D\uDCF0 News & Feeds", overlayId: "feeds-overlay" },
    { id: "sources", toggleId: "sources-toggle", label: "\uD83E\uDDED Sources", overlayId: "sources-overlay" },
    { id: "alerts", toggleId: "alerts-toggle", label: "\uD83D\uDEA8 Alerts", panelId: "alerts-panel" },
    { id: "chat", toggleId: "chat-toggle", label: "\uD83D\uDCAC Chat", panelId: "chat-panel" },
    { id: "dev", toggleId: "dev-toggle", label: "\uD83D\uDD0C Developer", overlayId: "dev-overlay" },
  ];

  let applyingHash = false;

  function sectionIsOpen(section) {
    if (section.id === "code") {
      return SECTIONS.every(s => !s.overlayId || !document.getElementById(s.overlayId)?.classList.contains("open"));
    }
    if (section.overlayId) return Boolean(document.getElementById(section.overlayId)?.classList.contains("open"));
    if (section.panelId === "alerts-panel") return document.getElementById("alerts-panel")?.style.display !== "none";
    if (section.panelId === "chat-panel") return Boolean(document.getElementById("chat-panel")?.classList.contains("open"));
    return false;
  }

  function sectionTabs(section) {
    if (!section.overlayId) return [];
    return [...(document.getElementById(section.overlayId)?.querySelectorAll(".intel-tab") || [])];
  }

  function setActiveTabMarker(section, activeTab) {
    for (const tab of sectionTabs(section)) {
      if (tab === activeTab) tab.setAttribute("aria-current", "true");
      else tab.removeAttribute("aria-current");
    }
  }

  function applyHash() {
    const raw = decodeURIComponent((window.location.hash || "").replace(/^#/, ""));
    if (!raw) return;
    const [sectionId, tabName] = raw.split("/");
    const section = SECTIONS.find(s => s.id === sectionId);
    if (!section) return; // unknown or legacy hash: leave the page unchanged
    applyingHash = true;
    try {
      if (section.id !== "code" && !sectionIsOpen(section)) {
        document.getElementById(section.toggleId)?.click();
      } else if (section.id === "code") {
        document.getElementById(section.toggleId)?.click();
      }
      if (tabName && section.overlayId) {
        const tab = sectionTabs(section).find(t => t.dataset.tab === tabName);
        if (tab) {
          if (!tab.classList.contains("active")) tab.click();
          setActiveTabMarker(section, tab);
        }
      }
    } finally {
      applyingHash = false;
    }
  }

  window.addEventListener("hashchange", applyHash);

  // NOTE: button-click → hash sync is intentionally omitted. Deep-links and
  // the "Go to…" select are the navigation mechanism; mirroring button
  // clicks into the hash would race deep-link activation (a toggle click
  // overwrites #analytics/readability with #analytics, dropping the tab).

  // ── "Go to…" jump menu ────────────────────────────────────────────────
  function buildJumpSelect() {
    const select = document.getElementById("nav-jump");
    if (!select) return;
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Go to\u2026";
    select.appendChild(placeholder);
    for (const section of SECTIONS) {
      const group = document.createElement("optgroup");
      group.label = section.label;
      const overview = document.createElement("option");
      overview.value = "#" + section.id;
      overview.textContent = section.overlayId || section.panelId ? section.label + " \u2014 overview" : section.label;
      group.appendChild(overview);
      for (const tab of sectionTabs(section)) {
        const opt = document.createElement("option");
        opt.value = "#" + section.id + "/" + tab.dataset.tab;
        opt.textContent = (tab.textContent || tab.dataset.tab).trim();
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  }
  buildJumpSelect();
  document.getElementById("nav-jump")?.addEventListener("change", (event) => {
    const value = event.target.value;
    event.target.value = "";
    if (!value) return;
    if (window.location.hash === value) applyHash();
    else window.location.hash = value;
  });

  // ── Alt+Arrow tab cycling within the visible overlay ──────────────────
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    const openSection = SECTIONS.find(s => s.overlayId && document.getElementById(s.overlayId)?.classList.contains("open"));
    if (!openSection) return;
    const tabs = sectionTabs(openSection);
    if (tabs.length < 2) return;
    const current = tabs.findIndex(t => t.classList.contains("active"));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[((current < 0 ? 0 : current) + delta + tabs.length) % tabs.length];
    next.click();
    setActiveTabMarker(openSection, next);
    event.preventDefault();
  });

  // Deep-link on first load (script runs after the DOM is fully parsed).
  applyHash();
})();

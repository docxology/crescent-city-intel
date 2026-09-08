// 40-overlays.js — theme persistence, top-level nav toggles, closeAllOverlays, welcome linktree wiring.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // Theme toggle (with localStorage persistence)
    (function initTheme() {
      const saved = localStorage.getItem("theme");
      if (saved === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        document.getElementById("theme-toggle").textContent = "Light";
      }
    })();
    document.getElementById("theme-toggle").addEventListener("click", () => {
      const html = document.documentElement;
      const isDark = html.getAttribute("data-theme") === "dark";
      const next = isDark ? "light" : "dark";
      html.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      document.getElementById("theme-toggle").textContent = isDark ? "Dark" : "Light";
    });

    // ─── Top-level nav: exactly one of Code / Code Analytics / News & Feeds /
    // Alerts / Chat / Developer is ever open at a time. closeAllOverlays()
    // is the single source of truth for "return to the code view" — every
    // toggle button calls it first, so opening one always closes the rest
    // (previously only the old Intelligence tab did this, asymmetrically:
    // opening Analytics or Alerts left Intelligence open behind them).
    const OVERLAY_TOGGLE_IDS = ['analytics-toggle', 'feeds-toggle', 'sources-toggle', 'alerts-toggle', 'chat-toggle', 'dev-toggle'];
    function closeAllOverlays() {
      document.getElementById('analytics-overlay').classList.remove('open');
      document.getElementById('feeds-overlay').classList.remove('open');
      document.getElementById('sources-overlay').classList.remove('open');
      document.getElementById('dev-overlay').classList.remove('open');
      document.getElementById('alerts-panel').style.display = 'none';
      chatPanel.classList.remove('open');
      OVERLAY_TOGGLE_IDS.forEach(id => document.getElementById(id).classList.remove('active'));
    }
    document.getElementById('code-toggle').addEventListener('click', closeAllOverlays);
    document.querySelectorAll('[data-welcome-target]').forEach(link => {
      link.addEventListener('click', () => {
        const target = link.dataset.welcomeTarget;
        if (target === 'report') {
          document.getElementById('feeds-toggle').click();
          setTimeout(() => document.querySelector('#feeds-overlay .intel-tab[data-tab="report"]')?.click(), 0);
          return;
        }
        document.getElementById(target)?.click();
      });
    });

    // Chat toggle
    let chatModelsLoaded = false;
    document.getElementById("chat-toggle").addEventListener("click", () => {
      const wasOpen = chatPanel.classList.contains("open");
      closeAllOverlays();
      if (!wasOpen) {
        chatPanel.classList.add("open");
        document.getElementById("chat-toggle").classList.add("active");
        // Discovery is lazy: no cost until someone actually opens chat.
        if (!chatModelsLoaded) { chatModelsLoaded = true; loadChatModels(); }
      }
    });
    document.getElementById("chat-close").addEventListener("click", () => {
      activeChatController?.abort();
      chatPanel.classList.remove("open");
      document.getElementById("chat-toggle").classList.remove("active");
    });
    chatCancel.addEventListener("click", () => activeChatController?.abort());

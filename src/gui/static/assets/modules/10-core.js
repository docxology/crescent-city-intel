// 10-core.js — core bootstrap: apiFetch wrapper, error banner, state, DOM refs, TOC, stats, welcome, section viewer.
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.
    // Wraps the native fetch() so every same-origin API call carries the key
    // the server injected into this page (see server.ts serveIndexHtml()).
    // Falls back to a bare fetch if the placeholder was never substituted
    // (e.g. this file opened directly from disk rather than via the server).
    function showErrorBanner(msg) {
      const banner = document.getElementById("error-banner");
      if (!banner) return;
      banner.textContent = msg;
      banner.style.display = "block";
      clearTimeout(window.__errorBannerTimer);
      window.__errorBannerTimer = setTimeout(() => { banner.style.display = "none"; }, 8000);
    }

    function apiFetch(url, opts) {
      const key = window.__CC_API_KEY__;
      const hasKey = key && !key.startsWith("__CC_API_KEY");
      const doFetch = hasKey
        ? (() => { const merged = Object.assign({}, opts); merged.headers = Object.assign({ "X-API-Key": key }, opts && opts.headers); return fetch(url, merged); })()
        : fetch(url, opts || {});
      // Surface genuine network/unreachable failures at the top of the page so a
      // dead server is never mistaken for an empty result; per-route 4xx/5xx
      // handling (inline error text) is preserved by rethrowing.
      return doFetch.catch((err) => {
        showErrorBanner("Network error reaching the server: " + (err && err.message ? err.message : "request failed"));
        throw err;
      });
    }

    // State
    let tocData = null;
    let activeGuid = null;
    let sourceCoverageData = null;
    let sourceCoverageRecords = [];
    let sourceSelectedId = null;
    const summaryCache = new Map(); // guid → { summary, model }

    // DOM refs
    const tocTree = document.getElementById("toc-tree");
    const content = document.getElementById("content");
    const searchInput = document.getElementById("search-input");
    const searchResults = document.getElementById("search-results");
    const chatPanel = document.getElementById("chat-panel");
    const chatMessages = document.getElementById("chat-messages");
    const chatHistory = []; // multi-turn context sent with each chat request (bounded server-side)
    const chatInput = document.getElementById("chat-input");
    const chatCancel = document.getElementById("chat-cancel");
    let activeChatController = null;

    // Init
    async function init() {
      await loadToc();
      await loadStats();
    }

    async function loadToc() {
      try {
        const resp = await apiFetch("/api/toc");
        tocData = await resp.json();
        renderToc(tocData, tocTree, 0);
      } catch (e) {
        tocTree.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">Failed to load TOC. Run the scraper first.</div>';
      }
    }

    async function loadStats() {
      try {
        const resp = await apiFetch("/api/stats");
        const stats = await resp.json();
        document.getElementById("stat-articles").textContent = `Articles: ${stats.articleCount}`;
        document.getElementById("stat-sections").textContent = `Sections: ${stats.sectionCount}`;
        document.getElementById("stat-toc").textContent = `TOC nodes: ${stats.tocNodeCount}`;
        // Populate welcome cards
        const wa = document.getElementById("welcome-articles");
        const ws = document.getElementById("welcome-sections");
        const wn = document.getElementById("welcome-nodes");
        if (wa) wa.textContent = stats.articleCount;
        if (ws) ws.textContent = stats.sectionCount;
        if (wn) wn.textContent = stats.tocNodeCount;

        // Staleness detection — show warning banner if manifest >30 days old
        try {
          const healthResp = await apiFetch("/api/health");
          const health = await healthResp.json();
          const sourceRows = [health.newsSources, health.meetingsSources, health.youtubeSources, health.triplicateSources, health.alertSources].flatMap(rows => Array.isArray(rows) ? rows : []);
          const welcomeStatus = document.getElementById("welcome-status");
          const missingSources = sourceRows.filter(source => source.status === "unavailable" || source.status === "stale").length;
          const presentSources = sourceRows.length - missingSources;
          if (welcomeStatus) welcomeStatus.textContent = `${health.status === "ok" ? "Workspace operational" : "Workspace attention required"} · ${presentSources}/${sourceRows.length} source checks present (${missingSources} unavailable/stale) · chat ${health.chatProvider || "unknown"} · alerts ${health.alertLevel || "CALM"}`;
          if (health.manifest?.stale) {
            const banner = document.createElement("div");
            banner.style.cssText = "padding:0.5rem 1rem; background:#f59e0b22; border-bottom:1px solid #f59e0b; color:#f59e0b; font-size:0.9rem;";
            banner.textContent = `⚠️ Data is ${health.manifest.ageDays} days old (scraped ${health.manifest.completedAt.substring(0,10)}). Run \`bun run scrape\` to refresh.`;
            document.body.insertBefore(banner, document.getElementById("header"));
          }
          if (health.alertLevel && health.alertLevel !== "CALM") {
            const alertColors = { WATCH: "#eab308", WARNING: "#f97316", EMERGENCY: "#ef4444" };
            const alertBanner = document.createElement("div");
            alertBanner.style.cssText = `padding:0.5rem 1rem; background:${alertColors[health.alertLevel] || "#888"}22; border-bottom:1px solid ${alertColors[health.alertLevel] || "#888"}; color:${alertColors[health.alertLevel] || "#888"}; font-size:0.9rem;`;
            alertBanner.textContent = `🚨 Active alert level: ${health.alertLevel}`;
            document.body.insertBefore(alertBanner, document.getElementById("header"));
          }
          // --header-height was a fixed 56px constant that only fit the nav
          // row itself. Either banner above pushes the real header down,
          // but every overlay/panel positions itself at `top: var(--header-height)`
          // — with the old fixed value, an open banner made overlays cover
          // the bottom of the header (nav buttons became unclickable while
          // an overlay was open and a banner was showing). Recompute it from
          // the header's actual rendered position so overlays always start
          // exactly below whatever's really on screen above them.
          const headerEl = document.getElementById("header");
          document.documentElement.style.setProperty("--header-height", headerEl.getBoundingClientRect().bottom + "px");
        } catch { /* non-fatal */ }
        loadWelcomeAnalytics();
      } catch { }
    }

    async function loadWelcomeAnalytics() {
      const target = document.getElementById('welcome-analytics');
      if (!target) return;
      try {
        const response = await apiFetch('/api/analytics/overview');
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const overview = await response.json();
        const signals = Array.isArray(overview.signals) ? overview.signals.slice(0, 4) : [];
        target.innerHTML = `<strong>${escapeHtml(overview.headline || 'Current analytical signal')}</strong><div style="margin-top:6px">${escapeHtml(overview.summary || '')}</div><div style="margin-top:8px;font-size:11px;color:var(--text-secondary)">${escapeHtml(overview.llm?.status === 'ok' ? `LLM summary · ${overview.llm.provider}/${overview.llm.model}` : `Deterministic summary · LLM ${overview.llm?.status || 'not recorded'}`)} · evidence ${escapeHtml(String(overview.inputFingerprint || '').slice(0, 16))}…</div>${signals.length ? `<ul style="margin:10px 0 0 18px">${signals.map(signal => `<li><strong>${escapeHtml(signal.title)}</strong> — ${escapeHtml(signal.detail)}</li>`).join('')}</ul>` : ''}`;
      } catch (error) {
        target.innerHTML = `<strong>Analytical overview unavailable.</strong><div style="margin-top:6px;color:var(--text-secondary)">${escapeHtml(error.message || error)}</div>`;
      }
    }

    function renderToc(node, container, depth) {
      if (!node) return;
      const hasChildren = node.children && node.children.length > 0;
      const isSection = node.type === "section";

      const div = document.createElement("div");
      div.className = "toc-node";

      const label = document.createElement("div");
      label.className = "toc-label";
      label.style.paddingLeft = (depth * 4 + 8) + "px";

      if (hasChildren && !isSection) {
        const toggle = document.createElement("span");
        toggle.className = "toc-toggle";
        toggle.textContent = "\u25B6";
        label.appendChild(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "toc-toggle";
        label.appendChild(spacer);
      }

      const typeSpan = document.createElement("span");
      typeSpan.className = "toc-type";
      if (depth > 0 && !isSection) {
        typeSpan.textContent = node.type === "article" ? "art" :
          node.type === "chapter" ? "ch" :
            node.type === "division" ? "div" :
              node.type === "part" ? "pt" :
                node.type === "subarticle" ? "sub" : "";
      }
      label.appendChild(typeSpan);

      const text = document.createElement("span");
      const displayNum = node.number || node.indexNum || "";
      text.textContent = displayNum ? `${displayNum}: ${node.title}` : node.title;
      label.appendChild(text);

      div.appendChild(label);

      if (hasChildren && !isSection) {
        const childContainer = document.createElement("div");
        childContainer.className = "toc-children";
        for (const child of node.children) {
          renderToc(child, childContainer, depth + 1);
        }
        div.appendChild(childContainer);

        label.addEventListener("click", (e) => {
          const isOpen = childContainer.classList.toggle("open");
          const toggle = label.querySelector(".toc-toggle");
          if (toggle) toggle.textContent = isOpen ? "\u25BC" : "\u25B6";

          // If it's an article, also load its content
          if (node.type === "article" || (node.type === "chapter" && node.children.some(c => c.type === "section"))) {
            loadArticle(node.guid, node);
          }
        });
      }

      if (isSection) {
        label.addEventListener("click", () => {
          loadSection(node.guid, node);
          // Highlight active
          document.querySelectorAll(".toc-label.active").forEach(el => el.classList.remove("active"));
          label.classList.add("active");
        });
      } else if (node.type === "article" || (node.type === "chapter" && !hasChildren)) {
        label.addEventListener("click", () => {
          loadArticle(node.guid, node);
        });
      }

      container.appendChild(div);
    }

    async function loadArticle(guid, node) {
      try {
        const resp = await apiFetch(`/api/article/${guid}`);
        if (!resp.ok) throw new Error("Not found");
        const article = await resp.json();
        activeGuid = guid;

        let html = `<div class="section-header">
          <h2>${article.number ? article.number + ": " : ""}${article.title}</h2>
        </div>`;

        html += '<div class="article-sections">';
        for (const s of article.sections) {
          html += `<div class="article-section" id="section-${s.guid}">
            <h3>${s.number}: ${s.title}</h3>
            <div class="section-text">${escapeHtml(s.text)}</div>
            ${s.history ? `<div class="section-history">${escapeHtml(s.history)}</div>` : ""}
            <button class="summarize-btn" onclick="summarizeSection('${s.guid}', this)" data-number="${escapeHtml(s.number)}" data-title="${escapeHtml(s.title)}">✨ Summarize</button>
            <div id="summary-${s.guid}"></div>
          </div>`;
        }
        html += '</div>';

        content.innerHTML = html;
        content.scrollTop = 0;
      } catch {
        content.innerHTML = '<div class="content-placeholder">Article not found</div>';
      }
    }

    async function loadSection(guid, node) {
      // Show loading skeleton
      content.innerHTML = `
        <div class="content-placeholder">
          <div style="padding:40px 24px;">
            <div style="height:24px;background:var(--bg-secondary);border-radius:6px;margin-bottom:12px;width:60%;animation:pulse 1.5s infinite;"></div>
            <div style="height:16px;background:var(--bg-secondary);border-radius:4px;margin-bottom:8px;width:100%;animation:pulse 1.5s infinite;"></div>
            <div style="height:16px;background:var(--bg-secondary);border-radius:4px;margin-bottom:8px;width:95%;animation:pulse 1.5s infinite;"></div>
            <div style="height:16px;background:var(--bg-secondary);border-radius:4px;margin-bottom:8px;width:98%;animation:pulse 1.5s infinite;"></div>
            <div style="height:16px;background:var(--bg-secondary);border-radius:4px;margin-bottom:8px;width:90%;animation:pulse 1.5s infinite;"></div>
          </div>
        </div>`;
      try {
        const resp = await apiFetch(`/api/section/${guid}`);
        if (!resp.ok) throw new Error("Not found");
        const section = await resp.json();
        activeGuid = guid;

        // Check if bookmarked
        const bookmarks = JSON.parse(localStorage.getItem("cc-bookmarks") || "[]");
        const isBookmarked = bookmarks.some(b => b.guid === guid);

        content.innerHTML = `
          <div class="section-header">
            <div class="article-title">${escapeHtml(section.articleTitle || "")}</div>
            <h2>${section.number}: ${section.title}</h2>
            <div style="display:flex;gap:8px;margin-top:8px;">
              <button class="btn" style="font-size:12px;padding:4px 10px;" onclick="copyPermalink('${guid}')" title="Copy permalink">🔗 Permalink</button>
              <button class="btn" style="font-size:12px;padding:4px 10px;" onclick="toggleBookmark('${guid}', '${escapeHtml(section.number)}', '${escapeHtml(section.title)}')" id="bookmark-btn">${isBookmarked ? '★ Bookmarked' : '☆ Bookmark'}</button>
              <button class="btn" style="font-size:12px;padding:4px 10px;" onclick="exportSection('${guid}')" title="Export as Markdown">📥 Export</button>
              <button class="btn" style="font-size:12px;padding:4px 10px;" onclick="window.print()" title="Print">🖨️ Print</button>
            </div>
          </div>
          <div class="section-body">
            <div class="section-text">${escapeHtml(section.text)}</div>
            ${section.history ? `<div class="section-history">${escapeHtml(section.history)}</div>` : ""}
            <button class="summarize-btn" onclick="summarizeSection('${guid}', this)" data-number="${escapeHtml(section.number)}" data-title="${escapeHtml(section.title)}">✨ Summarize</button>
            <div id="summary-${guid}"></div>
          </div>`;
        content.scrollTop = 0;
      } catch {
        content.innerHTML = '<div class="content-placeholder">Section not found</div>';
      }
    }

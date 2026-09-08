// 70-analytics.js — analytics dashboard, bar charts, PCA, biplot, word loadings, init().
// Extracted verbatim from the former inline <script> block in index.html (v2.7.0 asset
// split). Plain classic script: globals stay implicit (no IIFE, no namespace). Load order
// matches the original single-script execution order.

    async function loadAnalytics() {
      const container = document.getElementById('analytics-content');
      container.innerHTML = '<div class="analytics-loading">⏳ Loading statistics...</div>';

      try {
        const statsResp = await apiFetch('/api/analytics/stats');
        const stats = await statsResp.json();
        if (stats.error) throw new Error(stats.error);

        let html = '';

        // Summary cards
        html += '<div class="analytics-cards">';
        html += card(stats.totalArticles.toLocaleString(), 'Articles');
        html += card(stats.totalSections.toLocaleString(), 'Sections');
        html += card(stats.totalWords.toLocaleString(), 'Total Words');
        html += card(stats.avgWordsPerSection.toLocaleString(), 'Avg Words/Section');
        html += card(stats.titleBreakdown.length, 'Title Groups');
        html += '</div>';

        // Bar charts (sections & words per title)
        html += '<div class="chart-row">';
        html += '<div class="analytics-section"><h3>Sections by Title</h3><div class="chart-container"><canvas id="chart-sections" height="300"></canvas></div></div>';
        html += '<div class="analytics-section"><h3>Word Count by Title</h3><div class="chart-container"><canvas id="chart-words" height="300"></canvas></div></div>';
        html += '</div>';

        // PCA scatter
        html += '<div class="analytics-section"><h3>Embedding Space — PCA Projection</h3>';
        html += '<div class="chart-container pca-wrapper"><canvas id="chart-pca" height="500"></canvas>';
        // PCA Scatter Plot controls
        html += `<div class="pc-controls">
          <div class="pc-selector">
            <label for="pca-x">X Axis:</label>
            <select id="pca-x">${generatePcOptions(0)}</select>
          </div>
          <div class="pc-selector">
            <label for="pca-y">Y Axis:</label>
            <select id="pca-y">${generatePcOptions(1)}</select>
          </div>
          <div class="pc-selector">
            <label for="pca-color">Color by:</label>
            <select id="pca-color">
              <option value="title" selected>Title Group</option>
              <option value="cluster">Cluster (K-Means)</option>
            </select>
          </div>
        </div>`;

        html += '<div id="pca-tooltip"></div></div>';
        html += '<div class="pca-legend" id="pca-legend"></div>';
        html += '<p style="color:var(--text-secondary);font-size:12px;margin-top:8px" id="pca-info">Loading embeddings...</p>';

        // Word loadings selector + container
        html += `<div class="pc-selector" style="margin-top: 32px">
          <label for="loadings-pc">Show loadings for:</label>
          <select id="loadings-pc">${generatePcOptions(0, 10)}</select>
        </div>`;
        html += '<div class="loadings-grid" id="word-loadings-container"></div>';

        // Biplot: words in PC1/PC2 space
        html += '<div class="biplot-container"><h4 style="margin:16px 0 8px;color:var(--accent)">Word Biplot — Terms in PC1/PC2 Space</h4>';
        html += '<div class="chart-container"><canvas id="chart-biplot" height="400"></canvas></div></div>';
        html += '</div>';

        // Top/bottom sections (clickable)
        html += '<div class="analytics-section"><h3>Section Length Extremes</h3><div class="top-sections-grid">';
        html += '<div><h4 style="margin-bottom:8px;color:var(--accent)">🔝 Longest Sections</h4><ul class="top-list">';
        for (const s of stats.longestSections) {
          html += `<li class="section-link" data-guid="${s.guid}"><span><span class="sec-num">${escapeHtml(s.number)}</span>${escapeHtml(s.title)}</span><span class="word-count">${s.words.toLocaleString()} words</span></li>`;
        }
        html += '</ul></div>';
        html += '<div><h4 style="margin-bottom:8px;color:var(--accent)">🔻 Shortest Sections</h4><ul class="top-list">';
        for (const s of stats.shortestSections) {
          html += `<li class="section-link" data-guid="${s.guid}"><span><span class="sec-num">${escapeHtml(s.number)}</span>${escapeHtml(s.title)}</span><span class="word-count">${s.words.toLocaleString()} words</span></li>`;
        }
        html += '</ul></div></div></div>';

        container.innerHTML = html;

        // Attach click handlers for section links
        container.querySelectorAll('.section-link[data-guid]').forEach(el => {
          el.addEventListener('click', () => navigateToSection(el.dataset.guid));
        });

        // Render bar charts
        drawBarChart('chart-sections', stats.titleBreakdown.map(t => t.title), stats.titleBreakdown.map(t => t.sectionCount), 'Sections');
        drawBarChart('chart-words', stats.titleBreakdown.map(t => t.title), stats.titleBreakdown.map(t => t.wordCount), 'Words');

        // Load embeddings in background
        loadPCA();
      } catch (err) {
        container.innerHTML = `<div class="analytics-error">❌ ${err.message}</div>`;
      }
    }

    function card(value, label) {
      return `<div class="analytics-card"><div class="card-value">${value}</div><div class="card-label">${label}</div></div>`;
    }

    /** Close analytics overlay and navigate to a section by guid */
    function navigateToSection(guid) {
      if (!guid) return;
      closeAllOverlays();
      loadSection(guid, null);
    }

    function drawBarChart(canvasId, labels, values, unit) {
      const canvas = document.getElementById(canvasId);
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = 300 * dpr;
      canvas.style.height = '300px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = 300;
      const pad = { top: 20, right: 20, bottom: 80, left: 70 };
      const chartW = w - pad.left - pad.right;
      const chartH = h - pad.top - pad.bottom;
      const max = Math.max(...values, 1);
      const barW = Math.max(chartW / labels.length - 4, 8);

      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      ctx.fillStyle = isDark ? '#e0e0e0' : '#1a1a1a';
      ctx.font = '11px system-ui';

      // Y-axis gridlines
      const yTicks = 5;
      ctx.strokeStyle = isDark ? '#333' : '#ddd';
      ctx.lineWidth = 1;
      for (let i = 0; i <= yTicks; i++) {
        const y = pad.top + chartH - (i / yTicks) * chartH;
        const val = Math.round((i / yTicks) * max);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + chartW, y);
        ctx.stroke();
        ctx.fillText(val.toLocaleString(), 4, y + 4);
      }

      // Bars
      for (let i = 0; i < labels.length; i++) {
        const x = pad.left + (i + 0.5) * (chartW / labels.length) - barW / 2;
        const barH = (values[i] / max) * chartH;
        const y = pad.top + chartH - barH;

        ctx.fillStyle = titleColor(labels[i]);
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
        ctx.fill();

        // Value on top
        ctx.fillStyle = isDark ? '#e0e0e0' : '#1a1a1a';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(values[i].toLocaleString(), x + barW / 2, y - 4);

        // Label
        ctx.save();
        ctx.translate(x + barW / 2, pad.top + chartH + 8);
        ctx.rotate(Math.PI / 4);
        ctx.textAlign = 'left';
        ctx.font = '10px system-ui';
        ctx.fillText(labels[i], 0, 0);
        ctx.restore();
      }
    }

    let pcaPoints = [];
    let _cachedLoadings = null;
    let _cachedVariance = [];

    async function loadPCA() {
      const info = document.getElementById('pca-info');
      try {
        const resp = await apiFetch('/api/analytics/embeddings');
        const data = await resp.json();
        if (data.error) {
          info.textContent = `⚠️ ${data.error}`;
          return;
        }
        if (!data.points || data.points.length === 0) {
          info.textContent = 'No embeddings indexed yet. Run "bun run index" first.';
          return;
        }
        pcaPoints = data.points;
        _cachedVariance = data.variance;
        const xIdx = parseInt(document.getElementById('pca-x')?.value || '0');
        const yIdx = parseInt(document.getElementById('pca-y')?.value || '1');

        const totalVar = _cachedVariance.reduce((a, b) => a + b, 0) || 1;
        info.innerHTML = `${data.totalVectors} vectors • PC${xIdx + 1}: ${((data.variance[xIdx] / totalVar) * 100).toFixed(1)}% var • PC${yIdx + 1}: ${((data.variance[yIdx] / totalVar) * 100).toFixed(1)}% var`;

        drawPCA(xIdx, yIdx);
        buildPCALegend();

        // Render word loadings if available
        const wordLoadings = Array.isArray(data.wordLoadings) ? data.wordLoadings : data.wordLoadings?.data;
        if (wordLoadings && wordLoadings.length > 0) {
          _cachedLoadings = wordLoadings;
          // Initial render with default (PC1)
          renderWordLoadings(null, 0);
          drawBiplot(_cachedLoadings, xIdx, yIdx);

          // Wire up event listeners
          document.getElementById('pca-x')?.addEventListener('change', updateCharts);
          document.getElementById('pca-y')?.addEventListener('change', updateCharts);
          document.getElementById('pca-color')?.addEventListener('change', updateCharts);
          document.getElementById('loadings-pc')?.addEventListener('change', (e) => {
            renderWordLoadings(null, parseInt(e.target.value));
          });
        }
      } catch (err) {
        console.error(err);
        info.textContent = `⚠️ Failed to load embeddings: ${err.message}`;
      }
    }

    function updateCharts() {
      const xIdx = parseInt(document.getElementById('pca-x')?.value || '0');
      const yIdx = parseInt(document.getElementById('pca-y')?.value || '1');
      if (pcaPoints) { // pcaPoints global
        drawPCA(xIdx, yIdx);
        if (_cachedLoadings) drawBiplot(_cachedLoadings, xIdx, yIdx);

        // Update info text
        const info = document.getElementById('pca-info');
        const totalVar = _cachedVariance.reduce((a, b) => a + b, 0) || 1;
        info.innerHTML = `${pcaPoints.length} points • PC${xIdx + 1}: ${((_cachedVariance[xIdx] / totalVar) * 100).toFixed(1)}% var • PC${yIdx + 1}: ${((_cachedVariance[yIdx] / totalVar) * 100).toFixed(1)}% var`;
      }
    }

    function generatePcOptions(selected, count = 10) {
      let html = '';
      for (let i = 0; i < count; i++) {
        html += `<option value="${i}" ${i === selected ? 'selected' : ''}>PC ${i + 1}</option>`;
      }
      return html;
    }



    // Color palette for clusters (6 distinct colors)
    const clusterColors = [
      '#e74c3c', // Red
      '#3498db', // Blue
      '#2ecc71', // Green
      '#9b59b6', // Purple
      '#f1c40f', // Yellow
      '#e67e22', // Orange
    ];

    function titleColor(title) {
      if (document.getElementById('pca-color')?.value === 'cluster') {
        // Use cluster color if available
        // We need to find the point to get its cluster, but here we only have the group name if called from legend
        // Actually, drawPCA handles the point coloring directly.
        // This function is mainly for the legend.
        // If we are coloring by cluster, the legend should show clusters.
        return '#ccc';
      }

      // ... existing title color logic ... (or we could just inline this into drawPCA for points)
      let hash = 0;
      for (let i = 0; i < title.length; i++) {
        hash = title.charCodeAt(i) + ((hash << 5) - hash);
      }
      const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
      return '#' + '00000'.substring(0, 6 - c.length) + c;
    }

    function drawPCA(xIdx, yIdx) {
      const canvas = document.getElementById('chart-pca');
      if (!canvas) return;

      const colorMode = document.getElementById('pca-color')?.value || 'title';

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = 500 * dpr;
      canvas.style.height = '500px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // Clear
      ctx.clearRect(0, 0, rect.width, 500);

      // We need to re-normalize the points for the selected dimensions
      // The stored points have raw projections for PC1..10
      // We need to find min/max for the selected X and Y dimensions
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pcaPoints) {
        const x = p.projections[xIdx];
        const y = p.projections[yIdx];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;

      // Draw points
      for (const p of pcaPoints) {
        // Map raw projection to canvas coords
        const px = ((p.projections[xIdx] - minX) / rangeX) * rect.width;
        const py = ((p.projections[yIdx] - minY) / rangeY) * 500;

        // Flip Y for canvas
        const canvasY = 500 - py;

        if (colorMode === 'cluster' && typeof p.cluster !== 'undefined') {
          ctx.fillStyle = clusterColors[p.cluster % clusterColors.length];
        } else {
          ctx.fillStyle = titleColor(p.titleGroup);
        }

        ctx.beginPath();
        ctx.arc(px, canvasY, 3, 0, Math.PI * 2);
        ctx.fill();

        // Store computed coords for tooltip
        p._cx = px;
        p._cy = canvasY;
      }

      buildPCALegend(); // Rebuild legend based on mode
    }

    function buildPCALegend() {
      const legend = document.getElementById('pca-legend');
      if (!legend) return;

      const colorMode = document.getElementById('pca-color')?.value || 'title';

      if (colorMode === 'cluster') {
        let html = '';
        for (let i = 0; i < clusterColors.length; i++) {
          html += `<span class="pca-legend-item"><span class="pca-legend-swatch" style="background:${clusterColors[i]}"></span>Cluster ${i + 1}</span>`;
        }
        legend.innerHTML = html;
        return;
      }

      const groups = [...new Set(pcaPoints.map(p => p.titleGroup))].sort((a, b) => {
        const an = parseInt(a.replace(/\D/g, ''), 10) || 999;
        const bn = parseInt(b.replace(/\D/g, ''), 10) || 999;
        return an - bn;
      });
      legend.innerHTML = groups.map(g =>
        `<span class="pca-legend-item"><span class="pca-legend-swatch" style="background:${titleColor(g)}"></span>${g}</span>`
      ).join('');
    }

    /** Render horizontal bar charts for word loadings, filtered by PC selection */
    function renderWordLoadings(loadings, pcIndex) {
      const container = document.getElementById('word-loadings-container');
      if (!container) return;
      if (loadings) _cachedLoadings = loadings;
      if (!_cachedLoadings) return;

      if (typeof pcIndex === 'undefined') {
        pcIndex = parseInt(document.getElementById('loadings-pc')?.value || '0');
      }

      // Sort by absolute correlation with the selected PC
      const sorted = [..._cachedLoadings]
        .map(d => ({ word: d.word, val: d.correlations[pcIndex] }))
        .sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
        .slice(0, 15);

      const title = `📊 Top PC${pcIndex + 1} Word Loadings`;
      const maxVal = Math.max(...sorted.map(d => Math.abs(d.val)), 0.01);

      let html = `<div><h4 style="margin:16px 0 8px;color:var(--accent)">${title}</h4>`;
      for (const d of sorted) {
        const val = d.val;
        const pct = (Math.abs(val) / maxVal * 100).toFixed(0);
        const color = val >= 0 ? '#3498db' : '#e74c3c';
        html += `<div class="loading-bar-row">
          <span class="loading-bar-label">${escapeHtml(d.word)}</span>
          <span class="loading-bar-track"><span class="loading-bar-fill" style="width:${pct}%;background:${color}"></span></span>
          <span class="loading-bar-value">${val >= 0 ? '+' : ''}${val.toFixed(3)}</span>
        </div>`;
      }
      html += '</div>';

      container.innerHTML = html;
    }


    /** Draw a biplot: words positioned by their loadings on selected axes */
    function drawBiplot(loadings, xIdx, yIdx) {
      if (!loadings || loadings.length === 0) return;
      const canvas = document.getElementById('chart-biplot');
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = 400 * dpr;
      canvas.style.height = '400px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const width = rect.width;
      const height = 400;

      // Need max loading for normalization (across all PCs or just selected?)
      // Use selected dimensions to scale vectors
      let maxL = 0;
      for (const d of loadings) {
        // correlations are in d.correlations[]
        const x = Math.abs(d.correlations[xIdx]);
        const y = Math.abs(d.correlations[yIdx]);
        if (x > maxL) maxL = x;
        if (y > maxL) maxL = y;
      }
      if (maxL === 0) maxL = 1;

      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillStyle = '#fff';

      // Font size scaling
      const fontSize = Math.max(10, width / 100);
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';

      // We need to map (0,0) in PC space to canvas coordinates.
      // Re-calculate ranges to match drawPCA
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pcaPoints) {
        const x = p.projections[xIdx];
        const y = p.projections[yIdx];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;

      // Origin (0,0) in PC space maps to:
      const originX = ((0 - minX) / rangeX) * rect.width * (window.devicePixelRatio || 1);
      // For Y, drawPCA uses: 500 - py. 
      // py = ((val - minY) / rangeY) * 500
      const originPy = ((0 - minY) / rangeY) * 500 * (window.devicePixelRatio || 1);
      const originY = 500 * (window.devicePixelRatio || 1) - originPy;

      // Currently drawPCA uses fixed height 500. 
      // But canvas.height is 500 * dpr. 
      // My drawPCA logic used:
      // const px = ((p.projections[xIdx] - minX) / rangeX) * rect.width;
      // const py = ((p.projections[yIdx] - minY) / rangeY) * 500;
      // const canvasY = 500 - py; 
      // This logic operates in "CSS pixels" logical space (if rect.width is passed) 
      // BUT ctx.scale(dpr, dpr) was called.
      // So drawing commands should use logical pixels (0..rect.width, 0..500).

      const logicOriginX = ((0 - minX) / rangeX) * rect.width;
      const logicOriginY = 500 - ((0 - minY) / rangeY) * 500;

      // Scale vectors. Use 40% of min dimension as max vector length
      const vectorScale = Math.min(rect.width, 500) * 0.4 / maxL;

      // Draw top 10 words by magnitude on these axes
      const relevant = loadings
        .map(d => ({
          word: d.word,
          x: d.correlations[xIdx],
          y: d.correlations[yIdx],
          mag: Math.hypot(d.correlations[xIdx], d.correlations[yIdx])
        }))
        .sort((a, b) => b.mag - a.mag)
        .slice(0, 10);

      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      ctx.fillStyle = isDark ? '#fff' : '#000';
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)';

      for (const d of relevant) {
        // x direction is right, y direction is UP in PC space.
        // In canvas, y is down. So subtract y component.
        // Wait, logicOriginY is the 0 line.
        // Positive correlation X means to the right.
        // Positive correlation Y means UP (in plot).

        const lx = logicOriginX + d.x * vectorScale;
        const ly = logicOriginY - d.y * vectorScale;

        ctx.beginPath();
        ctx.moveTo(logicOriginX, logicOriginY);
        ctx.lineTo(lx, ly);
        ctx.stroke();

        ctx.fillText(d.word, lx, ly - 5);
      }
      ctx.restore();
    }

    // PCA hover tooltip
    document.addEventListener('mousemove', (e) => {
      const canvas = document.getElementById('chart-pca');
      const tooltip = document.getElementById('pca-tooltip');
      if (!canvas || !tooltip || pcaPoints.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        tooltip.style.display = 'none';
        return;
      }
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      const pad = 40;

      let closest = null;
      let minDist = 20;
      for (const p of pcaPoints) {
        const px = pad + (p.x + 1) / 2 * (w - 2 * pad);
        const py = pad + (1 - (p.y + 1) / 2) * (h - 2 * pad);
        const d = Math.hypot(mx - px, my - py);
        if (d < minDist) { minDist = d; closest = p; }
      }

      if (closest) {
        tooltip.style.display = 'block';
        tooltip.style.left = (mx + 16) + 'px';
        tooltip.style.top = (my - 10) + 'px';
        tooltip.innerHTML = `<strong>${escapeHtml(closest.sectionNumber)}</strong><br>${escapeHtml(closest.sectionTitle)}<br><span style="color:var(--text-secondary);font-size:11px">${escapeHtml(closest.articleTitle)} • ${closest.titleGroup}</span>`;
      } else {
        tooltip.style.display = 'none';
      }
    });

    // Start
    init();

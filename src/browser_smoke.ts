import { chromium } from "playwright";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Real browser smoke test — boots the actual GUI server, drives it with
 * Playwright/Chromium, and asserts the SPA render, the loopback API-key
 * trust boundary, authenticated fetches, the alert trend/heatmap, and the
 * corpus-intelligence panels. All logic lives here; scripts/browser-smoke.ts
 * is the thin CLI entry (bun run test:browser). Exits non-zero on failure
 * (CI-gatable); the deterministic bun test suite intentionally does NOT
 * include this.
 */
export async function runBrowserSmoke(): Promise<void> {
  /**
   * Resolve a usable Chromium executable. The Playwright npm package expects a
   * specific build that may not be the one present in the shared ms-playwright
   * cache (version-skew failure), so we detect whatever build is actually
   * installed (full "Chrome for Testing" or a headless shell) and pass its
   * executable explicitly. Override with PLAYWRIGHT_EXECUTABLE_PATH.
   */
  function resolveChromiumExecutable(): string | undefined {
    const viaEnv = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    if (viaEnv && existsSync(viaEnv)) return viaEnv;
    if (existsSync("/bin/google-chrome")) return "/bin/google-chrome";
    const cacheCandidates = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      join(process.env.HOME ?? "~", "Library", "Caches", "ms-playwright"),
      join(process.env.HOME ?? "~", ".cache", "ms-playwright"),
    ].filter(Boolean) as string[];
    const found: string[] = [];
    for (const dir of cacheCandidates) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const base = join(dir, entry);
        const appBin = join(base, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
        if (existsSync(appBin)) found[found.length] = appBin;
        const shellMac = join(base, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
        if (existsSync(shellMac)) found[found.length] = shellMac;
        const shellLinux = join(base, "chrome-linux-headless-shell", "chrome-headless-shell");
        if (existsSync(shellLinux)) found[found.length] = shellLinux;
      }
    }
    return found[0];
  }

  const PORT = Number(process.env.PORT ?? "3999");
  const BASE = `http://127.0.0.1:${PORT}`;
  let failed = false;
  function markFail(msg: string): void {
    failed = true;
    console.error(`[browser-smoke] FAIL: ${msg}`);
  }

  async function waitForHealth(url: string, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  async function main() {
    console.log(`[browser-smoke] Starting GUI server on :${PORT}`);
    const child = Bun.spawn(["bun", "run", "src/gui/server.ts"], {
      env: { ...process.env, PORT: String(PORT) },
      stdout: "pipe",
      stderr: "pipe",
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      const healthy = await waitForHealth(`${BASE}/api/health`);
      if (!healthy) {
        markFail(`server did not become healthy at ${BASE}/api/health`);
        return;
      }

      const executablePath = resolveChromiumExecutable();
      console.log(`[browser-smoke] chromium=${executablePath ?? "playwright-managed"}`);
      browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      const alertRequests: string[] = [];
      const apiRequests: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      page.on("request", request => {
        const url = new URL(request.url());
        apiRequests.push(url.pathname);
        if (url.pathname.startsWith("/api/alerts/")) alertRequests.push(`${url.pathname}${url.search}`);
      });
      await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20_000 });

      const headerCount = await page.locator("#header").count();
      if (headerCount === 0) markFail("page did not render #header");

      const injectedKey = await page.evaluate(() => (window as any).__CC_API_KEY__ ?? "");
      if (!injectedKey || injectedKey.startsWith("__CC_API_KEY")) {
        markFail("loopback page did not receive the injected API key (trust boundary)");
      }

      const tocResult = await page.evaluate(async (base: string) => {
        try {
          const res = await fetch(`${base}/api/toc`);
          const body = await res.json().catch(() => null);
          return { reachable: true, status: res.status, hasBody: body !== null };
        } catch { return { reachable: false, status: 0, hasBody: false }; }
      }, BASE);
      if (!tocResult.reachable || ![200, 404].includes(tocResult.status) || !tocResult.hasBody) {
        markFail(`/api/toc returned an invalid fresh-clone envelope (status=${tocResult.status})`);
      }

      // The semantic-search endpoint must return a 200 envelope (mode semantic or
      // bm25-fallback) whether or not the vector stack is running.
      const semantic = await page.evaluate(async (base: string) => {
        try {
          const res = await fetch(`${base}/api/search/semantic?q=harbor&limit=3`);
          if (!res.ok) return { ok: false, status: res.status };
          const body = await res.json();
          return { ok: true, mode: body.mode, count: Array.isArray(body.results) ? body.results.length : -1 };
        } catch { return { ok: false }; }
      }, BASE);
      if (!semantic.ok) markFail("/api/search/semantic did not return 200");
      else if (semantic.mode !== "semantic" && semantic.mode !== "bm25-fallback") markFail(`unexpected semantic mode: ${semantic.mode}`);
      else console.log(`[browser-smoke] semantic mode=${semantic.mode} results=${semantic.count}`);

      await page.locator("#alerts-toggle").click();
      await page.locator('#alert-trends-content[aria-busy="false"]').waitFor({ state: "visible", timeout: 20_000 });
      const alertView = await page.evaluate(() => {
        const heatRows = document.querySelectorAll(".alert-heatmap tbody tr");
        const heatCells = document.querySelectorAll(".alert-heatmap tbody td");
        const labelledCells = [...heatCells].filter(cell => (cell.getAttribute("aria-label") ?? "").includes("recorded event"));
        const legendStates = [...document.querySelectorAll(".alert-state-legend [data-state]")]
          .map(element => element.getAttribute("data-state"));
        const rowStates = [...heatRows].map(row => row.getAttribute("data-state"));
        return {
          selectOptions: document.querySelectorAll("#alert-trend-type option").length,
          trendColumns: document.querySelectorAll("#alert-trend-chart .alert-trend-column").length,
          heatRows: heatRows.length,
          heatCells: heatCells.length,
          labelledCells: labelledCells.length,
          legendStates,
          rowStates,
          note: document.querySelector(".alert-trend-note")?.textContent ?? "",
        };
      });
      if (alertView.selectOptions !== 8) markFail(`alert type selector rendered ${alertView.selectOptions} options, expected 8`);
      if (alertView.trendColumns !== 14) markFail(`alert trend rendered ${alertView.trendColumns} days, expected 14`);
      if (alertView.heatRows !== 8 || alertView.heatCells !== 112) {
        markFail(`alert heatmap shape was ${alertView.heatRows}x${alertView.heatCells / Math.max(1, alertView.heatRows)}, expected 8x14`);
      }
      if (alertView.labelledCells !== alertView.heatCells) markFail("alert heatmap cells are missing accessible recorded-event labels");
      for (const state of ["calm", "empty", "stale", "unavailable"]) {
        if (!alertView.legendStates.includes(state)) markFail(`alert legend is missing distinct ${state} state`);
      }
      if (alertView.rowStates.some(state => !["calm", "active", "available", "empty", "stale", "unavailable", "unknown"].includes(state ?? ""))) {
        markFail(`alert heatmap exposed an invalid source state: ${alertView.rowStates.join(",")}`);
      }
      if (!alertView.note.includes("rendering is capped at 5,000 records")) markFail("alert rendering bound is not visible");
      if (!alertRequests.some(path => path === "/api/alerts/timeline")) markFail("alert view did not request /api/alerts/timeline");
      for (const type of ["tsunami", "earthquake", "weather", "tides", "airquality", "wildfire", "marine", "fishing"]) {
        if (!alertRequests.some(path => path.startsWith(`/api/alerts/${type}/history?`))) {
          markFail(`alert view did not request ${type} history`);
        }
      }
      // ─── Corpus-intelligence panels ────────────────────────────────
      //
      // Each tab has a loader that fires once on first open. Waiting for the
      // panel's "Loading…" placeholder to be replaced is what proves the loader
      // ran and produced markup; asserting the request went out proves the
      // numbers came from the endpoint rather than from anything in the page.
      async function openPanel(overlayId: string, overlayToggle: string, tab: string, contentId: string, expectedRoute: string): Promise<string> {
        // The overlay buttons are toggles: clicking one that is already open
        // closes it, and an open overlay covers the header, so a real pointer
        // click on a DIFFERENT overlay's button is intercepted. Dispatch the
        // toggle programmatically — the handler is what is under test here, not
        // the header's hit area, which the alert panel above already exercises.
        const alreadyOpen = await page.evaluate((id: string) => Boolean(document.getElementById(id)?.classList.contains("open")), overlayId);
        if (!alreadyOpen) {
          await page.evaluate((selector: string) => {
            (document.querySelector(selector) as HTMLElement | null)?.click();
          }, overlayToggle);
        }
        await page.locator(`#${overlayId} .intel-tab[data-tab="${tab}"]`).first().click();
        try {
          await page.waitForFunction(
            (id: string) => {
              const element = document.getElementById(id);
              return Boolean(element) && !/Loading|Building|Counting|Reading/.test(element!.textContent ?? "");
            },
            contentId,
            { timeout: 30_000 },
          );
        } catch {
          markFail(`${tab} panel never finished loading`);
          return "";
        }
        if (!apiRequests.some(path => path === expectedRoute)) markFail(`${tab} panel did not request ${expectedRoute}`);
        const text = await page.locator(`#${contentId}`).innerText();
        if (!text.trim()) markFail(`${tab} panel rendered empty`);
        return text;
      }

      const graphText = await openPanel("analytics-overlay", "#analytics-toggle", "graph", "graph-content", "/api/sections/graph");
      for (const label of ["Sections", "Citation edges", "Resolution rate", "Components"]) {
        if (!graphText.includes(label)) markFail(`section graph panel is missing the "${label}" metric`);
      }
      const lexiconText = await openPanel("analytics-overlay", "#analytics-toggle", "lexicon", "lexicon-content", "/api/lexicon/frequency");
      for (const label of ["Indexed tokens", "Distinct terms", "Most frequent terms", "Most distinctive terms"]) {
        if (!lexiconText.includes(label)) markFail(`word-frequency panel is missing "${label}"`);
      }
      const longevityText = await openPanel("analytics-overlay", "#analytics-toggle", "longevity", "longevity-content", "/api/sections/longevity");
      for (const label of ["Dated sections", "Median age", "Activity by decade", "Oldest enactments"]) {
        if (!longevityText.includes(label)) markFail(`longevity panel is missing "${label}"`);
      }
      const chronologyText = await openPanel("analytics-overlay", "#analytics-toggle", "chronology", "chronology-content", "/api/ordinance/chronology");
      for (const label of ["Distinct ordinances", "Ordinances per decade", "City-wide lineage"]) {
        if (!chronologyText.includes(label)) markFail(`ordinance timeline panel is missing "${label}"`);
      }
      const insightsText = await openPanel("feeds-overlay", "#feeds-toggle", "insights", "insights-content", "/api/insights");
      if (!/window|domain|movement|Domain/i.test(insightsText)) markFail("civic insight panel rendered no brief content");

      // The chat model picker must populate from /api/llm/models on first open,
      // or stay at exactly one honest "Default model" entry when the provider is
      // unreachable — never an empty or half-built select.
      await page.evaluate(() => (document.getElementById("chat-toggle") as HTMLElement | null)?.click());
      await page.waitForTimeout(1500);
      const modelPicker = await page.evaluate(() => {
        const select = document.getElementById("chat-model") as HTMLSelectElement | null;
        return { present: Boolean(select), options: select ? select.options.length : 0, first: select?.options[0]?.value ?? null };
      });
      if (!modelPicker.present) markFail("chat model picker is absent");
      if (modelPicker.options < 1) markFail("chat model picker rendered no options");
      if (modelPicker.first !== "") markFail("chat model picker's first option is not the server default");
      const modelsRequested = apiRequests.some(path => path === "/api/llm/models");
      console.log(`[browser-smoke] modelPicker options=${modelPicker.options} discovered=${modelsRequested}`);

      if (pageErrors.length > 0) markFail(`page error(s): ${pageErrors.join(" | ")}`);
      console.log(`[browser-smoke] alertTrend=${alertView.trendColumns}d heatmap=${alertView.heatRows}x${alertView.heatCells / Math.max(1, alertView.heatRows)} states=${[...new Set(alertView.rowStates)].join(",")}`);

      console.log(`[browser-smoke] header=${headerCount} keyInjected=${Boolean(injectedKey)} tocStatus=${tocResult.status}`);
      if (!failed) console.log("[browser-smoke] PASS: page rendered, key injected, api authenticated, alert trend/heatmap accessible, corpus-intelligence panels and insight brief live");
    } catch (error) {
      markFail(error instanceof Error ? error.message : String(error));
    } finally {
      await browser?.close().catch(() => undefined);
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
    }

    process.exit(failed ? 1 : 0);
  }

  await main();
}

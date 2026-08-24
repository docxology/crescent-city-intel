#!/usr/bin/env bun
/**
 * Real browser smoke test (Playwright + headless Chromium).
 *
 * Starts the actual GUI server, loads the page in a real browser, and asserts:
 *   1. The SPA renders (header present).
 *   2. The local/loopback API-key injection delivers a real key to the page
 *      (the security-critical trust boundary from gui-server.test.ts).
 *   3. /api/toc returns a truthful 200 or fresh-clone 404 envelope via the
 *      page's authenticated fetch.
 *   4. The Alerts panel renders its bounded trend + heatmap from the real
 *      timeline/history APIs with accessible source-state labels.
 *
 * Run with: bun run test:browser
 * Exits non-zero on failure (CI-gatable). Requires a Playwright browser; the
 * deterministic `bun test` suite intentionally does NOT include this.
 */
import { chromium } from "playwright";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

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
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
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
    if (pageErrors.length > 0) markFail(`page error(s): ${pageErrors.join(" | ")}`);
    console.log(`[browser-smoke] alertTrend=${alertView.trendColumns}d heatmap=${alertView.heatRows}x${alertView.heatCells / Math.max(1, alertView.heatRows)} states=${[...new Set(alertView.rowStates)].join(",")}`);

    console.log(`[browser-smoke] header=${headerCount} keyInjected=${Boolean(injectedKey)} tocStatus=${tocResult.status}`);
    if (!failed) console.log("[browser-smoke] PASS: page rendered, key injected, api authenticated, alert trend/heatmap accessible");
  } catch (error) {
    markFail(error instanceof Error ? error.message : String(error));
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  process.exit(failed ? 1 : 0);
}

void main();

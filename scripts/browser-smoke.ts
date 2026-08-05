#!/usr/bin/env bun
/**
 * Real browser smoke test (Playwright + headless Chromium).
 *
 * Starts the actual GUI server, loads the page in a real browser, and asserts:
 *   1. The SPA renders (header present).
 *   2. The local/loopback API-key injection delivers a real key to the page
 *      (the security-critical trust boundary from gui-server.test.ts).
 *   3. /api/toc returns OK via the page's authenticated fetch.
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
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20_000 });

    const headerCount = await page.locator("#header").count();
    if (headerCount === 0) markFail("page did not render #header");

    const injectedKey = await page.evaluate(() => (window as any).__CC_API_KEY__ ?? "");
    if (!injectedKey || injectedKey.startsWith("__CC_API_KEY")) {
      markFail("loopback page did not receive the injected API key (trust boundary)");
    }

    const tocOk = await page.evaluate(async (base: string) => {
      try {
        const res = await fetch(`${base}/api/toc`);
        return res.ok;
      } catch { return false; }
    }, BASE);
    if (!tocOk) markFail("/api/toc did not return OK from the page context");

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

    console.log(`[browser-smoke] header=${headerCount} keyInjected=${Boolean(injectedKey)} tocOk=${tocOk}`);
    if (!failed) console.log("[browser-smoke] PASS: page rendered, key injected, api authenticated");
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

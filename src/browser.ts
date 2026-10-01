/**
 * Browser management module.
 * Handles Playwright browser lifecycle and Cloudflare bypass.
 */
import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from "playwright";
import { SCRAPE_TIMEOUT_MS, CLOUDFLARE_WAIT_MS } from "./constants.js";
import { existsSync } from "fs";
import { createLogger } from "./logger.js";
import { createRunScope, currentRunSignal, remainingRunMs } from "./shared/run_scope.js";
import { stopOwnedProcess, type ProcessShutdownReceipt } from "./shared/process_ownership.js";
import { withinDeadline } from "./shared/transport.js";
import { outputRoot } from "./shared/paths.js";
import { resolve } from "node:path";
import { createBrowserLauncher, terminateBrowserLauncher, recoverOwnedBrowsers, type BrowserLauncher } from "./browser_launcher.js";

const log = createLogger("browser");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface BrowserSession { browser: Browser | null; context: BrowserContext | null; launchPromise: Promise<BrowserContext> | null; server: BrowserServer | null; closePromise: Promise<ProcessShutdownReceipt | null> | null; launcher: BrowserLauncher | null }
const sessions = new Map<string, BrowserSession>(); const pageOwners = new WeakMap<Page, BrowserSession>();
function session(): BrowserSession {
  const key = resolve(outputRoot()); let value = sessions.get(key);
  if (!value) { value = { browser: null, context: null, launchPromise: null, server: null, closePromise: null, launcher: null }; sessions.set(key, value); }
  return value;
}
export interface BrowserOptions { signal?: AbortSignal; timeoutMs?: number }

export async function launchBrowser(options: BrowserOptions = {}): Promise<BrowserContext> {
  options = { ...options, signal: options.signal ?? currentRunSignal() };
  const state = session();
  options.signal?.throwIfAborted();
  if (state.closePromise) await state.closePromise;
  if (state.launchPromise) return state.launchPromise;
  if ((state.server || state.launcher) && !state.context) await closeSession(state);
  options.signal?.throwIfAborted();
  if (state.context) return state.context;

  // HEADLESS_BROWSER=1 enables headless mode (required for CI/Docker).
  const headless = process.env.HEADLESS_BROWSER === "1";

  // PLAYWRIGHT_CHROMIUM_EXECUTABLE overrides the browser binary resolution.
  // Default: let Playwright resolve its own managed build (works in CI after
  // `npx playwright install chromium --with-deps`); a hardcoded path is only
  // used when explicitly provided via env.
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  if (!executablePath) {
    // Discover any installed Playwright-managed build (build numbers vary).
    try {
      const { readdirSync } = await import("fs");
      const { join } = await import("path");
      const cacheRoot = join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright");
      for (const entry of readdirSync(cacheRoot).sort().reverse()) {
        if (!entry.startsWith("chromium-")) continue;
        const candidate = join(cacheRoot, entry, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
        if (existsSync(candidate)) { executablePath = candidate; break; }
      }
    } catch { /* best-effort discovery; default resolution remains the fallback */ }
  }

  log.info(headless ? "Launching Chromium browser (headless)" : "Launching Chromium browser (non-headless)");
  if (executablePath) log.info(`Using executablePath: ${executablePath}`);
  state.launchPromise = (async () => {
    try {
      const scope = createRunScope({ signal: options.signal, deadlineMs: Math.min(options.timeoutMs ?? 30_000, remainingRunMs() ?? 30_000) });
      let watchdog: ReturnType<typeof setInterval> | undefined;
      try {
      await recoverOwnedBrowsers();
      state.launcher = await createBrowserLauncher(executablePath ?? chromium.executablePath());
      // launchServer in the pinned SDK does not bound its protocol handshake.
      // The exclusive wrapper receipt owns the process before that API returns.
      watchdog = setInterval(() => { if (scope.signal.aborted && state.launcher) void terminateBrowserLauncher(state.launcher).catch(error => log.warn("Owned launcher cancellation failed", { error: String(error) })); }, 5);
      state.server = await chromium.launchServer({
        headless,
        executablePath: state.launcher.executable,
        args: ["--disable-blink-features=AutomationControlled"],
        timeout: scope.remainingMs(),
        host: "127.0.0.1",
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      });
      scope.signal.throwIfAborted();
      state.browser = await chromium.connect(state.server.wsEndpoint(), { timeout: scope.remainingMs() });
      scope.signal.throwIfAborted();
      state.context = await state.browser.newContext({ userAgent: USER_AGENT });
      scope.signal.throwIfAborted();
      log.info("Browser context created");
      return state.context;
      } catch (error) { await closeSession(state); throw error; }
      finally { clearInterval(watchdog); scope.dispose(); }
    } finally {
      state.launchPromise = null;
    }
  })();
  return state.launchPromise;
}

export async function closeBrowser(options: { timeoutMs?: number } = {}): Promise<ProcessShutdownReceipt | null> {
  return closeSession(session(), options);
}
async function closeSession(state: BrowserSession, options: { timeoutMs?: number; force?: boolean } = {}): Promise<ProcessShutdownReceipt | null> {
  if (state.closePromise) return state.closePromise;
  const ownedServer = state.server; const closingContext = state.context; const closingBrowser = state.browser;
  // Stop new work, but retain the authenticated process handle until cleanup
  // proves reaping. A failed cleanup must remain retryable by the finalizer.
  state.context = null; state.browser = null;
  if (!ownedServer) {
    if (state.launcher) { await terminateBrowserLauncher(state.launcher); await state.launcher.dispose(); state.launcher = null; }
    if (closingContext) await boundedClose(() => closingContext.close(), "Browser context", 100); if (closingBrowser) await boundedClose(() => closingBrowser.close(), "Browser", 100); return null;
  }
  state.closePromise = (async () => {
    const timeoutMs = options.timeoutMs ?? 1000; const started = Date.now();
    if (!options.force) await boundedClose(() => ownedServer.close(), "Browser graceful shutdown", Math.max(1, Math.min(100, timeoutMs / 4)));
    const receipt = await stopOwnedProcess(ownedServer.process(), Math.max(1, timeoutMs - (Date.now() - started)));
    if (!receipt.directChildReaped || !receipt.processGroupGone) throw new Error("Owned Chromium shutdown did not reap its child and terminate its process group");
    state.server = null;
    if (state.launcher) { await state.launcher.dispose(); state.launcher = null; }
    log.info("Browser closed", { ...receipt }); return receipt;
  })();
  try { return await state.closePromise; } finally { state.closePromise = null; }
}
/** Diagnostic identity of this module's documented Playwright-owned process. */
export function ownedBrowserPid(): number | undefined { return session().server?.process().pid; }

async function boundedClose(close: () => Promise<void>, label: string, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} close exceeded ${timeoutMs}ms`)), timeoutMs); })]); return true; }
  catch (error) { log.warn(`${label} cleanup incomplete`, { error: String(error) }); return false; }
  finally { clearTimeout(timer); }
}
/** Cleanup has its own bound; this does not claim that a wedged browser process was reaped. */
export async function closePageBounded(page: Page | null, timeoutMs = 3000): Promise<void> {
  if (page) await boundedClose(() => page.close(), "Page", timeoutMs);
}

/**
 * Navigate to a URL, waiting for Cloudflare to clear.
 * Returns the page after content has loaded.
 */
export async function navigateWithCloudflare(
  page: Page,
  url: string,
  opts: { timeout?: number; renderMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const timeout = opts.timeout ?? SCRAPE_TIMEOUT_MS;
  await withPageDeadline(page, async () => {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });

  // Wait for Cloudflare Turnstile challenge to resolve
  await page.waitForFunction(
    () => {
      const title = document.title.toLowerCase();
      const body = document.body?.innerText?.slice(0, 2000).toLowerCase() ?? "";
      const challengeWidgetVisible = [...document.querySelectorAll("#challenge-running, .cf-chl-widget")].some((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && (element as HTMLElement).offsetWidth > 0;
      });
      return !title.includes("just a moment")
        && !body.includes("checking your browser")
        && !body.includes("verify you are human")
        && !challengeWidgetVisible;
    },
    undefined,
    { timeout }
  );

  // Give the SPA time to render content
  await page.waitForTimeout(opts.renderMs ?? CLOUDFLARE_WAIT_MS);
  }, timeout, opts.signal);
}

/** Close the page on a total deadline so its pending navigation/evaluation cannot continue. */
export async function withPageDeadline<T>(page: Page, operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  parent ??= currentRunSignal();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid browser deadline");
  const started = Date.now(); const cleanupReserve = Math.min(500, Math.max(20, timeoutMs / 4));
  const scope = createRunScope({ signal: parent, deadlineMs: Math.max(1, timeoutMs - cleanupReserve) });
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(scope.signal.reason); scope.signal.addEventListener("abort", rejectAbort, { once: true }); });
  try { scope.signal.throwIfAborted(); return await Promise.race([operation(scope.signal), aborted]); }
  catch (error) {
    if (scope.signal.aborted) {
      const owner = pageOwners.get(page);
      if (owner) {
        // Cancelled protocol work cannot be trusted to close its own page.
        // Force its authenticated group, then await its actual exit receipt.
        await closeSession(owner, { timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), force: true });
      } else {
        // A caller-owned page grants no authority over this root's browser.
        await closePageBounded(page, Math.max(1, Math.min(20, timeoutMs - (Date.now() - started))));
      }
    }
    throw error;
  } finally { scope.dispose(); if (rejectAbort) scope.signal.removeEventListener("abort", rejectAbort); }
}

/**
 * Create a new page with anti-detection measures.
 */
export async function newPage(options: BrowserOptions = {}): Promise<Page> {
  options = { ...options, signal: options.signal ?? currentRunSignal() };
  const state = session();
  const ctx = await launchBrowser(options);
  options.signal?.throwIfAborted();
  try {
    return await withinDeadline(async signal => {
      const page = await ctx.newPage(); pageOwners.set(page, state); signal.throwIfAborted();
      await page.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => false }); });
      signal.throwIfAborted(); return page;
    }, Math.min(options.timeoutMs ?? 30_000, remainingRunMs() ?? 30_000), options.signal);
  } catch (error) { await closeSession(state, { timeoutMs: 1000 }); throw error; }
}

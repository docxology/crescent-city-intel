/**
 * Browser management module.
 * Handles Playwright browser lifecycle and Cloudflare bypass.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SCRAPE_TIMEOUT_MS, CLOUDFLARE_WAIT_MS } from "./constants.js";
import { existsSync } from "fs";
import { createLogger } from "./logger.js";

const log = createLogger("browser");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let launchPromise: Promise<BrowserContext> | null = null;

export async function launchBrowser(): Promise<BrowserContext> {
  if (context) return context;
  if (launchPromise) return launchPromise;

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
  launchPromise = (async () => {
    try {
      browser = await chromium.launch({
        headless,
        ...(executablePath ? { executablePath } : {}),
        args: ["--disable-blink-features=AutomationControlled"],
      });

      context = await browser.newContext({ userAgent: USER_AGENT });
      log.info("Browser context created");
      return context;
    } finally {
      launchPromise = null;
    }
  })();
  return launchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
    log.info("Browser closed");
  }
}

/**
 * Navigate to a URL, waiting for Cloudflare to clear.
 * Returns the page after content has loaded.
 */
export async function navigateWithCloudflare(
  page: Page,
  url: string,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? SCRAPE_TIMEOUT_MS;

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
    { timeout }
  );

  // Give the SPA time to render content
  await page.waitForTimeout(CLOUDFLARE_WAIT_MS);
}

/**
 * Create a new page with anti-detection measures.
 */
export async function newPage(): Promise<Page> {
  const ctx = await launchBrowser();
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return page;
}

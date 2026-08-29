/**
 * Lane 5 (R3 P2) — headless render smoke test over the exported Pages artifact.
 *
 * Every earlier gate read the exported HTML as text. This one renders it: a real
 * Chromium (the one the code scraper already installs) loads each exported page
 * and reports what a visitor would get — script errors, horizontal overflow at
 * four viewport widths, and render targets the page script left empty.
 *
 * Determinism: nothing is fetched. Playwright's request interception serves the
 * exported directory itself, external font requests are fulfilled with an empty
 * stylesheet, and any other host is failed rather than reached — a test that
 * needs the network is not a gate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { extname, join, normalize } from "path";
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";

const ORIGIN = "https://quadruplicate.test";
const PAGES = ["index.html", "gui.html", "news.html", "meetings.html", "events.html", "code.html", "sources.html", "404.html"];
const VIEWPORTS = [320, 375, 768, 1440];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

/**
 * Ids that are legitimately empty on a freshly loaded page, each with the reason
 * it is empty. Anything else that renders nothing is a defect: the container is
 * in the markup because a script is supposed to fill it.
 */
const EMPTY_BY_DESIGN: Record<string, string> = {
  "main": "layout landmark, not a render target",
  "code-results": "code.html/index.html: fills on the first search keystroke",
  "code-search": "input element",
  "content-filter": "input element",
  "registry-filter": "input element",
  "news-filter": "input element",
  "source-filter": "input element",
  "chat-input": "gui console input element",
  "chat-log": "gui console: fills on the first question",
  "refresh-state": "status line, written after a manual refresh",
  "structured-state": "status line, written after a copy action",
  "event-freshness": "written only when the calendar artifact records a generatedAt",
  "geo-tags": "populated from the geo-intel artifact when one is present",
  "analytics-download": "download link, present only when the analytics artifact is exported",
};

/**
 * The stylesheet the overflow pass forces on every page. Overflow is a function
 * of text metrics, so measuring in whatever fonts the host happens to have made
 * this gate environment-dependent: pages that fit on macOS re-overflowed in CI's
 * system-font fallback, and a per-environment ledger of "known" overflow is a
 * gate that reports the environment rather than the page.
 *
 * Forcing a monospace stack instead measures a STRICTER property — no real
 * fallback is wider than monospace, so a page that fits here fits anywhere,
 * including for a visitor whose webfont request never lands. Deterministic on
 * every machine, and no ledger to keep honest.
 */
const STRESS_FONT_CSS = '*, *::before, *::after { font-family: "Courier New", monospace !important; }'

let browser: Browser;
let root: string;
let destination: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cci-render-"));
  destination = join(root, "pages");
  // A real export of the repo's real artifacts — the same code path the
  // published edition is built with, not a fixture of it.
  await exportPagesSnapshot({ outputDir: "output", destination, seedDir: "pages-data" });
  browser = await launchChromium();
}, 180000);

/**
 * Launch the Playwright-managed Chromium. The default resolution is tried
 * first (that is what CI gets after `playwright install chromium`); when the
 * cache holds a different build number than this Playwright expects — the
 * normal state of a developer machine shared with other projects — the same
 * discovery src/browser.ts already uses picks the installed build up instead of
 * silently skipping the smoke test.
 */
async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (defaultError) {
    const cacheRoot = process.platform === "darwin"
      ? join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
      : join(process.env.HOME ?? "", ".cache", "ms-playwright");
    const candidates = ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-linux/chrome"];
    const entries = existsSync(cacheRoot) ? readdirSync(cacheRoot).filter(entry => entry.startsWith("chromium-")).sort().reverse() : [];
    for (const entry of entries) {
      for (const candidate of candidates) {
        const executablePath = join(cacheRoot, entry, ...candidate.split("/"));
        if (existsSync(executablePath)) return await chromium.launch({ executablePath });
      }
    }
    throw new Error(`no Playwright Chromium available for the render smoke test — run \`bunx playwright install chromium\` (${(defaultError as Error).message})`);
  }
}

afterAll(async () => {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
});

/** Serve the exported directory to the page; refuse everything else. */
async function serveExport(page: Page, fontCss = ""): Promise<void> {
  await serveDir(page, destination, fontCss);
}

/** Serve one exported directory to the page; refuse everything else. */
async function serveDir(page: Page, root: string, fontCss = ""): Promise<void> {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      // Fonts and any other third-party asset: a local body, never a request.
      // The webfont stylesheet is where the stress stack is injected, because
      // that is exactly the request a visitor's blocked or slow CDN replaces.
      const isFontCss = url.hostname.includes("fonts.googleapis.com");
      await route.fulfill({ status: 200, contentType: isFontCss ? "text/css" : "text/plain", body: isFontCss ? fontCss : "" });
      return;
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
    const file = join(root, relative === "" ? "index.html" : relative);
    if (!file.startsWith(root) || !existsSync(file)) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
      return;
    }
    await route.fulfill({ status: 200, contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream", body: await readFile(file) });
  });
}

interface PageReport {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  emptyTargets: string[];
  overflow: Array<{ width: number; scrollWidth: number; how: string }>;
}

async function renderPage(name: string): Promise<PageReport> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message: ConsoleMessage) => { if (message.type() === "error") consoleErrors.push(`${name}: ${message.text()}`); });
  page.on("pageerror", error => pageErrors.push(`${name}: ${error.message}`));
  page.on("requestfailed", request => failedRequests.push(`${name}: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`));
  await serveExport(page);

  await page.goto(`${ORIGIN}/${name}`, { waitUntil: "networkidle" });
  // The page scripts render from fetched artifacts; give them a settled frame.
  await page.waitForTimeout(250);

  const emptyTargets = await page.evaluate(explained => {
    const empty: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[id]"))) {
      if (element.id in explained) continue;
      const tag = element.tagName.toLowerCase();
      if (["input", "select", "textarea", "button", "script", "link", "meta", "a", "nav", "header", "footer", "form", "details", "summary", "time", "h1", "h2", "h3", "p", "li", "option", "table", "thead", "tbody", "tr", "td", "th", "pre", "code", "img", "svg", "canvas"].includes(tag)) continue;
      const text = (element.textContent ?? "").trim();
      if (text === "" && element.children.length === 0) empty.push(`#${element.id} <${tag}>`);
    }
    return empty;
  }, EMPTY_BY_DESIGN);

  // Overflow after a resize is a real experience (rotating a phone), and it is
  // not the same measurement as loading at that width — an element sized at
  // 1440 can leave a wider scroll extent behind. Both are measured.
  const overflow: Array<{ width: number; scrollWidth: number; how: string }> = [];
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(60);
    const scrollWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    // One pixel of slack for sub-pixel layout rounding.
    if (scrollWidth > width + 1) overflow.push({ width, scrollWidth, how: "after-resize" });
  }
  await context.close();

  overflow.push(...await measureLoadWidthOverflow(name));
  return { consoleErrors, pageErrors, failedRequests, emptyTargets, overflow };
}

/**
 * Load the page fresh at each viewport width, in the stress font stack, and
 * report any width whose document is wider than its viewport. A fresh load is
 * what a phone visitor actually gets; the stress stack makes the answer the
 * same on every machine.
 */
async function measureLoadWidthOverflow(name: string): Promise<Array<{ width: number; scrollWidth: number; how: string }>> {
  const found: Array<{ width: number; scrollWidth: number; how: string }> = [];
  for (const width of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await serveExport(page, STRESS_FONT_CSS);
    await page.goto(`${ORIGIN}/${name}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(200);
    const measured = await page.evaluate(() => {
      const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      // Name the elements that reach past the viewport, so a failure says WHAT
      // overflowed rather than only by how much — the difference between a
      // number to argue with and a defect to fix.
      const offenders = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .map(element => ({ element, rect: element.getBoundingClientRect() }))
        .filter(entry => entry.rect.width > 0 && entry.rect.right > window.innerWidth + 1)
        .sort((a, b) => b.rect.right - a.rect.right)
        .slice(0, 4)
        .map(entry => `${entry.element.tagName.toLowerCase()}${entry.element.id ? `#${entry.element.id}` : ""}${entry.element.className && typeof entry.element.className === "string" ? `.${entry.element.className.split(/\s+/).join(".")}` : ""}@${Math.round(entry.rect.right)}`);
      return { scrollWidth, offenders };
    });
    if (measured.scrollWidth > width + 1) found.push({ width, scrollWidth: measured.scrollWidth, how: `stress-font-at-load [${measured.offenders.join(" ")}]` });
    await context.close();
  }
  return found;
}

describe("lane 5: exported pages render cleanly in real Chromium", () => {
  for (const name of PAGES) {
    test(`${name} renders with no script errors, no overflow, and no empty render target`, async () => {
      const report = await renderPage(name);
      expect(`${name} console errors: ${JSON.stringify(report.consoleErrors)}`).toBe(`${name} console errors: []`);
      expect(`${name} page errors: ${JSON.stringify(report.pageErrors)}`).toBe(`${name} page errors: []`);
      expect(`${name} failed requests: ${JSON.stringify(report.failedRequests)}`).toBe(`${name} failed requests: []`);
      expect(`${name} empty render targets: ${JSON.stringify(report.emptyTargets)}`).toBe(`${name} empty render targets: []`);
      // No ledger, no environment carve-out: the page must fit its viewport at
      // every measured width, both freshly loaded in the stress font and after
      // a resize down from the desktop layout.
      expect(`${name} overflow: ${JSON.stringify(report.overflow)}`).toBe(`${name} overflow: []`);
    }, 120000);
  }
});

describe("lane 5: the calendar page tells the truth about a wrong-shaped artifact", () => {
  /** Render events.html with data/events.json replaced by `body`. */
  async function renderWithEventsArtifact(body: string): Promise<{ text: string; listChildren: string[]; count: string; freshness: string }> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await serveExport(page);
    await page.route(`${ORIGIN}/data/events.json`, async route => {
      await route.fulfill({ status: 200, contentType: "application/json", body });
    });
    await page.goto(`${ORIGIN}/events.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => ({
      text: document.getElementById("event-items")!.textContent ?? "",
      listChildren: Array.from(document.getElementById("event-items")!.children).map(child => child.tagName.toLowerCase()),
      count: document.getElementById("event-count")!.textContent ?? "",
      freshness: document.getElementById("event-freshness")!.textContent ?? "",
    }));
    await context.close();
    return result;
  }

  test("a bare array (the shape data/meetings.json has) renders the wrong-shape message, not '0 of 0'", async () => {
    const result = await renderWithEventsArtifact(JSON.stringify([{ id: "not-an-events-artifact" }]));
    expect(result.text).toContain("not in the expected calendar shape");
    expect(result.text).not.toContain("adjust");
    expect(result.count).toBe("");
    expect(result.listChildren).toEqual(["li"]);
  }, 120000);

  test("an envelope-shaped artifact is also refused rather than silently read as empty", async () => {
    const result = await renderWithEventsArtifact(JSON.stringify({ events: { events: [{ id: "nested" }], count: 1 } }));
    expect(result.text).toContain("not in the expected calendar shape");
    expect(result.count).toBe("");
  }, 120000);

  test("a real artifact with no generatedAt renders events and no freshness line — never NaN", async () => {
    const result = await renderWithEventsArtifact(JSON.stringify({
      schemaVersion: "crescent-city-events/v1",
      count: 1,
      events: [{ id: "e1", title: "Harbor Commission", kind: "government-meeting", dateStart: "2026-12-31", status: "scheduled", sourceLinks: [] }],
    }));
    expect(result.count).toBe("1 of 1 event(s)");
    expect(result.freshness).toBe("");
    expect(result.text).not.toContain("NaN");
    expect(result.listChildren.every(tag => tag === "li")).toBe(true);
  }, 120000);

  test("an unparseable generatedAt renders no freshness line rather than a NaN age", async () => {
    const result = await renderWithEventsArtifact(JSON.stringify({
      schemaVersion: "crescent-city-events/v1",
      generatedAt: "not-a-timestamp",
      count: 1,
      events: [{ id: "e1", title: "Harbor Commission", kind: "government-meeting", dateStart: "2026-12-31", status: "scheduled", sourceLinks: [] }],
    }));
    expect(result.freshness).toBe("");
    expect(result.text).not.toContain("NaN");
  }, 120000);

  test("an empty but well-formed calendar says so, and does not blame the reader's filters", async () => {
    const result = await renderWithEventsArtifact(JSON.stringify({ schemaVersion: "crescent-city-events/v1", generatedAt: new Date().toISOString(), count: 0, events: [] }));
    expect(result.count).toBe("0 of 0 event(s)");
    expect(result.listChildren).toEqual(["li"]);
  }, 120000);
});

describe("lane 5: an edition missing its optional artifacts still renders", () => {
  /**
   * The seed-only edition — what CI publishes when live collection fails
   * entirely. gui.html used to fetch data/analytics.json unconditionally, so
   * this edition served every visitor a 404 and, because the three console
   * fetches shared one Promise.all, rendered the whole console as
   * "Snapshot unavailable" while alerts and events had loaded fine.
   */
  test("the console page loads with no console error and no dead banner when no analytics overview exists", async () => {
    const seedRoot = await mkdtemp(join(tmpdir(), "cci-seed-"));
    const seedOutput = join(seedRoot, "empty-output");
    const seedDestination = join(seedRoot, "pages");
    await mkdir(seedOutput, { recursive: true });
    await exportPagesSnapshot({ outputDir: seedOutput, destination: seedDestination, seedDir: "pages-data" });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await serveDir(page, seedDestination);
    await page.goto(`${ORIGIN}/gui.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    const banner = await page.evaluate(() => document.getElementById("console-banner")?.textContent ?? "");
    const alertsRendered = await page.evaluate(() => (document.getElementById("alert-items")?.textContent ?? "").trim().length > 0);
    await context.close();
    await rm(seedRoot, { recursive: true, force: true });

    expect(`console errors: ${JSON.stringify(consoleErrors)}`).toBe("console errors: []");
    expect(banner).not.toContain("Snapshot unavailable");
    // The sections whose artifacts DO exist still render.
    expect(alertsRendered).toBe(true);
  }, 180000);
});

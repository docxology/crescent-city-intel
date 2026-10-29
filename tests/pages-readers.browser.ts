/** Real desktop/mobile Pages journeys over an explicitly synthetic retained edition. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";
import { writeReviewedPublicationFixture } from "./helpers/publication-fixture.ts";

export async function runPagesReaderJourneys(): Promise<void> {
  const parent = process.env.PAGES_READER_QA_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "cci-pages-readers-"));
  const source = join(root, "source"), destination = join(root, "public");
  await writeReviewedPublicationFixture(source);
  const code = await Bun.file(join(source, "crescent-city-code.json")).json();
  const searchTerm = String(code.articles[0].sections[0].title).match(/[A-Za-z]{3,}/)?.[0]?.toLowerCase();
  if (!searchTerm) throw new Error("Reviewed fixture requires an actual searchable section title");
  await mkdir(join(source, "news"));
  const generatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
  const items = Array.from({ length: 65 }, (_, index) => ({ title: `Reader fixture ${String(index).padStart(2, "0")}`, link: `https://example.test/civic/${index}`, source: "Lost Coast Outpost", pubDate: new Date(Date.parse(generatedAt) - (65 - index) * 60000).toISOString(), description: "Synthetic reader journey; not a collected civic claim." }));
  await writeFile(join(source, "news", "news-fixture.json"), JSON.stringify({ items }));
  await exportPagesSnapshot({ outputDir: source, destination, seedDir: join(root, "no-seed"), generatedAt });
  let failObservationFetch = false;
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url), path = resolve(destination, url.pathname === "/" ? "index.html" : `.${decodeURIComponent(url.pathname)}`);
    if (failObservationFetch && url.pathname === "/data/geo-observations.json") return new Response("Recorded fixture outage", { status: 503 });
    if (!path.startsWith(destination + sep)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return file.exists().then(exists => exists ? new Response(file) : new Response("Not found", { status: 404 }));
  } });
  let browser: Browser | undefined;
  const base = `http://127.0.0.1:${server.port}`;
  const checks: Array<{ width: number; assertions: string[]; screenshot: string }> = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const requests: string[] = [];
      page.on("request", request => requests.push(new URL(request.url()).pathname));
      page.setDefaultTimeout(15000);
      const assertions: string[] = [];
      try {
        await page.goto(`${base}/code.html`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.getElementById("code-results")?.textContent?.includes("Enter a search term"));
        assert.equal(requests.some(path => path.startsWith("/data/code-search")), false);
        assertions.push("code search index remains unloaded without a query");
        await page.goto(`${base}/code.html?q=${encodeURIComponent(searchTerm)}&keep=1`, { waitUntil: "domcontentloaded" });
        await page.locator("#code-results article").first().waitFor();
        assert.equal(await page.locator("#code-search").inputValue(), searchTerm);
        await page.locator("#code-search").fill("definitions");
        await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "definitions");
        assert.equal(new URL(page.url()).searchParams.get("keep"), "1");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => (document.getElementById("code-search") as HTMLInputElement)?.value === "definitions");
        await page.evaluate(query => { history.pushState(null, "", "?q=" + encodeURIComponent(query)); dispatchEvent(new PopStateEvent("popstate")); }, searchTerm);
        assert.equal(await page.locator("#code-search").inputValue(), searchTerm);
        await page.locator("#code-search").fill("");
        await page.waitForFunction(() => !new URL(location.href).searchParams.has("q"));
        assertions.push("shared query restores, updates, reloads, handles history and clears");

        await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
        assert.equal(await page.locator('head meta[name="cc-edition-generated-at"]').getAttribute("content"), generatedAt);
        await page.waitForFunction(() => document.querySelectorAll("#news-items article").length === 30);
        await page.locator('[data-more-list="news-items"]').click();
        assert.equal(await page.locator("#news-items article").count(), 60);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H3");
        await page.locator('[data-more-list="news-items"]').click();
        assert.equal(await page.locator("#news-items article").count(), 65);
        await page.locator("#content-filter").fill("Reader fixture 64");
        await page.waitForFunction(() => document.querySelectorAll("#news-items article").length === 1);
        await page.locator("#content-filter").fill("");
        await page.waitForFunction(() => document.querySelectorAll("#news-items article").length === 30);
        assert.equal(await page.locator('#edition-age [data-edition-age="older"]').count(), 1);
        assert.equal((await page.locator("#edition-age").textContent())!.includes("3 days old"), true);
        await page.locator("#edition-age").evaluate(element => { element.textContent = "Awaiting edition-age update"; });
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(() => document.getElementById("edition-age")?.textContent?.includes("3 days old"));
        assertions.push("edition metadata is present and visibility changes refresh the age notice");
        assertions.push("all 65 records reachable, keyboard focus retained, filter resets pagination, aged edition disclosed");
        await page.locator("#observations-refresh-state").waitFor();
        const retainedBoard = await page.locator(".observation-board").evaluate(element => element.outerHTML);
        failObservationFetch = true;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(() => document.getElementById("observations-refresh-state")?.textContent?.includes("Could not refresh"));
        assert.equal(await page.locator(".observation-board").evaluate(element => element.outerHTML), retainedBoard);
        failObservationFetch = false;
        assertions.push("real HTTP refresh failure is disclosed and preserves the retained observation board");

        await page.goto(`${base}/news.html`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => document.querySelector("#news-items article h3")?.textContent?.includes("64"));
        await page.locator("#news-more").click();
        assert.equal(await page.locator("#news-items article").count(), 60);
        await page.locator("#news-sort").selectOption("oldest");
        assert.equal(await page.locator("#news-items article").count(), 30);
        assert.equal((await page.locator("#news-items article h3").first().textContent())!.includes("00"), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assertions.push("news chronology and pagination reset; no horizontal overflow");
        assert.deepEqual(errors, []);
        const screenshot = join(root, `reader-${width}.png`);
        await page.screenshot({ path: screenshot });
        checks.push({ width, assertions, screenshot });
      } catch (error) {
        await writeFile(join(root, `failure-${width}.json`), JSON.stringify({ url: page.url(), errors, body: await page.locator("body").innerText() }, null, 2));
        await page.screenshot({ path: join(root, `failure-${width}.png`) });
        throw error;
      } finally { await context.close(); }
    }
    const receipt = { fixture: "reviewed code text plus synthetic news; never live source acceptance", generatedAt, checks, sourceChanges: "exact exported templates and shared bundle", result: "passed" };
    await writeFile(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ pagesReaderJourneys: "passed", viewportWidths: checks.map(check => check.width), receipt: join(root, "receipt.json") }));
  } finally { try { await browser?.close(); } finally { server.stop(true); } }
}

if (import.meta.main) await runPagesReaderJourneys();

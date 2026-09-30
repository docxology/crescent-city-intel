/** Explicit real-browser acceptance: bun run tests/gui-journeys.browser.ts */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArticlePage } from "../src/types.ts";

export async function runGuiJourneys(): Promise<void> {
  const seed = await Bun.file("pages-data/crescent-city-code.json").json() as { articles: ArticlePage[] };
  const article = seed.articles.find(item => item.sections.length > 0)!;
  const section = { ...article.sections[0]!, articleGuid: article.guid, articleTitle: article.title };
  const adversarialHtml = String.raw`<img srcset="https://unsafe.invalid/image 2x"><a href="#safe" ping="https://unsafe.invalid/ping">safe link</a><span style="background-image:u\72l(https://unsafe.invalid/style)">CSS attack</span><div style="width:30px;height:30px;background-image:image-set('https://unsafe.invalid/image-set' 1x)">CSS resource attack</div><svg><rect fill="url(https://unsafe.invalid/svg)"></rect></svg>`;
  let streamMode = "success", searchFirstFinished = false, requireKey = false, tocUnavailable = false;
  const chatBodies: Array<{ q: string; history: Array<{ role: string; content: string }> }> = [];
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "X-API-Key, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (path === "/denied") return new Response('<iframe id="denied-frame" style="width:1200px;height:900px" sandbox="allow-scripts" src="/"></iframe>', { headers: { "Content-Type": "text/html" } });
    if (path.startsWith("/api/") && requireKey && req.headers.get("X-API-Key") !== "fixture-memory-key") return Response.json({ error: "API key required" }, { status: 401, headers: cors });
    if (path === "/api/toc") return tocUnavailable ? Response.json({ error: "Contents unavailable" }, { status: 404, headers: cors }) : Response.json(await Bun.file("pages-data/toc.json").json(), { headers: cors });
    if (path === "/api/stats") return Response.json({ articleCount: seed.articles.length, sectionCount: 1, tocNodeCount: 1 }, { headers: cors });
    if (path === "/api/health") return Response.json({ status: "ok", chatProvider: "ollama" }, { headers: cors });
    if (path === "/api/models") return Response.json({ models: ["fixture-model"], defaultModel: "fixture-model" }, { headers: cors });
    if (path === "/api/search") {
      const q = url.searchParams.get("q");
      if (q === "first") { await new Promise(resolve => setTimeout(resolve, 700)); searchFirstFinished = true; }
      return Response.json({ results: [{ section: { ...section, title: q === "first" ? "First delayed response" : "Latest response" }, snippet: section.text.slice(0, 80) }] }, { headers: cors });
    }
    if (path.startsWith("/api/section/")) return Response.json({ ...section, html: '<p>Reviewed section content</p><img srcset="https://unsafe.invalid/image 2x"><a href="#safe" ping="https://unsafe.invalid/ping">safe link</a><span style="background-image:u\\72l(https://unsafe.invalid/style)">CSS attack</span><svg><rect fill="url(https://unsafe.invalid/svg)"></rect></svg>' }, { headers: cors });
    if (path === "/api/chat/stream") {
      chatBodies.push(await req.json() as typeof chatBodies[number]);
      const answer = `See § ${section.number.replace(/^§\s*/, "")}. <img src=x onerror="window.pwned=1"> [unsafe](javascript:window.pwned=1)`;
      const sources = [{ sourceType: "municipal_code", sectionGuid: section.guid, sectionNumber: section.number, sectionTitle: section.title, score: 1 }];
      const token = `event: token\ndata: ${JSON.stringify({ token: answer })}\n\n`;
      if (streamMode === "eof") return new Response(token, { headers: { ...cors, "Content-Type": "text/event-stream" } });
      const receipt = { status: "complete", answer, sources, evidence: { verifiedSupport: false } };
      return new Response(`event: sources\ndata: ${JSON.stringify(sources)}\n\n${token}event: done\ndata: ${JSON.stringify(receipt)}\n\n`, { headers: { ...cors, "Content-Type": "text/event-stream" } });
    }
    if (path.startsWith("/api/")) return Response.json({ signals: [] }, { headers: cors });
    const filePath = resolve("src/gui/static", path === "/" ? "index.html" : path.slice(1));
    if (!filePath.startsWith(resolve("src/gui/static") + "/") || !existsSync(filePath)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(filePath));
  } });
  const existingChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (existsSync(existingChrome) ? existingChrome : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  let passed = 0;
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const errors: string[] = [], externalRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(`http://127.0.0.1:${server.port}`)) externalRequests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.locator("#toc-tree button").first().waitFor();
    assert.equal(errors.length, 0, errors.join("\n")); assert.deepEqual(externalRequests, []); passed++;
    await page.locator("#search-input").fill("first"); await page.waitForTimeout(300);
    await page.locator("#search-input").fill("latest");
    await page.waitForFunction(() => document.querySelector("#search-results")?.textContent?.includes("Latest response"));
    await page.waitForTimeout(600); assert.equal(searchFirstFinished, true);
    assert.equal(await page.locator("#search-results").textContent().then(text => text!.includes("First delayed response")), false);
    await page.locator("#search-input").press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON");
    await page.keyboard.press("Enter"); await page.waitForFunction(() => document.querySelector("#content")?.textContent?.includes("Summarize"));
    await page.evaluate(html => { document.querySelector("#content")!.innerHTML += html; }, adversarialHtml);
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#content [srcset], #content [ping], #content [style*=background-image], #content [fill*=url]").count(), 0);
    assert.deepEqual(externalRequests, []);
    await page.locator("#search-input").fill("first"); await page.waitForTimeout(300); await page.locator("#search-input").fill(""); await page.waitForTimeout(750);
    assert.equal(await page.locator("#search-results").isVisible(), false); passed++;
    await page.locator("#chat-toggle").click(); await page.locator("#chat-input").fill("First question"); await page.locator("#chat-input").press("Enter");
    await page.waitForFunction(() => document.querySelector(".chat-status")?.textContent?.startsWith("Generated response"));
    assert.equal(await page.evaluate(() => Reflect.get(window, "pwned")), undefined);
    assert.equal(await page.locator(".chat-msg.assistant img, .chat-msg.assistant [onclick], .chat-msg.assistant a[href^='javascript:']").count(), 0);
    await page.locator("#chat-input").fill("Second question"); await page.locator("#chat-input").press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".chat-status").length === 2 && [...document.querySelectorAll(".chat-status")].every(item => item.textContent?.startsWith("Generated response")));
    assert.deepEqual(chatBodies[0]!.history, []); assert.equal(chatBodies[1]!.history.length, 2); assert.equal(chatBodies[1]!.history.some(turn => turn.content === "Second question"), false); passed++;
    streamMode = "eof"; await page.locator("#chat-input").fill("Incomplete question"); await page.locator("#chat-input").press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".chat-status")].at(-1)?.textContent?.includes("incomplete"));
    streamMode = "success"; await page.locator("#chat-input").fill("After failure"); await page.locator("#chat-input").press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".chat-status")].at(-1)?.textContent?.startsWith("Generated response"));
    assert.equal(chatBodies.at(-1)!.history.some(turn => turn.content === "Incomplete question"), false); passed++;
    await page.goto(`http://127.0.0.1:${server.port}/denied`);
    const frame = page.frameLocator("#denied-frame"); await frame.locator("#toc-tree button").first().waitFor();
    assert.equal(await frame.locator("body").evaluate(() => { try { localStorage.getItem("theme"); return false; } catch { return true; } }), true);
    await frame.locator("#theme-toggle").click(); assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
    await frame.locator("#chat-toggle").click(); assert.equal(await frame.locator("#chat-panel").getAttribute("class").then(value => value!.includes("open")), true); passed++;
    tocUnavailable = true; await page.goto(`http://127.0.0.1:${server.port}`);
    await page.locator('#toc-tree[data-state="unavailable"][aria-busy="false"]').waitFor();
    assert.equal(await page.locator("#toc-tree button").count(), 0);
    assert.equal(await page.locator("#toc-tree").textContent().then(text => text!.includes("Could not load the table of contents")), true);
    assert.equal(await page.locator("#search-input").isVisible(), true); passed++; tocUnavailable = false;
    requireKey = true; await page.goto(`http://127.0.0.1:${server.port}`);
    await page.locator("#api-credentials[open]").waitFor();
    await page.locator("#api-credentials-key").fill("fixture-memory-key"); await page.locator("#api-credentials-form button[type=submit]").click();
    assert.equal(await page.locator("#api-credentials-key").inputValue(), "");
    assert.equal(await page.evaluate(async () => (await Reflect.get(window, "CCGui").apiFetch("/api/health")).status), 200);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => String(localStorage.getItem(key)).includes("fixture-memory-key"))), false);
    const other = Bun.serve({ port: 0, fetch(req) { return Response.json({ receivedKey: req.headers.has("X-API-Key") }, { headers: cors }); } });
    try { assert.equal(await page.evaluate(async url => (await (await Reflect.get(window, "CCGui").apiFetch(url)).json()).receivedKey, `http://127.0.0.1:${other.port}/api/health`), false); }
    finally { other.stop(true); }
    await page.locator("#api-credentials-clear").click();
    assert.equal(await page.evaluate(async () => (await Reflect.get(window, "CCGui").apiFetch("/api/health")).status), 401); passed++;
    console.log(`GUI native browser journeys: ${passed} passed; executable=${executablePath ?? "Playwright-managed"}`);
    await context.close();
  } finally { await browser.close(); server.stop(true); }
}
if (import.meta.main) await runGuiJourneys();

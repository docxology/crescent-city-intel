/**
 * String-contract tests for the GUI chat-history and error-banner rework.
 * The SPA's markup lives in src/gui/static/index.html and its JS in
 * src/gui/static/assets/modules/*.js (v2.7.0 asset split: the former inline
 * <script> block was relocated verbatim, load order preserved). These tests
 * lock that the multi-turn history and error banner wiring stay present.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(process.cwd(), "src", "gui", "static", "index.html"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "gui", "routes.ts"), "utf-8");
const moduleDir = join(process.cwd(), "src", "gui", "static", "assets", "modules");
const core = readFileSync(join(moduleDir, "10-core.js"), "utf-8");
const chat = readFileSync(join(moduleDir, "50-chat.js"), "utf-8");

describe("GUI chat-history wiring", () => {
  test("the chat tracks a history array and sends it with each request", () => {
    expect(core).toContain("const chatHistory = [];");
    expect(chat).toContain("history: chatHistory");
    expect(chat).toContain('chatHistory.push({ role: "user"');
    expect(chat).toContain('chatHistory.push({ role: "assistant"');
  });

  test("the server chat routes accept a bounded history field", () => {
    expect(routes).toContain("body.history");
    expect(routes).toContain("history?: Array");
  });
});

describe("GUI error banner", () => {
  test("a top-of-page error banner element and helper exist and apiFetch surfaces network failures", () => {
    expect(html).toContain('id="error-banner"');
    expect(core).toContain('function showErrorBanner(');
    expect(core).toContain('showErrorBanner("Network error reaching the server: "');
  });

  test("index.html references the extracted core and chat modules in load order", () => {
    expect(html).toContain('<script src="assets/modules/10-core.js"></script>');
    expect(html).toContain('<script src="assets/modules/50-chat.js"></script>');
    expect(html.indexOf("10-core.js")).toBeLessThan(html.indexOf("50-chat.js"));
  });
});
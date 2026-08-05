/**
 * String-contract tests for the GUI chat-history and error-banner rework.
 * The SPA (src/gui/static/index.html) is validated by string presence because
 * it is a browser app not exercised by the deterministic suite; these tests
 * lock that the multi-turn history and error banner wiring stay present.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(process.cwd(), "src", "gui", "static", "index.html"), "utf-8");
const routes = readFileSync(join(process.cwd(), "src", "gui", "routes.ts"), "utf-8");

describe("GUI chat-history wiring", () => {
  test("the chat tracks a history array and sends it with each request", () => {
    expect(html).toContain("const chatHistory = [];");
    expect(html).toContain("history: chatHistory");
    expect(html).toContain('chatHistory.push({ role: "user"');
    expect(html).toContain('chatHistory.push({ role: "assistant"');
  });

  test("the server chat routes accept a bounded history field", () => {
    expect(routes).toContain("body.history");
    expect(routes).toContain("history?: Array");
  });
});

describe("GUI error banner", () => {
  test("a top-of-page error banner element and helper exist and apiFetch surfaces network failures", () => {
    expect(html).toContain('id="error-banner"');
    expect(html).toContain('function showErrorBanner(');
    expect(html).toContain('showErrorBanner("Network error reaching the server: "');
  });
});

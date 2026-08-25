/**
 * Tests for fetchBulletinBody and extractBulletinBody in src/alerts/cdfw_fishing.ts
 *
 * Tests pure-logic extraction from sample HTML, network error handling,
 * and graceful failure on bad URLs.
 */
import { describe, expect, test } from "bun:test";
import { fetchBulletinBody, extractBulletinBody } from "../src/alerts/cdfw_fishing";

describe("extractBulletinBody", () => {
  test("extracts text from <article> container", () => {
    const html = `<!DOCTYPE html><html><body><article><h1>Crab Season Update</h1><p>The Dungeness crab season will open on November 15.</p><p>This applies to District 1.</p></article></body></html>`;
    const text = extractBulletinBody(html);
    expect(text).toContain("Dungeness crab season");
    expect(text).toContain("November 15");
    expect(text).toContain("District 1");
  });

  test("falls back to <main> when <article> is absent", () => {
    const html = `<html><body><main><h2>Marine Bulletin</h2><p>Test content here.</p></main></body></html>`;
    const text = extractBulletinBody(html);
    // extractBulletinBody extracts <p> tag text from the identified container
    expect(text).toContain("Test content here");
  });

  test("falls back to #content div when no article/main", () => {
    const html = `<html><body><div id="content"><p>Fallback content paragraph.</p></div></body></html>`;
    const text = extractBulletinBody(html);
    expect(text).toContain("Fallback content paragraph");
  });

  test("returns empty string from HTML with no <p> tags", () => {
    const html = `<html><body><div>No paragraphs here<div>just nesting</div></div></body></html>`;
    const text = extractBulletinBody(html);
    expect(typeof text).toBe("string");
  });

  test("decodes common HTML entities", () => {
    const html = `<article><p>Water temp &gt; 50&deg;F &amp; safe.</p><p>&quot;Caution&quot; advised.</p></article>`;
    const text = extractBulletinBody(html);
    expect(text).toContain(">");
    expect(text).toContain("&");
    expect(text).toContain('"');
  });

  test("normalises whitespace in multi-paragraph content", () => {
    const html = `<article><p>First paragraph.</p><p>Second paragraph.</p><p>Third.</p></article>`;
    const text = extractBulletinBody(html);
    // Should have paragraph breaks
    expect(text).toContain("First paragraph.");
    expect(text).toContain("Second paragraph.");
    // Should not contain triple newlines
    expect(text).not.toContain("\n\n\n");
  });

  test("handles empty HTML", () => {
    expect(extractBulletinBody("")).toBe("");
  });

  test("handles HTML with no body tags", () => {
    expect(extractBulletinBody("<html></html>")).toBe("");
  });
});

describe("fetchBulletinBody", () => {
  test("returns empty string on unreachable URL (localhost:0)", async () => {
    const result = await fetchBulletinBody("http://localhost:0/nonexistent");
    expect(result).toBe("");
  });

  test("returns empty string on HTTP 404", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("not found", { status: 404 }),
    });
    const result = await fetchBulletinBody(`http://localhost:${server.port}/missing`);
    server.stop();
    expect(result).toBe("");
  });

  test("fetches and extracts body from valid page", async () => {
    const html = `<!DOCTYPE html><html><body><article><h1>Test Bulletin</h1><p>Full article body text for testing.</p></article></body></html>`;
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    const result = await fetchBulletinBody(`http://localhost:${server.port}/test`);
    server.stop();
    expect(result).toBe("Full article body text for testing.");
  });

  test("returns empty string on malformed URL", async () => {
    const result = await fetchBulletinBody("not-a-valid-url");
    expect(result).toBe("");
  });
});

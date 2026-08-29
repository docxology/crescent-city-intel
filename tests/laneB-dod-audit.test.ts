import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { computeDeclaredValue, parseCssRules } from "../src/pages_css.ts";
import { join } from "path";

// Lane B r2 — Definition-of-done regression gate (browser-audited items):
// these assertions lock the structure that a real-browser audit (Playwright +
// axe-core 4.10.3, Lighthouse 13.4.1 mobile) verified on 2026-08-28. They keep
// the static contract from regressing between browser audits; the audit harness
// and measured numbers live in the lane B report.
//
// Locked contracts:
//  B2  axe-core zero critical/serious (structure: focusable scrollable regions)
//  B3  no horizontal overflow (per-container .table-scroll/.scroll-x wrappers;
//       the old html,body overflow-x backstop was removed in r3 — it pinned sticky)
//  B4  first-load transfer < 150 KB excl. fonts (all 7 content pages lazily
//      fetch data; index fetches only data/snapshot.json + geo view)
//  B5  keyboard: skip link is the first tab stop with a focus rule
//  B6  boot: every page script wraps in __bootPage so the deferred shared
//      site.js executes before the page script runs (no ReferenceError)

const PAGE_FILES = ["index.html", "gui.html", "news.html", "meetings.html", "events.html", "code.html", "sources.html", "404.html"];

describe("lane B r2: definition-of-done regression gate", () => {
  test("every page script is wrapped in a __bootPage DOMContentLoaded-aware boot", async () => {
    for (const file of PAGE_FILES) {
      const html = await readFile(join("src/pages/static", file), "utf8");
      if (!html.includes("    <script>") && !html.includes("  <script>")) continue; // 404.html ships no page script
      expect(html).toContain("__bootPage");
      expect(html).toContain("DOMContentLoaded");
    }
  });

  test("index.html does not redeclare shared site.js prelude symbols", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    expect(html).not.toContain("const FETCH_TIMEOUT_MS");
    expect(html).not.toContain("async function load(");
    const shared = await readFile("src/pages/static/assets/site.js", "utf8");
    expect(shared).toContain("const FETCH_TIMEOUT_MS");
    expect(shared).toContain("async function load(path)");
  });

  test("scrollable regions are keyboard-focusable with region semantics (axe scrollable-region-focusable)", async () => {
    const index = await readFile("src/pages/static/index.html", "utf8");
    const tableScrolls = (index.match(/class="table-scroll"/g) ?? []).length;
    const focusableScrolls = (index.match(/class="table-scroll" tabindex="0" role="region" aria-label="/g) ?? []).length;
    expect(tableScrolls).toBeGreaterThan(0);
    expect(focusableScrolls).toBe(tableScrolls);
    expect(index).toContain('id="geo-sections" class="geo-sections" tabindex="0" role="region"');
    expect(index).not.toMatch(/<pre>(?![\s\S]*tabindex)/);
    const sources = await readFile("src/pages/static/sources.html", "utf8");
    expect(sources).toContain('class="table-scroll" tabindex="0" role="region"');
  });

  test("fonts stylesheet ships preloaded with display=swap and a preconnect pair (render-blocking measured better than async FOUT: CLS 0 vs 0.33)", async () => {
    for (const file of PAGE_FILES) {
      const html = await readFile(join("src/pages/static", file), "utf8");
      expect(html).toMatch(/<link rel="preload" as="style" href="https:\/\/fonts\.googleapis\.com[^"]*display=swap">/);
      expect(html).toMatch(/<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet">/);
      expect(html).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
      expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    }
  });

  // Lane 4 r3 (P1-A): B3 is still "no horizontal overflow", but the global
  // `html, body { overflow-x:hidden }` backstop is the wrong instrument for it.
  // It makes the root a scroll container, which pins every position:sticky
  // descendant — the calendar month datelines never travelled. The invariant is
  // now stated as its two real halves: the root must not scroll, and every wide
  // element must sit in its own scroll wrapper.
  test("no root scroll container, and wide content scrolls in its own wrapper (no horizontal overflow)", async () => {
    const shared = await readFile("src/pages/static/assets/site.css", "utf8");
    const rules = parseCssRules(shared);
    for (const root of ["html", "body"]) {
      expect(computeDeclaredValue(rules, [{ tag: root }], "overflow-x")).toBeNull();
    }
    expect(computeDeclaredValue(rules, [{ tag: "div", classes: ["table-scroll"] }], "overflow-x")?.value).toBe("auto");
    expect(computeDeclaredValue(rules, [{ tag: "div", classes: ["scroll-x"] }], "overflow-x")?.value).toBe("auto");
    // Every <table> the pages emit must be inside one of those wrappers.
    for (const file of ["index.html", "gui.html", "sources.html", "assets/site.js"]) {
      const source = await readFile(join("src/pages/static", file), "utf8");
      for (const index of [...source.matchAll(/<table[\s>]/g)].map(match => match.index ?? 0)) {
        const preceding = source.slice(Math.max(0, index - 400), index);
        expect(/class="(table-scroll|scroll-x)[^"]*"/.test(preceding)).toBe(true);
      }
    }
  });

  test("skip link is the first tab stop with a visible focus rule (keyboard traversal contract)", async () => {
    for (const file of PAGE_FILES) {
      const html = await readFile(join("src/pages/static", file), "utf8");
      const skipIndex = html.indexOf('class="skip-link"');
      expect(skipIndex).toBeGreaterThan(-1);
      const scriptIndex = html.indexOf("<script>");
      if (scriptIndex !== -1) expect(skipIndex).toBeLessThan(scriptIndex);
    }
    const shared = await readFile("src/pages/static/assets/site.css", "utf8");
    expect(shared).toContain(".skip-link:focus");
  });

  test("page aria-labels contain their visible label text (WCAG 2.5.3 label-in-name)", async () => {
    for (const file of ["index.html", "gui.html", "events.html"]) {
      const html = await readFile(join("src/pages/static", file), "utf8");
      expect(html).toMatch(/aria-label="Subscribe \u00b7 \.ics \u2014 Crescent City community events calendar in iCalendar format"/);
    }
  });
});

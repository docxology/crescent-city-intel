import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";

const BANNED_VARS = ["--red", "--blue", "--gold", "--green", "--purple"];
const REQUIRED_VARS = ["--cc", "--rdark", "--rtint", "--ink", "--paper"];

function styleBlock(html: string): string {
  const match = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!match || !match[1]) throw new Error("no <style> block found");
  return match[1];
}

describe("Newspaper theme contracts (Pages index)", () => {
  test("palette custom properties exist in the Pages index style block", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    const css = styleBlock(html);
    for (const name of REQUIRED_VARS) {
      expect(css).toContain(`${name}:`);
    }
  });

  test("banned bright palette variable names are absent from the Pages index", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    for (const banned of BANNED_VARS) {
      expect(html.includes(banned)).toBe(false);
    }
  });

  test("print media query is present with texture suppression and article rules", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    const css = styleBlock(html);
    expect(css).toContain("@media print");
    const printStart = css.indexOf("@media print");
    // crude brace-balance scan to extract the print block
    let depth = 0;
    let end = -1;
    for (let i = printStart; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(printStart);
    const block = css.slice(printStart, end + 1);
    expect(block).toContain("body::before { display:none!important; }");
    expect(block).toContain("break-inside:avoid;");
    expect(block).toContain("font-size:11pt;");
  });

  test("CSS-only paper grain texture exists without network image fetches", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    const css = styleBlock(html);
    expect(css).toContain("body::before");
    expect(css).toContain("repeating-linear-gradient");
    expect(css.includes("url(http")).toBe(false);
  });

  test("community calendar column styles use dateline separators", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    const css = styleBlock(html);
    expect(css).toContain(".cal-dateline");
    expect(css).toContain(".cal-entry");
    expect(html).toContain("data-month-header");
    expect(html).toContain("eventMonthKey(event)");
    expect(html).toContain('class="cal-dateline"');
  });

  test("mobile 375px usability: masthead, nav, events adapt under 480px", async () => {
    const html = await readFile("src/pages/static/index.html", "utf8");
    const css = styleBlock(html);
    expect(css).toContain("@media (max-width:480px)");
    expect(css).toContain(".masthead-nav { flex-wrap:nowrap; justify-content:flex-start; }");
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
  });
});

describe("Shared newspaper palette vars (GUI surfaces)", () => {
  test("GUI index defines --cc/--rdark/--rtint in light theme and no banned names", async () => {
    const html = await readFile("src/gui/static/index.html", "utf8");
    for (const name of ["--cc:", "--rdark:", "--rtint:"]) {
      expect(html).toContain(name);
    }
    for (const banned of BANNED_VARS) {
      expect(html.includes(banned)).toBe(false);
    }
  });

  test("docs page defines shared palette variables", async () => {
    const html = await readFile("src/gui/static/docs.html", "utf8");
    const css = styleBlock(html);
    for (const name of REQUIRED_VARS) {
      expect(css).toContain(`${name}:`);
    }
    for (const banned of BANNED_VARS) {
      expect(html.includes(banned)).toBe(false);
    }
  });
});

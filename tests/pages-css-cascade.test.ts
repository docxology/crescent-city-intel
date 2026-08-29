/**
 * Lane 4 r3 — negative controls for the CSS gate.
 *
 * Every assertion added to scripts/validate-pages.ts by this lane is exercised
 * twice here: once against the real stylesheets (it passes) and once against a
 * deliberately mutated copy (it fails). An assertion that cannot fail is not a
 * gate, and the two defects this lane fixed both survived assertions that could
 * not fail — a `css.includes("#event-items .cal-dateline { position:sticky")`
 * string check over a rule that was present and inert, and no brace check at
 * all over a stylesheet whose print block was nested inside an unclosed media
 * query.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import {
  auditPagesCss,
  auditStylesheetBraces,
  computeDeclaredValue,
  cssBraceBalance,
  parseCssRules,
  selectorMatches,
  specificity,
  splitTopLevel,
  type PageCssInput,
} from "../src/pages_css.ts";

const SITE_CSS = "src/pages/static/assets/site.css";
const INDEX_CSS = "src/pages/static/assets/index.css";
const CSS_404 = "src/pages/static/assets/404.css";

async function siteCss(): Promise<string> { return readFile(SITE_CSS, "utf8"); }
async function indexCss(): Promise<string> { return readFile(INDEX_CSS, "utf8"); }

/** The page shapes the gate resolves the cascade against. */
async function realInputs(): Promise<PageCssInput[]> {
  const site = await siteCss();
  const index = await indexCss();
  return [
    { page: "index.html", css: site + index, hasEventList: true, hasTableScroll: true },
    { page: "events.html", css: site, hasEventList: true, hasTableScroll: false },
    { page: "gui.html", css: site, hasEventList: true, hasTableScroll: true },
    { page: "sources.html", css: site, hasEventList: false, hasTableScroll: true },
    { page: "news.html", css: site, hasEventList: false, hasTableScroll: false },
  ];
}

describe("CSS parser and cascade resolver", () => {
  test("splitTopLevel does not break selector lists inside parentheses", () => {
    expect(splitTopLevel(".a, .b")).toEqual([".a", ".b"]);
    expect(splitTopLevel("clip:rect(0,0,0,0); border:0", ";")).toEqual(["clip:rect(0,0,0,0)", "border:0"]);
    expect(splitTopLevel('a[href="x,y"], b')).toEqual(['a[href="x,y"]', "b"]);
  });

  test("specificity orders id over class over type", () => {
    expect(specificity("#a")).toEqual([1, 0, 0]);
    expect(specificity(".a.b")).toEqual([0, 2, 0]);
    expect(specificity("ol li")).toEqual([0, 0, 2]);
    expect(specificity('a[aria-current="page"]')).toEqual([0, 1, 1]);
  });

  test("selectorMatches honours descendant and child combinators", () => {
    const path = [{ tag: "html" }, { tag: "body" }, { tag: "ol", id: "event-items", classes: ["items"] }, { tag: "li", classes: ["cal-dateline"] }];
    expect(selectorMatches("#event-items .cal-dateline", path)).toBe(true);
    expect(selectorMatches("#event-items > .cal-dateline", path)).toBe(true);
    expect(selectorMatches("body > .cal-dateline", path)).toBe(false);
    expect(selectorMatches(".cal-dateline", path)).toBe(true);
    expect(selectorMatches("#other .cal-dateline", path)).toBe(false);
  });

  test("state pseudo-classes never match the resolved default state", () => {
    const rules = parseCssRules(".x { color:black; } .x:hover { color:red; }");
    expect(computeDeclaredValue(rules, [{ tag: "div", classes: ["x"] }], "color")?.value).toBe("black");
  });

  test("later rule wins at equal specificity, higher specificity wins over order", () => {
    const rules = parseCssRules(".x { color:a; } .x { color:b; }");
    expect(computeDeclaredValue(rules, [{ tag: "div", classes: ["x"] }], "color")?.value).toBe("b");
    const mixed = parseCssRules("#x { color:id; } .x { color:cls; }");
    expect(computeDeclaredValue(mixed, [{ tag: "div", id: "x", classes: ["x"] }], "color")?.value).toBe("id");
  });

  test("!important outranks specificity and order", () => {
    const rules = parseCssRules("#x { color:id; } .x { color:cls !important; }");
    expect(computeDeclaredValue(rules, [{ tag: "div", id: "x", classes: ["x"] }], "color")?.value).toBe("cls");
  });

  test("media-gated rules are excluded from the unconditional baseline", () => {
    const rules = parseCssRules(".x { color:base; } @media (max-width:480px) { .x { color:small; } }");
    expect(computeDeclaredValue(rules, [{ tag: "div", classes: ["x"] }], "color")?.value).toBe("base");
    const small = computeDeclaredValue(rules, [{ tag: "div", classes: ["x"] }], "color", { mediaApplies: condition => condition === "(max-width:480px)" });
    expect(small?.value).toBe("small");
  });

  test("nested at-rules carry the conjunction of their conditions", () => {
    const rules = parseCssRules("@media (max-width:480px) { @media print { .x { color:c; } } }");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.media).toEqual(["(max-width:480px)", "print"]);
  });

  test("shorthands expand to the longhands a computed query asks for", () => {
    const rules = parseCssRules("ol { list-style:none; padding:0 4px; overflow:hidden auto; }");
    const element = [{ tag: "ol" }];
    expect(computeDeclaredValue(rules, element, "list-style-type")?.value).toBe("none");
    expect(computeDeclaredValue(rules, element, "padding-inline-start")?.value).toBe("4px");
    expect(computeDeclaredValue(rules, element, "overflow-x")?.value).toBe("hidden");
    expect(computeDeclaredValue(rules, element, "overflow-y")?.value).toBe("auto");
  });
});

describe("Brace-balance gate (P0.8)", () => {
  test("every authored stylesheet is balanced", async () => {
    for (const file of [SITE_CSS, INDEX_CSS, CSS_404]) {
      const css = await readFile(file, "utf8");
      expect(auditStylesheetBraces(file, css)).toEqual([]);
    }
  });

  // Negative control: the exact defect shape found at 004b528 — the 480px media
  // block never closed, so `@media print` parsed as `print AND max-width:480px`.
  test("an unclosed media block is reported, and its print rules are shown to be dead", () => {
    const broken = "@media (max-width:480px) { body { font-size:16px; }\n@media print { body { background:#fff; } }";
    const problems = auditStylesheetBraces("broken.css", broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("never close");
    const printRules = parseCssRules(broken).filter(rule => rule.media.includes("print"));
    expect(printRules).toHaveLength(1);
    expect(printRules[0]!.media).toEqual(["(max-width:480px)", "print"]);
    // Under a plain print media context those rules do not apply at all.
    expect(computeDeclaredValue(parseCssRules(broken), [{ tag: "body" }], "background", { mediaApplies: condition => condition === "print" })).toBeNull();
  });

  test("a stray closing brace is reported separately", () => {
    const problems = auditStylesheetBraces("stray.css", "body { color:red; } }");
    expect(problems.some(problem => problem.includes("stray closing brace"))).toBe(true);
  });

  test("the real index.css print block resolves under a plain print context", async () => {
    const rules = parseCssRules(await indexCss());
    const printRules = rules.filter(rule => rule.media.some(condition => condition.trim() === "print"));
    expect(printRules.length).toBeGreaterThan(0);
    for (const rule of printRules) expect(rule.media).toEqual(["print"]);
    expect(computeDeclaredValue(rules, [{ tag: "html" }, { tag: "body" }], "background", { mediaApplies: condition => condition === "print" })?.value).toBe("#fff");
  });
});

describe("Per-page CSS contract (P0.2 split by consumption)", () => {
  test("the shipped stylesheets satisfy the contract on every page shape", async () => {
    expect(auditPagesCss(await realInputs())).toEqual([]);
  });

  // Negative control for P0.2 itself: put `.meta` back where R2 found it —
  // in the index-only stylesheet — and every other page must fail.
  test("a shared rule living only in index.css fails on the pages that load only site.css", async () => {
    const site = await siteCss();
    const withoutMeta = site.replace(/^\.meta \{[^}]*\}$/m, "");
    expect(withoutMeta).not.toBe(site);
    const problems = auditPagesCss([
      { page: "events.html", css: withoutMeta, hasEventList: true, hasTableScroll: false },
      { page: "index.html", css: withoutMeta + (await indexCss()) + "\n.meta { font:.74rem/1.4 Inter,sans-serif; color:var(--ink-faint); }", hasEventList: true, hasTableScroll: true },
    ]);
    expect(problems.some(problem => problem.startsWith("events.html") && problem.includes(".meta"))).toBe(true);
    expect(problems.some(problem => problem.startsWith("index.html") && problem.includes(".meta"))).toBe(false);
  });

  test("a page that renders .table-scroll but loads no rule for it fails", async () => {
    const site = (await siteCss()).replace(".table-scroll, .scroll-x { overflow-x:auto; -webkit-overflow-scrolling:touch; margin:8px 0; }", "");
    const problems = auditPagesCss([{ page: "sources.html", css: site, hasEventList: false, hasTableScroll: true }]);
    expect(problems.some(problem => problem.includes("horizontal scroll container"))).toBe(true);
  });
});

describe("Calendar layout contract (P0.9 list reset, P1-A sticky travel)", () => {
  test("restoring the global overflow-x backstop fails the gate", async () => {
    const site = (await siteCss()) + "\nhtml, body { overflow-x:hidden; }";
    const problems = auditPagesCss([{ page: "events.html", css: site, hasEventList: true, hasTableScroll: false }]);
    expect(problems.filter(problem => problem.includes("pins every position:sticky descendant"))).toHaveLength(2);
  });

  test("returning #event-items to display:grid fails the sticky-travel check", async () => {
    const site = (await siteCss()) + "\n#event-items.items { display:grid; }";
    const problems = auditPagesCss([{ page: "events.html", css: site, hasEventList: true, hasTableScroll: false }]);
    expect(problems.some(problem => problem.includes("zero travel"))).toBe(true);
  });

  test("dropping the list reset fails with the UA decimal/indent defect named", async () => {
    const site = (await siteCss()).replace(".items { list-style:none; margin:0; padding:0; }", "");
    const problems = auditPagesCss([{ page: "events.html", css: site, hasEventList: true, hasTableScroll: false }]);
    expect(problems.some(problem => problem.includes("list-style-type"))).toBe(true);
    expect(problems.some(problem => problem.includes("padding-inline-start"))).toBe(true);
  });

  test("dropping position:sticky or its inset fails", async () => {
    const site = await siteCss();
    const noSticky = site.replace("#event-items .cal-dateline { position:sticky; top:0; z-index:5; }", "");
    expect(auditPagesCss([{ page: "events.html", css: noSticky, hasEventList: true, hasTableScroll: false }])
      .some(problem => problem.includes("month headers are not sticky"))).toBe(true);
    const noInset = site.replace("#event-items .cal-dateline { position:sticky; top:0; z-index:5; }", "#event-items .cal-dateline { position:sticky; z-index:5; }");
    expect(auditPagesCss([{ page: "events.html", css: noInset, hasEventList: true, hasTableScroll: false }])
      .some(problem => problem.includes("no inset"))).toBe(true);
  });

  test("pages without an event list are not held to the calendar contract", async () => {
    const site = (await siteCss()).replace(".items { list-style:none; margin:0; padding:0; }", "");
    expect(auditPagesCss([{ page: "news.html", css: site, hasEventList: false, hasTableScroll: false }])).toEqual([]);
  });
});

describe("cssBraceBalance reports counts, not just a verdict", () => {
  test("counts open and close braces and the depth left open", () => {
    expect(cssBraceBalance("a { b:c; }")).toEqual({ open: 1, close: 1, finalDepth: 0, minDepth: 0, balanced: true });
    expect(cssBraceBalance("/* } */ a { b:c; }").balanced).toBe(true);
    expect(cssBraceBalance("a { b:c;").finalDepth).toBe(1);
  });
});

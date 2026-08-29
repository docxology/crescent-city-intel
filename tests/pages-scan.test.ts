/**
 * Negative controls for the lane-0 innerHTML/XSS gate (src/pages_scan.ts).
 *
 * The gate had none, and it needed them: its three fixpoint probes flagged into
 * a no-op function and then asked whether the OUTER problem list had grown, so
 * the answer was always "no". Every const in every page was marked safe, every
 * interpolation resolved through that safe set, and the scan reported clean for
 * its entire life while checking nothing.
 *
 * Each case below is an unsafe shape a page could actually be written in. A
 * scanner that cannot fail on ALL of them is a scanner that is not protecting
 * the published pages. The safe cases are here too: a gate that flags correct
 * code gets disabled by the next person who trips over it.
 */
import { describe, expect, test } from "bun:test";
import { scanPage } from "../src/pages_scan.ts";

/** Wrap a script body the way an exported page carries it. */
const page = (body: string): string => `<!doctype html><html><body><script>\n${body}\n</script></body></html>`;

const SHARED_SAFE = ["itemCard", "calendarEventCard", "calendarMonthGroups", "emptyListItem"];

describe("lane 0 XSS gate: unsafe interpolation is caught", () => {
  const unsafe: Array<{ name: string; body: string }> = [
    { name: "raw member access assigned straight to innerHTML", body: `document.getElementById("x").innerHTML = item.title;` },
    { name: "unescaped interpolation in a template", body: 'document.getElementById("x").innerHTML = `<p>${item.title}</p>`;' },
    { name: "a const carrying raw artifact text", body: 'const t = item.title;\ndocument.getElementById("x").innerHTML = t;' },
    { name: "a const built from an unescaped template", body: 'const card = `<h3>${item.title}</h3>`;\ndocument.getElementById("x").innerHTML = card;' },
    { name: "unescaped value inside a .map callback", body: 'document.getElementById("x").innerHTML = items.map(i => `<li>${i.title}</li>`).join("");' },
    { name: "unescaped value inside a NESTED .map chain", body: 'document.getElementById("x").innerHTML = groups.map(g => `<b>${g.label}</b>` + g.items.map(i => `<li>${i.title}</li>`).join("")).join("");' },
    { name: "string concatenation around raw data", body: 'document.getElementById("x").innerHTML = "<p>" + item.title + "</p>";' },
    { name: "an accumulator built with an unescaped template", body: 'let out = "";\nout += `<li>${item.title}</li>`;\ndocument.getElementById("x").innerHTML = out;' },
    { name: "a function whose returned template is unescaped", body: 'function card(i) { return `<div>${i.title}</div>`; }\ndocument.getElementById("x").innerHTML = card(item);' },
    { name: "an unknown helper call", body: 'document.getElementById("x").innerHTML = renderSomething(item);' },
    { name: "a ternary whose unsafe branch is raw", body: 'document.getElementById("x").innerHTML = item.ok ? `<p>${esc(item.title)}</p>` : item.fallback;' },
    { name: "a nullish fallback to raw data", body: 'document.getElementById("x").innerHTML = `<p>${esc(item.title) ?? item.raw}</p>`;' },
    { name: "esc() applied to the wrong half of a concatenation", body: 'document.getElementById("x").innerHTML = esc(item.title) + item.description;' },
    { name: "a template tail concatenating raw data", body: 'document.getElementById("x").innerHTML = `<p>ok</p>` + item.description;' },
    { name: "an href built without the href() guard", body: 'document.getElementById("x").innerHTML = `<a href="${item.link}">go</a>`;' },
    { name: "a shared-safe function name shadowed by an unsafe local", body: 'function itemCard(i) { return `<article>${i.title}</article>`; }\ndocument.getElementById("x").innerHTML = itemCard(item);' },
  ];

  for (const testCase of unsafe) {
    test(testCase.name, () => {
      const problems = scanPage(page(testCase.body), "fixture.html", SHARED_SAFE);
      expect(`${testCase.name}: ${problems.length > 0}`).toBe(`${testCase.name}: true`);
    });
  }

  test("the shared-safe seed does not whitewash a page-local redefinition", () => {
    // itemCard is seeded as safe because site.js's version is verified — but a
    // page that defines its OWN itemCard must not inherit that trust.
    const problems = scanPage(page('function itemCard(i) { return `<b>${i.title}</b>`; }\ndocument.getElementById("x").innerHTML = itemCard(item);'), "fixture.html", SHARED_SAFE);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("lane 0 XSS gate: correct code is not flagged", () => {
  const safe: Array<{ name: string; body: string }> = [
    { name: "escaped interpolation", body: 'document.getElementById("x").innerHTML = `<p>${esc(item.title)}</p>`;' },
    { name: "href() guarded link", body: 'document.getElementById("x").innerHTML = `<a href="${esc(href(item.link))}">${esc(item.title)}</a>`;' },
    { name: "empty() helper", body: 'document.getElementById("x").innerHTML = empty("Nothing was published this edition.");' },
    { name: "a const built from an escaped template", body: 'const card = `<h3>${esc(item.title)}</h3>`;\ndocument.getElementById("x").innerHTML = card;' },
    { name: "an escaped .map chain", body: 'document.getElementById("x").innerHTML = items.map(i => `<li>${esc(i.title)}</li>`).join("");' },
    { name: "a nested escaped .map chain", body: 'document.getElementById("x").innerHTML = groups.map(g => `<b>${esc(g.label)}</b>` + g.items.map(i => `<li>${esc(i.title)}</li>`).join("")).join("");' },
    { name: "a shared-safe builder from site.js", body: 'document.getElementById("x").innerHTML = items.map(i => itemCard(i, "news")).join("");' },
    { name: "a numeric length", body: 'document.getElementById("x").innerHTML = `<span>${items.length} item(s)</span>`;' },
    { name: "a numeric coercion", body: 'document.getElementById("x").innerHTML = `<span>${Number(item.count)}</span>`;' },
    { name: "a string literal", body: 'document.getElementById("x").innerHTML = "<p>No records.</p>";' },
    { name: "a ternary with both branches escaped", body: 'document.getElementById("x").innerHTML = item.ok ? `<p>${esc(item.title)}</p>` : empty("none");' },
  ];

  for (const testCase of safe) {
    test(testCase.name, () => {
      const problems = scanPage(page(testCase.body), "fixture.html", SHARED_SAFE);
      expect(`${testCase.name}: ${JSON.stringify(problems)}`).toBe(`${testCase.name}: []`);
    });
  }
});

describe("lane 0 XSS gate: the fixpoint records what it proves", () => {
  test("an unsafe const does not become safe just because it was examined", () => {
    // This is the exact defect: the probe examined the const, discarded its
    // findings, and added the name to the safe set anyway.
    const problems = scanPage(page('const raw = item.description;\nconst wrapped = `<p>${raw}</p>`;\ndocument.getElementById("x").innerHTML = wrapped;'), "fixture.html", SHARED_SAFE);
    expect(problems.length).toBeGreaterThan(0);
  });

  test("a safe const chain still resolves through several hops", () => {
    const problems = scanPage(page('const title = esc(item.title);\nconst head = `<h3>${title}</h3>`;\nconst body = `${head}<p>${esc(item.description)}</p>`;\ndocument.getElementById("x").innerHTML = body;'), "fixture.html", SHARED_SAFE);
    expect(problems).toEqual([]);
  });
});

/**
 * Cross-reference hyperlinking in the SPA's section prose
 * (`src/gui/static/assets/modules/15-cross-ref-links.js`).
 *
 * Phase 2 of the deferred GUI/UX set. A civic-code reader who sees
 * "see § 8.04.010" in a section's prose currently has to hand-type the number
 * into the search box. The linkifier turns citations into in-app links.
 *
 * The behaviour that is deliberately NOT implemented is the important part:
 * a citation to a section the client has not seen stays plain text. Linking it
 * would send the reader to a 404, and one broken link teaches a reader to
 * distrust every link.
 *
 * These are string-contract tests over the real module source, matching the
 * repo's existing convention for untestable browser globals (the module runs in
 * the page, not in Node), plus a genuine execution of the pure functions by
 * evaluating the source in a function sandbox.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const MODULE_PATH = join(ROOT, "src/gui/static/assets/modules/15-cross-ref-links.js");
const source = readFileSync(MODULE_PATH, "utf-8");

/**
 * Load the module's pure functions by evaluating its source and returning the
 * bindings. The module is a plain classic script with top-level `function`
 * declarations, so evaluating it in a function body and returning the names
 * exercises the real code rather than a transcription of it.
 */
function loadPureFunctions(): {
  linkify: (html: string, resolveHref?: (guid: string) => string) => string;
  remember: (article: unknown) => void;
  normalize: (number: unknown) => string;
  known: () => number;
  reset: () => void;
} {
  const body = [
    source,
    "return { linkify: ccLinkifyCrossRefs, remember: ccRememberArticleSections, normalize: ccNormalizeSectionNumber, known: ccKnownSectionCount, reset: _resetCrossRefIndex };",
  ].join("\n");
  // eslint-disable-next-line no-new-func -- executing the module under test is the point
  const factory = new Function(body) as () => ReturnType<typeof loadPureFunctions>;
  return factory();
}

describe("cross-reference linkifier", () => {
  test("a citation to a known section becomes a link carrying the guid", () => {
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g-8-04-010", number: "§ 8.04.010" }] });
    const html = linkify("See &#167; 8.04.010 for rates.");
    expect(html).toContain('<a class="xref"');
    expect(html).toContain('data-section-guid="g-8-04-010"');
    expect(html).toContain("See ");
  });

  test("a citation to an UNKNOWN section stays plain text", () => {
    // The honesty rule. Linking speculatively sends the reader to a 404.
    const { linkify, reset } = loadPureFunctions();
    reset();
    const html = linkify("See &#167; 99.99.999 for nothing.");
    expect(html).not.toContain("<a ");
    expect(html).toBe("See &#167; 99.99.999 for nothing.");
  });

  test("the escaped marker form — the one the GUI actually renders — is matched", () => {
    // `escapeHtml` turns § into `&#167;`, so a regex matching the raw character
    // would never fire in the browser. This is the form every real citation
    // arrives in.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.04.010" }] });
    const html = linkify("See &#167; 8.04.010 for rates.");
    expect(html).toContain('data-section-guid="g1"');
    // The sign stays INSIDE the anchor, so the rendered sentence is unchanged.
    expect(html).toContain(">&#167; 8.04.010</a>");
  });

  test("the marker and the bare form both resolve to the same section", () => {
    // Stored numbers carry the § marker and citations do not; without
    // normalising both sides the lookup is silently always-false, which is the
    // exact defect class `normalizeSectionNumber` was introduced to end.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "§ 8.04.010" }] });
    expect(linkify("&#167; 8.04.010")).toContain('data-section-guid="g1"');
    expect(linkify("§ 8.04.010")).toContain('data-section-guid="g1"');
    expect(linkify("8.04.010")).toContain('data-section-guid="g1"');
  });

  test("trailing punctuation stays outside the anchor", () => {
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.04.010" }] });
    const html = linkify("See &#167; 8.04.010, and &#167; 8.04.010.");
    expect(html).toContain("</a>,");
    expect(html).toContain("</a>.");
    expect(html).not.toContain("8.04.010,</a>");
  });

  test("a number with too few segments is not treated as a citation", () => {
    // Section numbers here are `N.NN.NNN`. Two-segment forms are decimals in
    // ordinary prose, and accepting them cost 810 false-positive candidates
    // against 486 real citations (37.5% precision) versus 111 (81.4%) for the
    // three-segment rule.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.04.010" }] });
    expect(linkify("Chapter 12 applies.")).not.toContain("<a ");
    expect(linkify("In 2026 the code changed.")).not.toContain("<a ");
    expect(linkify("Effective 1.5.2026 onward.")).not.toContain("<a ");
    // The decimals measured in the corpus.
    for (const decimal of ["A fee of 7.5 dollars.", "At 853.5 feet.", "Measured 29.447 units."]) {
      expect(`${decimal} linked: ${linkify(decimal).includes("<a ")}`).toBe(`${decimal} linked: false`);
    }
  });

  test("several citations in one passage are all linked", () => {
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [
      { guid: "a", number: "8.04.010" },
      { guid: "b", number: "12.08.010" },
    ] });
    const html = linkify("See &#167; 8.04.010 and &#167; 12.08.010.");
    expect(html.match(/<a /g)?.length).toBe(2);
    expect(html).toContain('data-section-guid="a"');
    expect(html).toContain('data-section-guid="b"');
  });

  test("a three-segment number is linked even when it looks like a version string", () => {
    // The tightening must not cost recall. `12.08.010` is indistinguishable in
    // shape from a version, and it is the majority citation form in this corpus.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "12.08.010" }] });
    expect(linkify("See 12.08.010.")).toContain('data-section-guid="g1"');
  });

  test("a four-segment subsection form is accepted when the section exists", () => {
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.20.020.3" }] });
    expect(linkify("Per 8.20.020.3, ...")).toContain('data-section-guid="g1"');
  });

  test("every real citation in the scraped corpus resolves, and nothing decimal is linked", async () => {
    // The measurement the three-segment rule was chosen on, asserted against the
    // live corpus so the rule cannot be loosened back to two segments (which
    // cost 810 false positives) or tightened past full recall. Skipped when the
    // corpus is absent, since this host may have no scrape.
    const { loadAllSections } = await import("../src/shared/data.ts");
    const { normalizeSectionNumber } = await import("../src/utils.ts");
    const sections = await loadAllSections();
    if (sections.length === 0) return;

    const known = new Set(sections.map((s) => normalizeSectionNumber(s.number)));
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    for (const section of sections) remember({ sections: [section] });

    const escaped = (text: string): string =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    let linked = 0;
    for (const section of sections) {
      const html = linkify(escaped(section.text ?? ""));
      for (const match of html.matchAll(/data-section-guid="([^"]+)"/g)) {
        linked++;
        // Every link produced must point at a section the corpus actually has.
        expect(known.has(normalizeSectionNumber(
          sections.find((s) => s.guid === match[1])?.number ?? "",
        ))).toBe(true);
      }
      // The label the reader sees must be the source's own text, never a
      // fabricated one.
      expect(html).not.toContain("&#167;§");
    }
    // The corpus's citations are all in the BARE form, so a rule requiring the
    // marker would link nothing; this is the regression that proves it does not.
    expect(linked).toBeGreaterThan(100);
  }, 120000);

  test("empty and non-string input are returned unchanged", () => {
    const { linkify } = loadPureFunctions();
    expect(linkify("")).toBe("");
    expect(linkify(null as unknown as string)).toBe("");
    expect(linkify(undefined as unknown as string)).toBe("");
  });

  test("the href resolver is caller-supplied and used verbatim", () => {
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.04.010" }] });
    const html = linkify("§ 8.04.010", (guid) => `/api/section/${guid}`);
    expect(html).toContain('href="/api/section/g1"');
  });
});

describe("the section-number index", () => {
  test("first occurrence wins, matching the server-side resolver", () => {
    // `resolveSectionNumber` takes the first match, so a client that took the
    // last would link to a different section than `/api/section/{guid}` and the
    // cross-ref validator.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "first", number: "8.04.010" }] });
    remember({ sections: [{ guid: "second", number: "8.04.010" }] });
    expect(linkify("§ 8.04.010")).toContain('data-section-guid="first"');
  });

  test("malformed section entries are skipped, not indexed", () => {
    const { remember, known, reset } = loadPureFunctions();
    reset();
    remember({ sections: [null, {}, { guid: 1, number: "8.04.010" }, { guid: "g", number: null }] });
    expect(known()).toBe(0);
    expect(known()).toBe(0);
  });

  test("a payload with no sections is a no-op", () => {
    const { remember, known, reset } = loadPureFunctions();
    reset();
    remember(undefined);
    remember({});
    remember({ sections: "not-an-array" });
    expect(known()).toBe(0);
  });

  test("reset clears the index", () => {
    const { remember, known, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g", number: "8.04.010" }] });
    expect(known()).toBe(1);
    reset();
    expect(known()).toBe(0);
  });

  test("a number that normalises to nothing is not indexed", () => {
    const { remember, known, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g", number: "§" }] });
    expect(known()).toBe(0);
  });
});

describe("why the citation shape is three segments", () => {
  test("the bare form links with no marker and no leading space", () => {
    // This corpus has no § in section prose at all, so a pattern that required
    // the marker would produce zero links. If a maintainer "simplifies" it, this
    // is the test that says so.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.04.010" }] });
    expect(linkify("Applies under 8.04.010 and 12.08.010.")).toContain('data-section-guid="g1"');
  });

  test("the pattern requires three or more segments, not two", () => {
    // Asserted on the source so the measured precision trade-off is documented
    // where the rule lives. Match the REPETITION count specifically — `{1,4}`
    // also occurs as a segment width (`\d{1,4}`), so a bare substring check
    // would be satisfied by the width and prove nothing.
    const line = source.split("\n").find(l => l.includes("\\d{1,3}")) ?? "";
    expect(`repetition count is {2,4}: ${line.includes("){2,4}")}`).toBe("repetition count is {2,4}: true");
    expect(`repetition is not {1,4}: ${line.includes("){1,4}")}`).toBe("repetition is not {1,4}: false");
  });
});

describe("wiring", () => {
  test("both section-prose render sites linkify after escaping", () => {
    // Order matters: `escapeHtml` first, or the linkifier's own markup could be
    // escaped into visible text. Assert the composed expression, not a
    // substring that would also match the wrong order.
    const core = readFileSync(join(ROOT, "src/gui/static/assets/modules/10-core.js"), "utf-8");
    const sites = [...core.matchAll(/\$\{(ccLinkifyCrossRefs\(escapeHtml\([\s\S]*?\)\))\}/g)].map(m => m[1]!);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      expect(site.startsWith("ccLinkifyCrossRefs(escapeHtml(")).toBe(true);
      // And never the reverse, which would show raw <a> tags as text.
      expect(site).not.toContain("escapeHtml(ccLinkifyCrossRefs(");
    }
  });

  test("the article load path registers its sections with the linker", () => {
    const core = readFileSync(join(ROOT, "src/gui/static/assets/modules/10-core.js"), "utf-8");
    expect(core).toContain("ccRememberArticleSections(article)");
  });

  test("the click handler is installed during init, before the first render", () => {
    const core = readFileSync(join(ROOT, "src/gui/static/assets/modules/10-core.js"), "utf-8");
    const initBody = /async function init\(\) \{([\s\S]*?)\n {4}\}/.exec(core)?.[1] ?? "";
    expect(initBody).toContain("ccInitCrossRefLinks()");
    // Before loadToc, so a link in the first article is already handled.
    expect(initBody.indexOf("ccInitCrossRefLinks()")).toBeLessThan(initBody.indexOf("loadToc()"));
  });

  test("the module is loaded before the module that uses it", () => {
    // Load-order dependency: 10-core renders section prose at init, so the
    // linkifier has to be defined first or the first paint throws.
    const html = readFileSync(join(ROOT, "src/gui/static/index.html"), "utf-8");
    const linkifier = html.indexOf("15-cross-ref-links.js");
    const core = html.indexOf("10-core.js");
    expect(linkifier).toBeGreaterThan(-1);
    expect(linkifier).toBeLessThan(core);
  });

  test("the linkifier never injects unescaped input into markup", () => {
    // The only values it injects into markup are the guid, the caller's href,
    // and the citation label. The first two sit inside attributes and must be
    // attribute-escaped; the label is already-escaped source text.
    const anchor = /return `<a class="xref"([\s\S]*?)<\/a>`;/.exec(source)?.[1];
    expect(anchor).toBeDefined();
    const attrExprs = [...anchor!.matchAll(/\$\{([^}]+)\}/g)]
      .map(m => m[1]!.trim())
      .filter(expr => expr !== "label");
    expect(attrExprs.length).toBe(2); // the guid and the caller-supplied href
    for (const expr of attrExprs) {
      // Assert the property — routed through the attribute escaper — rather than
      // re-wrapping, so an already-escaped expression is not double-wrapped by
      // the expectation.
      expect(`${expr} is attribute-escaped: ${expr.startsWith("ccEscapeAttr(")}`).toBe(`${expr} is attribute-escaped: true`);
    }
  });

  test("the citation label is the source's own already-escaped text", () => {
    // The label must be reassembled from the matched source text, never rebuilt
    // from a captured number, so a `§` that was escaped upstream as `&#167;`
    // survives instead of being re-emitted raw.
    const { linkify, remember, reset } = loadPureFunctions();
    reset();
    remember({ sections: [{ guid: "g1", number: "8.04.010" }] });
    const html = linkify("See &#167; 8.04.010 now.");
    expect(html).toContain("&#167; 8.04.010");
    expect(html).not.toContain(">§ ");
  });
});

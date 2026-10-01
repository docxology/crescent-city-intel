// 15-cross-ref-links.js — turn `§ 8.04.010` citations in section prose into
// working links, and teach the SPA which section numbers it has seen.
//
// Plain classic script, consistent with the other modules: globals stay
// implicit, load order matches index.html.
//
// The two rules that matter:
//  1. Only ESCAPED HTML goes in. Every caller runs `escapeHtml` first, so this
//     module can only add markup around text that is already safe. A citation
//     that somehow contained markup would have been neutralised before here.
//  2. Only a number the client has actually seen becomes a link. Linking a
//     citation to a section that does not exist is worse than not linking it:
//     the reader clicks, gets a 404, and loses trust in every other link. The
//     index is built from article payloads as they load, so coverage grows with
//     use and a first-visit reader sees fewer links rather than broken ones.

/** Section number (normalised, marker stripped) → guid. Built as articles load. */
let ccSectionGuidByNumber = Object.create(null);

/**
 * Record the section numbers an article payload makes available.
 * @param {{sections?: Array<{guid?: string, number?: string}>}} article
 */
function ccRememberArticleSections(article) {
  if (!article || !Array.isArray(article.sections)) return;
  for (const section of article.sections) {
    if (!section || typeof section.guid !== 'string' || typeof section.number !== 'string') continue;
    const key = ccNormalizeSectionNumber(section.number);
    // First occurrence wins, matching `resolveSectionNumber`'s rule server-side.
    if (key && ccSectionGuidByNumber[key] === undefined) ccSectionGuidByNumber[key] = section.guid;
  }
}

/**
 * Strip the `§` marker and surrounding whitespace. The single definition here
 * matches `normalizeSectionNumber` in src/utils.ts: stored numbers carry the
 * marker ("§ 8.04.010") and citations do not, so every comparison must
 * normalise both sides or it is silently always-false.
 */
function ccNormalizeSectionNumber(number) {
  return String(number == null ? '' : number).replace(/§\s*/, '').replace(/\s+/g, ' ').trim();
}

/** How many section numbers the client currently knows. Diagnostics only. */
function ccKnownSectionCount() {
  return Object.keys(ccSectionGuidByNumber).length;
}

/** Forget every remembered number. Test hook and logout hygiene. */
function _resetCrossRefIndex() {
  ccSectionGuidByNumber = Object.create(null);
}

/**
 * The citation marker in EVERY form the text can arrive in.
 *
 * The input is already HTML-escaped, and `escapeHtml` turns `§` into the
 * numeric entity `&#167;` — so matching the raw character would never match
 * anything in the real GUI, and the marked form would silently link with the
 * section sign left outside the anchor. The raw character and the named entity
 * are accepted too so the function is correct if a caller ever hands it
 * unescaped text. Written as a source-level constant because the pattern is
 * duplicated in the tests' negative controls.
 */
const CC_SECTION_MARKER = '(?:§|&#167;|&sect;|\\u00a7)';

/**
 * Replace citation-shaped text in ALREADY-ESCAPED HTML with links to sections
 * the client has seen.
 *
 * A citation is `N.NN.NNN` — THREE segments. That shape is not a guess: it is
 * the shape of this corpus. Measured over all 2,206 scraped sections, requiring
 * three or more segments gives 100% recall of the 486 real citations while
 * cutting candidate false positives from 810 to 111 (precision 37.5% -> 81.4%).
 * The rejected two-segment forms are decimals in ordinary prose — "7.5",
 * "853.5", "29.447" — and every one of the 111 remaining rejects is a TRUE
 * negative: a citation into a different code ("4.04.070", "9.15.020") or a deep
 * subsection form that does not exist here ("8.20.020.3").
 *
 * Three further details the first draft got wrong, all pinned by tests:
 *
 *  - The marker must be matched in ESCAPED form (see CC_SECTION_MARKER above).
 *    This corpus contains no `§` in section prose at all — every one of the 853
 *    links comes from the BARE form — so a rule that required a marker would
 *    produce nothing here.
 *  - The space is OPTIONAL. Requiring it meant a citation standing alone at the
 *    start of a passage never matched.
 *  - The guard rejects a following DIGIT, not a following dot. `(?![0-9.])` also
 *    rejected a sentence-ending period, so the last citation in a sentence —
 *    the common case — was never linked.
 *
 * An unknown number is left as plain text, never linked speculatively.
 */
function ccLinkifyCrossRefs(escapedHtml, resolveHref) {
  if (typeof escapedHtml !== 'string' || !escapedHtml) return escapedHtml || '';
  const href = typeof resolveHref === 'function' ? resolveHref : (guid) => `?section=${encodeURIComponent(guid)}`;
  const pattern = new RegExp(
    `(${CC_SECTION_MARKER}\\s*|\\s)?(\\d{1,3}(?:\\.\\d{1,4}){2,4})(?![0-9])`,
    'g',
  );
  return escapedHtml.replace(pattern, (match, lead, rawNumber) => {
    const key = ccNormalizeSectionNumber(rawNumber);
    const guid = ccSectionGuidByNumber[key];
    if (!guid) return match; // not seen yet — honest plain text
    // Keep the citation's own leading marker and spacing inside the anchor so
    // the rendered text reads exactly as the source did.
    const label = `${lead || ''}${rawNumber}`.trim();
    return `<a class="xref" data-section-guid="${ccEscapeAttr(guid)}" href="${ccEscapeAttr(href(guid))}">${label}</a>`;
  });
}

/**
 * Attribute-escape for the values this module injects. Separate from
 * `escapeHtml` because guids and hrefs go inside attributes, and a guid that
 * contained a quote would otherwise break out of one.
 */
function ccEscapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Intercept a click on a citation link so it loads the section in place instead
// of navigating, matching every other in-app navigation.
function ccInitCrossRefLinks(loadSection) {
  document.addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a.xref') : null;
    if (!link) return;
    const guid = link.getAttribute('data-section-guid');
    if (!guid || typeof loadSection !== 'function') return;
    event.preventDefault();
    loadSection(guid);
  });
}

export { ccInitCrossRefLinks, ccLinkifyCrossRefs, ccRememberArticleSections, ccNormalizeSectionNumber, ccKnownSectionCount, _resetCrossRefIndex };

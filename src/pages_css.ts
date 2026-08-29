/**
 * Deterministic CSS reader for the Pages gate (lane 4 r3).
 *
 * The Pages stylesheets are hand-authored and split by consumption: every page
 * links `site.css`, the front page additionally links `index.css`, the errata
 * page `404.css`. Two whole classes of regression escaped string-presence
 * assertions in earlier rounds:
 *
 *   1. A rule a page *uses* living only in a stylesheet that page does not
 *      *load* (the `.meta` split defect) — the string is present in the repo,
 *      so `css.includes(".meta")` passes while the shipped page is unstyled.
 *   2. A rule that is present and syntactically intact but *inert* because the
 *      cascade, an unbalanced brace, or an ancestor's layout mode overrides or
 *      swallows it (sticky month headers inside a grid; a print block nested in
 *      an unclosed `@media (max-width:480px)`).
 *
 * Both need the declared value that actually wins for a concrete element, so
 * this module parses rules, scores specificity, and resolves the cascade over
 * an explicit element path. It is intentionally a *subset* of CSS: state
 * pseudo-classes never match (we resolve the default, unfocused, unhovered
 * state), and unmodelled at-rules are skipped rather than guessed at.
 */

/** A single declaration, post shorthand expansion. */
export interface CssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

/** One flattened style rule with its at-rule (media) context. */
export interface CssRule {
  selector: string;
  declarations: CssDeclaration[];
  /** `@media` conditions enclosing this rule, outermost first. */
  media: string[];
  /** Document order across the concatenated stylesheets; later wins ties. */
  order: number;
}

/** The element shape the resolver matches selectors against. */
export interface CssElement {
  tag: string;
  id?: string;
  classes?: string[];
  attributes?: Record<string, string>;
}

/** Result of the brace-balance scan. */
export interface CssBraceBalance {
  open: number;
  close: number;
  /** Depth left open at end of input; non-zero means a block never closed. */
  finalDepth: number;
  /** Lowest depth reached; negative means a stray closing brace. */
  minDepth: number;
  balanced: boolean;
}

/** Strip `/* … *\/` comments without disturbing offsets' relative order. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Brace balance over a stylesheet, comments removed.
 *
 * A stylesheet that never closes a block does not fail to parse — browsers
 * auto-close at EOF — so everything authored after the unclosed block silently
 * inherits its condition. That is exactly how the print stylesheet became dead
 * code behind `@media (max-width:480px)`.
 */
export function cssBraceBalance(css: string): CssBraceBalance {
  const text = stripComments(css);
  let depth = 0;
  let open = 0;
  let close = 0;
  let minDepth = 0;
  for (const character of text) {
    if (character === "{") { open += 1; depth += 1; }
    else if (character === "}") { close += 1; depth -= 1; if (depth < minDepth) minDepth = depth; }
  }
  return { open, close, finalDepth: depth, minDepth, balanced: depth === 0 && minDepth === 0 };
}

/** Split a comma list (selector list, media list) without breaking on parens. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    if (character === separator && depth === 0) { parts[parts.length] = current.trim(); current = ""; continue; }
    current += character;
  }
  if (current.trim() !== "") parts[parts.length] = current.trim();
  return parts;
}

/** Longhands we expand so a computed query can ask for the property it means. */
function expandShorthand(property: string, value: string): CssDeclaration[] {
  const important = /!\s*important\s*$/i.test(value);
  const clean = value.replace(/!\s*important\s*$/i, "").trim();
  const make = (name: string, raw: string): CssDeclaration => ({ property: name, value: raw.trim(), important });
  if (property === "overflow") {
    const parts = clean.split(/\s+/);
    return [make("overflow", clean), make("overflow-x", parts[0] ?? clean), make("overflow-y", parts[1] ?? parts[0] ?? clean)];
  }
  if (property === "list-style") {
    // `list-style: none` sets type (and image) to none; that is the only form used here.
    return [make("list-style", clean), make("list-style-type", clean.split(/\s+/)[0] ?? clean)];
  }
  if (property === "padding") {
    const parts = clean.split(/\s+/);
    const top = parts[0] ?? clean;
    const right = parts[1] ?? top;
    const bottom = parts[2] ?? top;
    const left = parts[3] ?? right;
    return [
      make("padding", clean),
      make("padding-top", top), make("padding-right", right), make("padding-bottom", bottom), make("padding-left", left),
      // Physical/logical mapping is exact for the horizontal-tb, ltr pages here.
      make("padding-inline-start", left), make("padding-inline-end", right),
    ];
  }
  if (property === "padding-left") return [make("padding-left", clean), make("padding-inline-start", clean)];
  if (property === "padding-inline-start") return [make("padding-inline-start", clean), make("padding-left", clean)];
  return [make(property, clean)];
}

/** Parse a declaration block body into expanded declarations. */
function parseDeclarations(body: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  for (const chunk of splitTopLevel(body, ";")) {
    const separator = chunk.indexOf(":");
    if (separator <= 0) continue;
    const property = chunk.slice(0, separator).trim().toLowerCase();
    const value = chunk.slice(separator + 1).trim();
    if (property === "" || value === "") continue;
    for (const declaration of expandShorthand(property, value)) declarations[declarations.length] = declaration;
  }
  return declarations;
}

/**
 * Flatten a stylesheet into rules, descending into `@media` (nesting included —
 * a nested media query is the conjunction of its ancestors, which is what makes
 * an unclosed block so quietly destructive).
 */
export function parseCssRules(css: string, startOrder = 0): CssRule[] {
  const text = stripComments(css);
  const rules: CssRule[] = [];
  let order = startOrder;

  function walk(source: string, media: string[]): void {
    let index = 0;
    while (index < source.length) {
      const brace = source.indexOf("{", index);
      if (brace < 0) break;
      const prelude = source.slice(index, brace).trim();
      // Find the matching close brace for this block.
      let depth = 1;
      let cursor = brace + 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      const body = source.slice(brace + 1, depth === 0 ? cursor - 1 : source.length);
      index = cursor;
      if (prelude.startsWith("@")) {
        const name = prelude.slice(1).split(/[\s({]/)[0]!.toLowerCase();
        if (name === "media" || name === "supports") {
          walk(body, media.concat(prelude.slice(1 + name.length).trim()));
        }
        // @font-face/@keyframes/@page carry no selector-addressable rules here.
        continue;
      }
      const declarations = parseDeclarations(body);
      if (declarations.length === 0) continue;
      for (const selector of splitTopLevel(prelude)) {
        if (selector === "") continue;
        order += 1;
        rules[rules.length] = { selector, declarations, media: [...media], order };
      }
    }
  }

  walk(text, []);
  return rules;
}

/** CSS specificity as [id, class/attr/pseudo-class, type/pseudo-element]. */
export function specificity(selector: string): [number, number, number] {
  const withoutPseudoElements = selector.replace(/::[a-z-]+/g, " ");
  const ids = (withoutPseudoElements.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
  const classes = (withoutPseudoElements.match(/\.[A-Za-z0-9_-]+/g) ?? []).length
    + (withoutPseudoElements.match(/\[[^\]]+\]/g) ?? []).length
    + (withoutPseudoElements.match(/:[a-z-]+(\([^)]*\))?/g) ?? []).length;
  const types = (withoutPseudoElements.replace(/[.#][A-Za-z0-9_-]+/g, " ").replace(/\[[^\]]+\]/g, " ").replace(/:[a-z-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-z][a-z0-9]*/g) ?? []).length
    + (selector.match(/::[a-z-]+/g) ?? []).length;
  return [ids, classes, types];
}

function compareSpecificity(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

/**
 * Pseudo-classes that describe a *state* the resolver deliberately treats as
 * not-matching: we resolve the default rendering of a freshly loaded page.
 */
const STATE_PSEUDO = /:(hover|focus|focus-visible|focus-within|active|target|checked|disabled|visited|link)\b/;

/** Match one compound selector (no combinators) against one element. */
function matchCompound(compound: string, element: CssElement): boolean {
  if (compound === "" || compound === "*") return true;
  if (compound.includes("::")) return false;
  if (STATE_PSEUDO.test(compound)) return false;
  let rest = compound;
  if (rest.startsWith(":root")) {
    if (element.tag !== "html") return false;
    rest = rest.slice(":root".length);
  }
  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagMatch) {
    if (tagMatch[0].toLowerCase() !== element.tag.toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const tokens = rest.match(/[.#][A-Za-z0-9_-]+|\[[^\]]+\]|:[a-z-]+(\([^)]*\))?/g) ?? [];
  const consumed = tokens.join("");
  if (consumed.length !== rest.length) return false; // unmodelled syntax → no match
  for (const token of tokens) {
    if (token.startsWith("#")) { if (element.id !== token.slice(1)) return false; continue; }
    if (token.startsWith(".")) { if (!(element.classes ?? []).includes(token.slice(1))) return false; continue; }
    if (token.startsWith("[")) {
      const inner = token.slice(1, -1);
      const equals = inner.indexOf("=");
      if (equals < 0) { if (!(element.attributes ?? {})[inner.trim()]) return false; continue; }
      const name = inner.slice(0, equals).trim();
      const wanted = inner.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
      if ((element.attributes ?? {})[name] !== wanted) return false;
      continue;
    }
    return false; // a pseudo-class we do not model
  }
  return true;
}

/**
 * Match a full selector against an element path (root first, target last).
 * Supports descendant and child combinators — the only two the Pages CSS uses.
 */
export function selectorMatches(selector: string, path: readonly CssElement[]): boolean {
  if (path.length === 0) return false;
  const normalized = selector.replace(/\s*>\s*/g, " > ").trim();
  const parts = normalized.split(/\s+/);
  // Walk right-to-left over the selector, consuming ancestors.
  let pathIndex = path.length - 1;
  let partIndex = parts.length - 1;
  if (!matchCompound(parts[partIndex]!, path[pathIndex]!)) return false;
  partIndex -= 1;
  pathIndex -= 1;
  while (partIndex >= 0) {
    const combinator = parts[partIndex] === ">" ? ">" : " ";
    if (combinator === ">") partIndex -= 1;
    const compound = parts[partIndex];
    if (compound === undefined) return false;
    if (combinator === ">") {
      if (pathIndex < 0 || !matchCompound(compound, path[pathIndex]!)) return false;
      pathIndex -= 1;
    } else {
      let found = false;
      while (pathIndex >= 0) {
        if (matchCompound(compound, path[pathIndex]!)) { found = true; pathIndex -= 1; break; }
        pathIndex -= 1;
      }
      if (!found) return false;
    }
    partIndex -= 1;
  }
  return true;
}

/** Options for {@link computeDeclaredValue}. */
export interface ComputeOptions {
  /**
   * Predicate deciding whether an `@media` condition applies. Default: only
   * unconditional rules apply, which is the desktop, screen, no-preference,
   * fine-pointer baseline the sticky/list/`.meta` checks care about.
   */
  mediaApplies?: (condition: string) => boolean;
}

/** The winning declaration for a property, or null when nothing declares it. */
export function computeDeclaredValue(
  rules: readonly CssRule[],
  path: readonly CssElement[],
  property: string,
  options: ComputeOptions = {},
): { value: string; selector: string; important: boolean; order: number } | null {
  const mediaApplies = options.mediaApplies ?? (() => false);
  let winner: { value: string; selector: string; important: boolean; order: number; specificity: [number, number, number] } | null = null;
  for (const rule of rules) {
    if (rule.media.some(condition => !mediaApplies(condition))) continue;
    if (!selectorMatches(rule.selector, path)) continue;
    const score = specificity(rule.selector);
    for (const declaration of rule.declarations) {
      if (declaration.property !== property) continue;
      if (winner !== null) {
        if (winner.important && !declaration.important) continue;
        if (winner.important === declaration.important) {
          const bySpecificity = compareSpecificity(score, winner.specificity);
          if (bySpecificity < 0) continue;
          if (bySpecificity === 0 && rule.order < winner.order) continue;
        }
      }
      winner = { value: declaration.value, selector: rule.selector, important: declaration.important, order: rule.order, specificity: score };
    }
  }
  if (winner === null) return null;
  return { value: winner.value, selector: winner.selector, important: winner.important, order: winner.order };
}

/* ===================================================================
   Page-gate contract (lane 4 r3)
   =================================================================== */

/** One page's loaded CSS plus the markup facts that decide what it must style. */
export interface PageCssInput {
  /** File name, e.g. "events.html" — used in error text. */
  page: string;
  /** Concatenation of every stylesheet this page links, in link order. */
  css: string;
  /** The page renders `<ol id="event-items" class="items">`. */
  hasEventList: boolean;
  /** The page renders a `.table-scroll` wrapper (inline or via site.js). */
  hasTableScroll: boolean;
}

const HTML_ELEMENT: CssElement = { tag: "html" };
const BODY_ELEMENT: CssElement = { tag: "body" };
const PAGE_ELEMENT: CssElement = { tag: "main", classes: ["page"] };
const EVENT_LIST_ELEMENT: CssElement = { tag: "ol", id: "event-items", classes: ["items"] };
const DATELINE_ELEMENT: CssElement = { tag: "li", classes: ["cal-dateline"] };

/**
 * Brace balance for one named stylesheet.
 *
 * Kept separate from {@link auditPagesCss} because it must also run over the
 * *emitted* content-hashed assets, not just the per-page concatenation.
 */
export function auditStylesheetBraces(name: string, css: string): string[] {
  const balance = cssBraceBalance(css);
  const errors: string[] = [];
  if (balance.minDepth < 0) {
    errors[errors.length] = `${name} has a stray closing brace (depth fell to ${balance.minDepth})`;
  }
  if (balance.finalDepth !== 0) {
    errors[errors.length] =
      `${name} has ${balance.open} '{' against ${balance.close} '}' — ${balance.finalDepth} block(s) never close, ` +
      `so every rule authored after them silently inherits their at-rule condition`;
  }
  return errors;
}

/**
 * Computed-value contract over each page's *loaded* stylesheets.
 *
 * Every assertion here resolves the cascade for a concrete element rather than
 * grepping for a substring, so a rule that is present-but-unreachable (wrong
 * stylesheet, wrong layout mode, overridden) fails exactly like a missing one.
 */
export function auditPagesCss(inputs: readonly PageCssInput[]): string[] {
  const errors: string[] = [];
  for (const input of inputs) {
    const rules = parseCssRules(input.css);
    const value = (path: readonly CssElement[], property: string): string | null =>
      computeDeclaredValue(rules, path, property)?.value ?? null;

    // R2 P0.2: rules consumed by shared markup (assets/site.js renders these on
    // every page) must resolve in the stylesheets this page actually links.
    // `expect` pins the *winning* declaration, so a check cannot be satisfied by
    // some lower-specificity rule that happens to declare the same property.
    const shared: Array<{ label: string; path: CssElement[]; property: string; expect?: string }> = [
      { label: "bare .meta text colour", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "div", classes: ["meta"] }], property: "color", expect: "var(--ink-faint)" },
      { label: "bare .meta typography", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "div", classes: ["meta"] }], property: "font" },
      { label: ".banner strong weight", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "div", classes: ["banner"] }, { tag: "strong" }], property: "font-weight" },
      { label: ".banner.degraded .meta colour", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "div", classes: ["banner", "degraded"] }, { tag: "div", classes: ["meta"] }], property: "color", expect: "var(--ink-dim)" },
      { label: ".banner.unavailable .meta colour", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "div", classes: ["banner", "unavailable"] }, { tag: "div", classes: ["meta"] }], property: "color", expect: "var(--ink)" },
      { label: ".footer a colour", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "footer", classes: ["footer"] }, { tag: "a" }], property: "color", expect: "var(--ink-dim)" },
      { label: ".pill.monitored border", path: [HTML_ELEMENT, BODY_ELEMENT, { tag: "span", classes: ["pill", "monitored"] }], property: "border-color", expect: "var(--ink-dim)" },
    ];
    for (const check of shared) {
      const computed = value(check.path, check.property);
      if (computed === null) {
        errors[errors.length] = `${input.page} loads no stylesheet declaring ${check.label} (CSS split by page, not by consumption)`;
      } else if (check.expect !== undefined && computed !== check.expect) {
        errors[errors.length] = `${input.page} resolves ${check.label} to ${computed}, expected ${check.expect}`;
      }
    }

    // P1-A killer (b): a scroll container on the root pins every sticky
    // descendant. This must stay absent site-wide.
    for (const root of [HTML_ELEMENT, BODY_ELEMENT]) {
      const overflowX = value([root], "overflow-x");
      if (overflowX === "hidden" || overflowX === "auto" || overflowX === "scroll") {
        errors[errors.length] = `${input.page} sets overflow-x:${overflowX} on <${root.tag}>, which makes the root a scroll container and pins every position:sticky descendant`;
      }
    }

    if (input.hasTableScroll) {
      const overflowX = value([HTML_ELEMENT, BODY_ELEMENT, PAGE_ELEMENT, { tag: "div", classes: ["table-scroll"] }], "overflow-x");
      if (overflowX !== "auto" && overflowX !== "scroll") {
        errors[errors.length] = `${input.page} renders .table-scroll but loads no stylesheet giving it a horizontal scroll container (computed overflow-x: ${overflowX ?? "not declared"})`;
      }
    }

    if (input.hasEventList) {
      const listPath = [HTML_ELEMENT, BODY_ELEMENT, PAGE_ELEMENT, EVENT_LIST_ELEMENT];
      // P0.9: `.items` lands on an <ol>, so the UA decimal marker and 40px
      // inline indent survive unless the reset is authored.
      if (value(listPath, "list-style-type") !== "none") {
        errors[errors.length] = `${input.page} #event-items is an <ol> with computed list-style-type ${value(listPath, "list-style-type") ?? "decimal (UA default)"} — the list reset does not reach it`;
      }
      const inlineStart = value(listPath, "padding-inline-start");
      if (inlineStart === null || !/^0(\D|$)/.test(inlineStart)) {
        errors[errors.length] = `${input.page} #event-items keeps the UA list indent (computed padding-inline-start: ${inlineStart ?? "40px (UA default)"})`;
      }
      // P1-A killer (a): grid/flex makes every <li> its own item, so a sticky
      // dateline has exactly its own height to travel in — zero movement.
      const display = value(listPath, "display");
      if (display === "grid" || display === "flex" || display === "inline-grid" || display === "inline-flex") {
        errors[errors.length] = `${input.page} #event-items computes display:${display}; each <li> becomes its own layout item and the sticky month dateline has zero travel`;
      }
      const datelinePath = [...listPath, DATELINE_ELEMENT];
      if (value(datelinePath, "position") !== "sticky") {
        errors[errors.length] = `${input.page} .cal-dateline computes position:${value(datelinePath, "position") ?? "static"} — month headers are not sticky`;
      }
      if (value(datelinePath, "top") === null) {
        errors[errors.length] = `${input.page} .cal-dateline is position:sticky with no inset (top) declared, which never engages`;
      }
    }
  }
  return errors;
}

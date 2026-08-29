/**
 * Static-page innerHTML scanner (the lane-0 XSS gate's engine).
 *
 * Every `innerHTML =` assignment in an exported page's inline script must
 * interpolate through esc()/href() or a provably-safe builder: a fixpoint-
 * derived const or function, a .map callback chain, a ternary branch, a numeric
 * coercion, or a .length. Anything else is reported.
 *
 * It lives under src/ for two reasons: `bun run validate` typechecks src/ but
 * not scripts/, and a gate this consequential has to be executable by tests. It
 * was vacuous for its whole life until R3 follow-up — the fixpoint probes
 * flagged into a no-op and then compared an array against itself, so every
 * const in every page was marked safe and the scan could not fail. Its negative
 * controls live in tests/pages-scan.test.ts.
 */

const SAFE_CALLS = new Set(["esc", "href", "status", "empty", "date", "Number"]);

function skipString(src: string, i: number, quote: string): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplate(src: string, i: number): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") return i + 1;
    // NOTE: quotes in template TEXT are plain characters, not string starts.
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1; i += 2;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "'" || ch === '"') { i = skipString(src, i, ch); continue; }
        if (ch === "`") { i = skipTemplate(src, i); continue; }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function matchDelim(src: string, i: number, open: string, close: string): number {
  let depth = 1; i++;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipString(src, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return i;
}

/** Top-level ${...} ranges inside template body [start,end). */
function topInterps(src: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = start;
  while (i < end) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    // NOTE: quotes in template TEXT are plain characters; skipString starts only
    // inside ${...} expressions, which are delimited below.
    if (ch === "$" && src[i + 1] === "{") {
      const exprStart = i + 2;
      let depth = 1; i = exprStart;
      while (i < end && depth > 0) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "'" || c === '"') { i = skipString(src, i, c); continue; }
        if (c === "`") { i = skipTemplate(src, i); continue; }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
      out.push([exprStart, i - 1]);
      continue;
    }
    i++;
  }
  return out;
}

export interface Ctx { path: string; problems: string[]; safeConsts: Set<string>; flag(tag: string, expr: string): void; }

function splitTernary(expr: string): [string, string] | null {
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(expr, i); continue; }
    if (ch === "(") { i = matchDelim(expr, i, "(", ")"); continue; }
    if (ch === "?" && expr[i + 1] !== "?" && expr[i + 1] !== "." && expr[i - 1] !== "?" && expr[i - 1] !== ".") {
      let j = i + 1, d = 0;
      while (j < expr.length) {
        const c = expr[j];
        if (c === "'" || c === '"') { j = skipString(expr, j, c); continue; }
        if (c === "`") { j = skipTemplate(expr, j); continue; }
        if (c === "(") { j = matchDelim(expr, j, "(", ")"); continue; }
        if (c === "?") d++;
        else if (c === ":") { if (d === 0) return [expr.slice(i + 1, j), expr.slice(j + 1)]; d--; }
        j++;
      }
      return null;
    }
    i++;
  }
  return null;
}

function checkTemplate(expr: string, ctx: Ctx): void {
  const after = skipTemplate(expr, 0);
  for (const [s, e] of topInterps(expr, 1, after - 1)) {
    isSafeExpr(expr.slice(s, e), ctx);
  }
  const tail = expr.slice(after).trim();
  if (tail) { // e.g. `...` + something
    if (tail.startsWith("+")) isSafeExpr(tail.slice(1), ctx);
    else ctx.flag("template-tail", tail);
  }
}

function checkOperand(expr: string, ctx: Ctx): void {
  let e = expr.trim();
  if (!e) return;
  while (e.startsWith("(") && matchDelim(e, 0, "(", ")") === e.length) {
    const inner = e.slice(1, -1).trim();
    if (!inner) return;
    e = inner;
  }
  if (e.startsWith("`")) { checkTemplate(e, ctx); return; }
  // provably numeric values cannot inject markup
  if (/^(?:[A-Za-z_$][\w$]*\??\.)+length$/.test(e)) return;
  const coercionCall = /^(?:Number|parseInt|parseFloat|Boolean|Math\.(?:abs|floor|ceil|round|min|max))\s*\(/.exec(e);
  if (coercionCall) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) return;
  }
  const call = /^(?:esc|href|status|empty|date|Number)\s*\(/.exec(e);
  if (call) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) return;
  }
  if (ctx.safeConsts.has(e)) return;
  if (/^[\s\d.]+$/.test(e)) return;
  if (/^"(?:[^"\\]|\\.)*"$/.test(e) || /^'(?:[^'\\]|\\.)*'$/.test(e)) return;
  if (/^[A-Za-z_$][\w$]*$/.test(e)) { ctx.flag("bare-identifier", e); return; }
  // plain call: trust the callee if the fixpoint proved its templates safe
  const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  if (callee) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) {
      if (ctx.safeConsts.has(callee[1])) return;
      ctx.flag("call-unverified", callee[1]);
      return;
    }
  }
  // member method call, e.g. kind.toLowerCase(): check the arguments
  const memberCall = /^(?:[A-Za-z_$][\w$]*\.?)+\s*\(/.exec(e);
  if (memberCall && memberCall[0].includes(".")) {
    const open = e.indexOf("(");
    if (matchDelim(e, open, "(", ")") === e.length) {
      const args = e.slice(open + 1, e.length - 1);
      if (!args.trim()) return;
      // split on top-level commas
      const parts: string[] = [];
      let i2 = 0, last2 = 0;
      while (i2 < args.length) {
        const c = args[i2];
        if (c === "'" || c === '"') { i2 = skipString(args, i2, c); continue; }
        if (c === "`") { i2 = skipTemplate(args, i2); continue; }
        if (c === "(") { i2 = matchDelim(args, i2, "(", ")"); continue; }
        if (c === ",") { parts.push(args.slice(last2, i2)); last2 = i2 + 1; }
        i2++;
      }
      parts.push(args.slice(last2));
      parts.forEach(part => isSafeExpr(part, ctx));
      return;
    }
  }
  if (checkMapChain(e, ctx)) return;
  ctx.flag("unsafe-interpolation", e.slice(0, 90));
}

/** Split on a top-level binary operator token (used for ??). */
function topLevelBinarySplit(expr: string, op: string): [string, string] | null {
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(expr, i); continue; }
    if (ch === "(") { i = matchDelim(expr, i, "(", ")"); continue; }
    if (expr.startsWith(op, i) && (i === 0 || !"\w$.".includes(expr[i - 1])) && (i + op.length >= expr.length || !"\w$".includes(expr[i + op.length]))) {
      return [expr.slice(0, i), expr.slice(i + op.length)];
    }
    i++;
  }
  return null;
}

/** Check `return\`...\`` / `X +=\`...\`` templates inside an arrow/func block body. */
function checkBlockReturns(block: string, ctx: Ctx): boolean {
  const problemsBefore = ctx.problems.length;
  const re = /\breturn\s*`|\+=\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const tplStart = block.indexOf("`", m.index);
    const tplEnd = skipTemplate(block, tplStart);
    checkTemplate(block.slice(tplStart, tplEnd), ctx);
    re.lastIndex = tplEnd;
  }
  return ctx.problems.length === problemsBefore;
}

/**
 * Recognize `<data>.map(callback)` chains (optionally followed by .slice(n)/.join("")).
 * Returns true when the expression was fully understood; the callback body is
 * checked recursively (expression arrows via isSafeExpr, block arrows and named
 * functions via their return/+= templates, bare identifiers via safeConsts).
 */
function checkMapChain(e: string, ctx: Ctx): boolean {
  let rest = e.trim();
  for (;;) {
    const strip = /\.(join|slice)\s*\(([^()]*)\)$/.exec(rest);
    if (!strip || strip[2].includes("`") || strip[2].includes("=>")) break;
    rest = rest.slice(0, strip.index).trim();
  }
  if (!rest.endsWith(")")) return false;
  // Pick the `.map(` whose argument list closes at the very end of the
  // expression — the OUTERMOST one. Taking the last occurrence broke on a
  // nested chain (`groups.map(g => ... g.items.map(...).join("") ...)`): the
  // inner map's parens do not close the expression, so the whole chain was
  // reported unverified and every const built from it became unsafe.
  let mapIdx = -1;
  for (let at = rest.indexOf(".map("); at !== -1; at = rest.indexOf(".map(", at + 1)) {
    if (matchDelim(rest, at + ".map".length, "(", ")") === rest.length) { mapIdx = at; break; }
  }
  if (mapIdx === -1) return false;
  const open = mapIdx + ".map".length;
  const callback = rest.slice(open + 1, rest.length - 1).trim();
  // bare function-reference callback
  if (/^[A-Za-z_$][\w$]*$/.test(callback)) {
    if (ctx.safeConsts.has(callback)) return true;
    ctx.flag("map-callback-unverified", callback);
    return true;
  }
  const arrow = callback.indexOf("=>");
  if (arrow === -1) return false;
  const body = callback.slice(arrow + 2).trim();
  if (body.startsWith("{")) {
    const close = matchDelim(body, 0, "{", "}");
    if (close !== body.length) return false;
    checkBlockReturns(body.slice(1, close - 1), ctx);
    return true;
  }
  isSafeExpr(body, ctx);
  return true;
}

function isSafeExpr(raw: string, ctx: Ctx): void {
  let expr = raw.trim();
  if (!expr) return;
  if (expr.startsWith("(") && matchDelim(expr, 0, "(", ")") === expr.length) {
    const inner = expr.slice(1, -1).trim();
    if (inner) { isSafeExpr(inner, ctx); return; }
  }
  const co = topLevelBinarySplit(expr, "??");
  if (co) { isSafeExpr(co[0], ctx); isSafeExpr(co[1], ctx); return; }
  if (expr.startsWith("`")) { checkTemplate(expr, ctx); return; }
  const ternary = splitTernary(expr);
  if (ternary) { isSafeExpr(ternary[0], ctx); isSafeExpr(ternary[1], ctx); return; }
  // split on top-level + (string concat)
  const operands: string[] = [];
  let i = 0, last = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') { i = skipString(expr, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(expr, i); continue; }
    if (ch === "(") { i = matchDelim(expr, i, "(", ")"); continue; }
    if (ch === "+" && expr[i + 1] !== "+") { operands.push(expr.slice(last, i)); last = i + 1; }
    i++;
  }
  operands.push(expr.slice(last));
  if (operands.length > 1) { operands.forEach(op => isSafeExpr(op, ctx)); return; }
  checkOperand(expr, ctx);
}

/** Extract statement-level RHS after `=` up to the terminating `;`. */
function extractRhs(src: string, eqIndex: number): string {
  let i = eqIndex + 1;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"') { i = skipString(src, i, ch); continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return src.slice(eqIndex + 1, i);
    i++;
  }
  return "";
}

/**
 * Scan one page's inline scripts for unsafe innerHTML interpolation.
 *
 * `seedSafe` names functions defined outside this file whose own templates the
 * gate verifies elsewhere (assets/site.js is scanned directly, above). They are
 * seeded into the safe set BEFORE scanning rather than filtered out of the
 * findings afterwards: a value built from them is then provably safe inside the
 * fixpoint too, instead of poisoning every const that touches one.
 */
export function scanPage(html: string, path: string, seedSafe: readonly string[] = []): string[] {
  const problems: string[] = [];
  // A seeded name is trusted because the shared asset's definition was verified
  // — so a page that declares its OWN function or const of that name forfeits
  // the seed and must prove the local definition on its own merits. Without
  // this, shadowing a shared helper's name is a way to smuggle an unverified
  // builder past the gate.
  const shadowed = new Set<string>();
  for (const name of seedSafe) {
    const declaration = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`);
    if (declaration.test(html)) shadowed.add(name);
  }
  const ctx: Ctx = {
    path, problems, safeConsts: new Set<string>(seedSafe.filter(name => !shadowed.has(name))),
    flag(tag, expr) { problems.push(`${tag}: ${expr} in ${path}`); },
  };
  // Fixpoint pass: const X = <safe expr> marks X safe (e.g. title, commit, html).
  for (let round = 0; round < 3; round++) {
    const before = ctx.safeConsts.size;
    const constRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = constRe.exec(html)) !== null) {
      const name = m[1];
      if (ctx.safeConsts.has(name)) continue;
      const rhs = extractRhs(html, m.index + m[0].length - 1);
      if (!rhs) continue;
      // The probe must RECORD what it finds. Until R3 follow-up it flagged into
      // a no-op and then compared the OUTER problems array against itself, so
      // the condition was always true and every const in every page was marked
      // safe — which made the whole innerHTML scanner vacuous: a bare
      // identifier holding artifact text resolved through safeConsts and passed.
      const probeProblems: string[] = [];
      const probe: Ctx = { ...ctx, problems: probeProblems, safeConsts: ctx.safeConsts, flag(tag, expr) { probeProblems.push(`${tag}: ${expr}`); } };
      isSafeExpr(rhs, probe);
      if (probeProblems.length === 0) ctx.safeConsts.add(name);
    }
    // let X = "" accumulated via X += <safe template>
    const accumRe = /\b([A-Za-z_$][\w$]*)\s*\+=\s*`/g;
    while ((m = accumRe.exec(html)) !== null) {
      const name = m[1];
      const tplStart = m.index + m[0].length - 1;
      const tplEnd = skipTemplate(html, tplStart);
      const accumProblems: string[] = [];
      const probe: Ctx = { ...ctx, problems: accumProblems, safeConsts: ctx.safeConsts, flag(tag, expr) { accumProblems.push(`${tag}: ${expr}`); } };
      checkTemplate(html.slice(tplStart, tplEnd), probe);
      if (accumProblems.length === 0) ctx.safeConsts.add(name);
    }
    // function NAME(...) declarations whose return/+= templates are safe
    const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fnRe.exec(html)) !== null) {
      const name = m[1];
      if (ctx.safeConsts.has(name)) continue;
      const braceStart = html.indexOf("{", m.index + m[0].length - 1);
      if (braceStart === -1) continue;
      const braceEnd = matchDelim(html, braceStart, "{", "}");
      const fnProblems: string[] = [];
      const probe2: Ctx = { ...ctx, problems: fnProblems, safeConsts: ctx.safeConsts, flag(tag, expr) { fnProblems.push(`${tag}: ${expr}`); } };
      if (checkBlockReturns(html.slice(braceStart + 1, braceEnd - 1), probe2)) ctx.safeConsts.add(name);
    }
    if (ctx.safeConsts.size === before) break;
  }
  // Main pass: every `.innerHTML =` assignment.
  let i = 0;
  while ((i = html.indexOf(".innerHTML", i)) !== -1) {
    i += ".innerHTML".length;
    let j = i;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== "=" || html[j + 1] === "=") continue;
    const rhs = extractRhs(html, j);
    if (!rhs) continue;
    isSafeExpr(rhs, ctx);
    i = j + rhs.length;
  }
  return problems;
}

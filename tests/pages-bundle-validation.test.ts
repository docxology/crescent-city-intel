import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePagesBundle } from "../src/pages_bundle_validation.ts";

const sourcePath = join(import.meta.dir, "../src/pages/static/assets/site.js");
const evaluationFailure = "assets/site.js does not evaluate, or no longer exports the calendar helpers:";

async function expectBoundedFailure(source: string): Promise<void> {
  const started = Date.now(), errors = await validatePagesBundle(source);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.join("\n")).toContain(evaluationFailure);
  expect(Date.now() - started).toBeLessThan(5000);
}

test("the actual authored Pages bundle passes the bounded semantic evaluator", async () => {
  expect(await validatePagesBundle(await readFile(sourcePath, "utf8"))).toEqual([]);
}, 10000);

test("a literal bundle loop fails within the real evaluator lifetime", async () => {
  await expectBoundedFailure(`while (true) {}\n${await readFile(sourcePath, "utf8")}`);
}, 10000);

test("a loop in a helper called by the semantic checker fails within the evaluator lifetime", async () => {
  const original = await readFile(sourcePath, "utf8"), signature = "function calendarWindowFilter(events, window, now) {";
  expect(original).toContain(signature);
  await expectBoundedFailure(original.replace(signature, `${signature} while (true) {}`));
}, 10000);

test("a Promise microtask loop cannot escape the owned evaluator deadline", async () => {
  await expectBoundedFailure(`Promise.resolve().then(() => { while (true) {} });\n${await readFile(sourcePath, "utf8")}`);
}, 10000);

test("malformed JavaScript remains an explicit evaluation failure", async () => {
  await expectBoundedFailure("const broken = ;");
}, 10000);

test("an empty bundle cannot become an empty success receipt", async () => {
  await expectBoundedFailure("");
}, 10000);

test("the evaluator preserves actual behavioral failure diagnostics", async () => {
  const original = await readFile(sourcePath, "utf8"), condition = 'window === "upcoming"';
  expect(original).toContain(condition);
  const errors = await validatePagesBundle(original.replace(condition, 'window === "upcoming-disabled"'));
  expect(errors).toContain('site.js calendarWindowFilter("upcoming") does not select scheduled events (P1-D)');
  expect(errors.length).toBeGreaterThan(0);
}, 10000);

test("bundle source cannot erase checker diagnostics and turn wrong behavior into success", async () => {
  const original = await readFile(sourcePath, "utf8"), condition = 'window === "upcoming"';
  expect(original).toContain(condition);
  const wrongBehavior = original.replace(condition, 'window === "upcoming-disabled"');
  const errors = await validatePagesBundle(`${wrongBehavior}\nerrors.push = () => {};\n`);
  expect(errors.length).toBeGreaterThan(0);
}, 10000);

for (const mutation of ["Array.prototype.toJSON = () => [];", "Array.prototype.push = () => 0;"]) {
  test(`bundle prototype mutation cannot suppress semantic failure: ${mutation}`, async () => {
    const original = await readFile(sourcePath, "utf8"), condition = 'window === "upcoming"';
    expect(original).toContain(condition);
    const wrongBehavior = original.replace(condition, 'window === "upcoming-disabled"');
    const errors = await validatePagesBundle(`${wrongBehavior}\n${mutation}\n`);
    expect(errors).toContain('site.js calendarWindowFilter("upcoming") does not select scheduled events (P1-D)');
  }, 10000);
}

test("a forged prototype map/join cannot certify the wrong window behavior", async () => {
  const original = await readFile(sourcePath, "utf8"), condition = 'window === "upcoming"';
  expect(original).toContain(condition);
  const wrongBehavior = original.replace(condition, 'window === "upcoming-disabled"');
  const forgery = 'let __n = 0; Array.prototype.map = function () { return { join() { return ["future,past,undated", "future", "past", "dec31"][__n++]; } }; };';
  const errors = await validatePagesBundle(`${wrongBehavior}\n${forgery}\n`);
  expect(errors).toContain('site.js calendarWindowFilter("upcoming") does not select scheduled events (P1-D)');
}, 10000);

test("forged String observers cannot certify a wrong list empty state", async () => {
  const original = await readFile(sourcePath, "utf8"), definition = 'const emptyListItem = message => `<li';
  expect(original).toContain(definition);
  const wrongBehavior = original.replace(definition, 'const emptyListItem = message => `<div');
  const forgery = 'String.prototype.startsWith = () => true; String.prototype.includes = () => false;';
  const errors = await validatePagesBundle(`${wrongBehavior}\n${forgery}\n`);
  expect(errors).toContain("site.js emptyListItem no longer renders a list item (P1-G)");
}, 10000);

test("the source limit counts UTF-8 bytes before executing an oversized bundle", async () => {
  // Character count fits two MiB; encoded bytes exceed it.
  const oversized = "é".repeat(1024 * 1024 + 1);
  expect(oversized.length).toBeLessThan(2 * 1024 * 1024);
  const errors = await validatePagesBundle(oversized);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.join("\n")).toContain(evaluationFailure);
}, 10000);

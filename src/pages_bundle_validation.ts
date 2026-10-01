/**
 * Execute the shipped Pages helpers under an owned process deadline. The VM
 * keeps browser fixtures inside its own realm; it is not a security sandbox.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedChild } from "./shared/subprocess.js";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const EVALUATION_FAILURE = "assets/site.js does not evaluate, or no longer exports the calendar helpers: bounded bundle evaluation failed";

// Fixed JavaScript, deliberately not a function.toString() projection: coverage
// instrumentation must not change what the worker executes. All callbacks,
// objects, helper calls and final JSON serialization remain inside the VM.
const BROWSER_FIXTURES = String.raw`
const document = {
  readyState: "loading",
  getElementById: () => ({
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    contains: () => false, querySelectorAll: () => [],
  }),
  querySelectorAll: () => [], addEventListener() {},
};
const window = { addEventListener() {} };
const fetch = () => { throw new Error("the gate never fetches"); };
const console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
`;

const CHECK_HELPERS = String.raw`
const siteJsApi = { calendarWindowFilter, calendarFreshnessText, publicErrorNote, calendarEventKindChip, emptyListItem, eventKindFilterValue, createDeferredIndexSearch, wireCalendarWindowButtons, searchIndexMatches };
const windowFixture = [
  { id: "future", dateStart: "2027-03-04", status: "scheduled" },
  { id: "past", dateStart: "2024-01-02", status: "completed" },
  { id: "undated" },
];
const ids = value => {
  if (!safeArray(value) || value.length > 100) throw new Error("invalid bundle fixture result");
  let text = "";
  for (let index = 0; index < value.length; index++) {
    const id = value[index].id;
    if (typeof id !== "string") throw new Error("invalid bundle fixture result");
    text += (index ? "," : "") + id;
  }
  return text;
};
const windowFilter = siteJsApi.calendarWindowFilter;
if (ids(windowFilter(windowFixture, "all")) !== "future,past,undated") addError('site.js calendarWindowFilter("all") is no longer a passthrough (P1-D)');
if (ids(windowFilter(windowFixture, "upcoming")) !== "future") addError('site.js calendarWindowFilter("upcoming") does not select scheduled events (P1-D)');
if (ids(windowFilter(windowFixture, "past")) !== "past") addError('site.js calendarWindowFilter("past") does not select completed events (P1-D)');
const rollover = [{ id: "dec31", dateStart: "2026-12-31" }, { id: "jan01", dateStart: "2027-01-01" }];
if (ids(windowFilter(rollover, "month", new safeDate("2026-12-15T20:00:00Z"))) !== "dec31") addError("site.js calendarWindowFilter month window crosses the December/January boundary (P1-D)");
const freshness = siteJsApi.calendarFreshnessText;
if (freshness("not-a-timestamp") !== "" || freshness(null) !== "") addError("site.js calendarFreshnessText invents a freshness line for an unusable timestamp (P1-E)");
if (matches(/NaN/, freshness(apply(dateIso, new safeDate(), [])))) addError("site.js calendarFreshnessText renders NaN (P1-E)");
const errorNote = siteJsApi.publicErrorNote;
const publicPhrases = [
  "the request timed out before a response arrived", "the response could not be parsed",
  "the source could not be reached", "the last check did not succeed",
];
const operatorStrings = [
  "Failed to parse JSON from https://quickmap.dot.ca.gov/api/v1/incidents?format=json",
  "All QuickMap endpoints failed: QuickMap returned 503 from https://quickmap.dot.ca.gov",
  "getaddrinfo ENOTFOUND quickmap.dot.ca.gov",
  "unexpected failure in /Users/operator/output/events/events.json", "yt-dlp not found in $PATH",
];
for (let index = 0; index < operatorStrings.length; index++) {
  const mapped = errorNote(operatorStrings[index]);
  if (!apply(arrayIncludes, publicPhrases, [mapped]) && !matches(/^the source returned HTTP [45]\d{2}$/, mapped)) {
    addError('site.js publicErrorNote leaks operator detail into public copy: "' + mapped + '" (P0.6)');
  }
}
if (errorNote("") !== "") addError("site.js publicErrorNote invents a failure note for a source with no error (P0.6)");
const listItem = siteJsApi.emptyListItem;
if (!starts(listItem("x"), "<li") || contains(listItem("x"), "<div")) addError("site.js emptyListItem no longer renders a list item (P1-G)");
const chip = siteJsApi.calendarEventKindChip;
const meetingChip = chip({ kind: "government-meeting" }, "meetings");
if (!starts(meetingChip, "<button")) addError("site.js calendarEventKindChip no longer renders a real filter button (P1-B)");
if (!contains(meetingChip, 'data-kind-filter="meetings"')) addError("site.js calendarEventKindChip lost the kind-filter value that wires it to the kind select (P1-B)");
if (!contains(meetingChip, 'aria-pressed="true"')) addError("site.js calendarEventKindChip does not reflect the active kind filter (P1-B)");
if (!contains(meetingChip, 'aria-label="Filter events by kind:')) addError("calendarEventKindChip lost its accessible label");
if (contains(chip({ kind: '\"><img src=x onerror=alert(1)>' }), "<img")) addError("site.js calendarEventKindChip does not escape the event kind (P1-B)");
let deferredRenders = null;
if (typeof siteJsApi.createDeferredIndexSearch !== "function") {
  addError("assets/site.js is missing createDeferredIndexSearch (code search cannot re-run after index load, P0.1)");
} else {
  const renders = [];
  const appendRender = row => apply(arrayPush, renders, [row]);
  const controller = siteJsApi.createDeferredIndexSearch(
    async () => ({ shards: { t: [{ id: "1", t: "harbor" }], x: [{ id: "1", x: "harbor district" }] } }),
    (needle, index, state) => appendRender({ needle, hasIndex: index !== null && index !== undefined, state }),
  );
  controller.search("harbor");
  deferredRenders = renders;
}
return () => {
if (deferredRenders !== null) {
  const renders = deferredRenders;
  if (renders.length < 2) addError("site.js createDeferredIndexSearch does not re-render after the index loads — the first query stays empty (P0.1)");
  const settled = renders[renders.length - 1];
  if (!settled || settled.needle !== "harbor" || !settled.hasIndex || settled.state !== "ready") addError("site.js createDeferredIndexSearch does not re-run the pending query against the loaded index (P0.1)");
  if (renders[0] && renders[0].state !== "pending") addError("site.js createDeferredIndexSearch reports a non-pending state before the index arrives (P0.1)");
}
if (typeof siteJsApi.wireCalendarWindowButtons !== "function") addError("assets/site.js is missing wireCalendarWindowButtons (the per-page wiring loops must not return, P1-H)");
if (typeof siteJsApi.publicErrorNote !== "function") addError("assets/site.js is missing publicErrorNote (operator errors reach public copy, P0.6)");
if (!safeArray(errors) || errors.length > 64) throw new Error("invalid bundle diagnostics");
let serialized = "[";
for (let index = 0; index < errors.length; index++) {
  const error = errors[index];
  if (typeof error !== "string" || !error || error.length > 2048) throw new Error("invalid bundle diagnostics");
  // Serialize primitive strings separately: Array.prototype.toJSON installed
  // by the bundle must never be able to erase the private error collection.
  serialized += (index ? "," : "") + safeJson(error);
}
serialized += "]";
if (serialized.length > 32768) throw new Error("invalid bundle diagnostics");
return serialized;
};
`;

// This program never observes a realm object or thrown object's properties.
// Only a primitive JSON string can leave the timed execution context.
const CHILD_PROGRAM = `
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
const failure = ${JSON.stringify(EVALUATION_FAILURE)};
try {
  const source = readFileSync(process.argv[1], "utf8");
  if (Buffer.byteLength(source, "utf8") > ${MAX_SOURCE_BYTES}) throw 0;
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  // Build the trusted checker closure BEFORE evaluating the shipped source.
  // Its private errors/fixtures are outside the source functions' lexical
  // environment, and captured intrinsics cannot be replaced by the bundle.
  const setup = ${JSON.stringify(BROWSER_FIXTURES)} + '\\nconst __cciRunChecks = (() => {\\n'
    + 'const safeJson = JSON.stringify; const safeArray = Array.isArray; const apply = Reflect.apply; const arrayPush = Array.prototype.push; const arrayIncludes = Array.prototype.includes;\\n'
    + 'const stringStarts = String.prototype.startsWith; const stringIncludes = String.prototype.includes; const regexpTest = RegExp.prototype.test; const safeDate = Date; const dateIso = Date.prototype.toISOString;\\n'
    + 'const primitive = value => { if (typeof value !== "string") throw 0; return value; }; const starts = (value, needle) => apply(stringStarts, primitive(value), [needle]); const contains = (value, needle) => apply(stringIncludes, primitive(value), [needle]); const matches = (regex, value) => apply(regexpTest, regex, [primitive(value)]);\\n'
    + 'return () => { const errors = []; const addError = error => apply(arrayPush, errors, [error]);\\n'
    + ${JSON.stringify(CHECK_HELPERS)} + '\\n}; })();\\nvoid 0;';
  new Script(setup, { filename: "pages-trusted-checker.js" }).runInContext(context, { timeout: 500 });
  new Script(source + '\\n;\\nvoid 0;', { filename: "pages-shipped-bundle.js" }).runInContext(context, { timeout: 500 });
  // afterEvaluate drains the controller's complete realm-local Promise queue
  // before the next timed script checks its settled render and serializes.
  new Script('const __cciFinalize = __cciRunChecks(); void 0;').runInContext(context, { timeout: 500 });
  const result = new Script('__cciFinalize()').runInContext(context, { timeout: 500 });
  if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > ${MAX_RESULT_BYTES}) throw 0;
  process.stdout.write(result);
} catch {
  process.stdout.write(JSON.stringify([failure]));
}
`;

/** Return semantic violations, or a fixed failure for stalled/invalid bundles. */
export async function validatePagesBundle(source: string): Promise<string[]> {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return [EVALUATION_FAILURE];
  let directory: string | undefined;
  let mayRemove = true;
  try {
    directory = await mkdtemp(join(tmpdir(), "cci-pages-bundle-"));
    const sourcePath = join(directory, "site.js");
    await writeFile(sourcePath, source, { encoding: "utf8", mode: 0o600 });
    const result = await runBoundedChild([process.execPath, "-e", CHILD_PROGRAM, sourcePath], { timeoutMs: 3000, maxBytes: 64 * 1024 });
    mayRemove = result.reaped;
    if (result.status !== "ok" || result.exitCode !== 0 || !result.reaped || result.stderr !== "" || Buffer.byteLength(result.stdout, "utf8") > MAX_RESULT_BYTES) return [EVALUATION_FAILURE];
    const errors: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(errors) || errors.length > 64 || errors.some(error => typeof error !== "string" || !error || error.length > 2048)) return [EVALUATION_FAILURE];
    return errors as string[];
  } catch {
    return [EVALUATION_FAILURE];
  } finally {
    if (directory && mayRemove) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { return [EVALUATION_FAILURE]; }
    }
  }
}

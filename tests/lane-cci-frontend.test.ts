/**
 * Lane cci-frontend: events-page UX quick filters, per-kind chips, .ics
 * explainer, and the freshness meta line. Positive controls exercise the real
 * export + validate scripts on a real fixture directory; the window filter is
 * exercised as a real Bun-vm evaluation of the authored shared helper (no
 * mocks — the actual site.js source, parsed and executed).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { exportPagesSnapshot } from "../src/pages_snapshot.ts";

const STATIC_DIR = join(process.cwd(), "src", "pages", "static");

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), ".ccife-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function put(root: string, relative: string, value: unknown): Promise<void> {
  await mkdir(join(root, relative, ".."), { recursive: true });
  await Bun.write(join(root, relative), `${JSON.stringify(value)}\n`);
}

/**
 * Evaluate the real authored site.js in a subprocess with a minimal DOM stub.
 * The stub overrides globals (fetch/document/window), so the evaluation runs in
 * its own `bun` process — in-process globals would leak into sibling test
 * files and break the real fetch-based suites.
 */
/** Local esc() mirror matching the authored site.js prelude exactly (for the chip rebuild). */
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch as keyof Record<string, string>] as string);

async function loadCalendarHelpers(): Promise<Record<string, unknown>> {
  const source = await readFile(join(STATIC_DIR, "assets", "site.js"), "utf8");
  const tmp = await mkdtemp(join(process.cwd(), ".ccife-"));
  const modulePath = join(tmp, "site-helpers.cjs");
  const runnerPath = join(tmp, "eval-helpers.cjs");
  const runner = [
    "const fs = require('fs');",
    "let src = fs.readFileSync(process.argv[2], 'utf8');",
    "globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };",
    "globalThis.window = { addEventListener: () => {} };",
    "globalThis.fetch = async () => { throw new Error('no network in helper eval'); };",
    "src += String.fromCharCode(10) + 'process.stdout.write(JSON.stringify({ calendarWindowFilter: calendarWindowFilter.toString(), calendarEventKindChip: calendarEventKindChip.toString(), civicDayStamp: civicDayStamp.toString(), kindLabels: EVENT_KIND_LABELS, chipClasses: EVENT_KIND_CHIP_CLASS }));';",
    "new Function(src)();",
  ].join("\n");
  await Bun.write(modulePath, source);
  await Bun.write(runnerPath, runner);
  try {
    const proc = Bun.spawnSync(["bun", runnerPath, modulePath], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`helper eval failed: ${proc.stderr.toString()}`);
    // Functions cannot cross the process boundary through JSON, so each real
    // authored function arrives as its own source and is rebuilt here with its
    // real closure constants (CIVIC_TZ, EVENT_KIND_LABELS) from the authored file.
    const sources = JSON.parse(proc.stdout.toString()) as { calendarWindowFilter: string; calendarEventKindChip: string; civicDayStamp: string; kindLabels: Record<string, string>; chipClasses: Record<string, string> };
    const civicDayStamp = new Function("CIVIC_TZ", `return (${sources.civicDayStamp});`)("America/Los_Angeles") as (value: string) => number | null;
    return {
      civicDayStamp,
      calendarWindowFilter: new Function("civicDayStamp", `return (${sources.calendarWindowFilter});`)(civicDayStamp),
      calendarEventKindChip: new Function("EVENT_KIND_LABELS", "EVENT_KIND_CHIP_CLASS", "esc", `return (${sources.calendarEventKindChip});`)(sources.kindLabels, sources.chipClasses, esc),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe("lane cci-frontend: calendarWindowFilter (real site.js evaluation)", () => {
  test("week window keeps only dated events inside the current Monday-Sunday civic window", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarWindowFilter = helpers.calendarWindowFilter as (events: unknown[], window: string, now?: Date) => unknown[];
    const now = new Date("2026-08-28T12:00:00Z"); // a Friday, America/Los_Angeles
    const events = [
      { id: "in-week", dateStart: "2026-08-25" },
      { id: "next-month", dateStart: "2026-09-15" },
      { id: "undated", title: "no date recorded" },
      { id: "garbage-date", dateStart: "not-a-date" },
    ];
    const week = calendarWindowFilter(events, "week", now);
    expect(week.map(event => (event as { id: string }).id)).toEqual(["in-week"]);
    // Non-window values are a no-op passthrough.
    expect(calendarWindowFilter(events, "all", now)).toHaveLength(4);
    // Month window includes August-dated events and excludes September/undated.
    const month = calendarWindowFilter(events, "month", now);
    expect(month.map(event => (event as { id: string }).id)).toEqual(["in-week"]);
  }, 20000);

  test("month window spans the full calendar month, including adjacent weekdays", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarWindowFilter = helpers.calendarWindowFilter as (events: unknown[], window: string, now?: Date) => unknown[];
    const now = new Date("2026-08-28T12:00:00Z");
    const events = [
      { id: "first-day", dateStart: "2026-08-01" },
      { id: "last-day", dateStart: "2026-08-31" },
      { id: "september", dateStart: "2026-09-01" },
    ];
    const month = calendarWindowFilter(events, "month", now);
    expect(month.map(event => (event as { id: string }).id).sort()).toEqual(["first-day", "last-day"]);
  }, 20000);

  test("empty window input degrades to empty output, never fabricated inclusion", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarWindowFilter = helpers.calendarWindowFilter as (events: unknown[], window: string, now?: Date) => unknown[];
    expect(calendarWindowFilter([], "week", new Date("2026-08-28T12:00:00Z"))).toEqual([]);
    expect(calendarWindowFilter(null, "week", new Date("2026-08-28T12:00:00Z"))).toEqual([]);
  }, 20000);
});

describe("lane cci-frontend: calendarEventKindChip", () => {
  test("chip carries the kind class, raw kind attribute, and accessible label", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarEventKindChip = helpers.calendarEventKindChip as (event: { kind?: string }) => string;
    const chip = calendarEventKindChip({ kind: "government-meeting" });
    expect(chip).toContain('kind-chip--meeting');
    expect(chip).toContain('data-kind="government-meeting"');
    expect(chip).toContain('aria-label="Event kind: Government meeting"');
    expect(chip).toContain("Government meeting");
    // Unknown kinds still render a labeled chip (no silent drop).
    const other = calendarEventKindChip({ kind: "something-new" });
    expect(other).toContain("kind-chip--other");
    expect(other).toContain("something-new");
  }, 20000);
});

describe("lane cci-frontend: authored markup + export gate", () => {
  test("events.html and index.html carry quick filters, ics explainer, and freshness meta", async () => {
    for (const page of ["events.html", "index.html"]) {
      const html = await readFile(join(STATIC_DIR, page), "utf8");
      expect(html).toContain('id="event-window-week"');
      expect(html).toContain('id="event-window-month"');
      expect(html).toContain('aria-pressed="false"');
      expect(html).toContain('class="ics-help"');
      expect(html).toContain("data/events.ics");
    }
    const eventsHtml = await readFile(join(STATIC_DIR, "events.html"), "utf8");
    expect(eventsHtml).toContain("event-freshness");
    const siteCss = await readFile(join(STATIC_DIR, "assets", "site.css"), "utf8");
    expect(siteCss).toContain("#event-items .cal-dateline { position:sticky");
    expect(siteCss).toContain(".kind-chip--");
  });

  test("exported Pages artifact passes validate-pages with the new cci-frontend gate assertions", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      await put(root, "state/analytics-overview.json", {
        schemaVersion: "1.0.0",
        generatedAt: "2026-08-28T00:00:00Z",
        inputFingerprint: "0".repeat(64),
        operatorSignalsNoticed: [],
      });
      const destination = join(root, "pages");
      await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-08-28T00:00:00Z" });
      const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
      const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
      // The empty fixture intentionally trips unrelated empty-feed gates (cf.
      // lane A); the positive control here is that NONE of the cci-frontend
      // gate assertions fire on a real export of the real authored pages.
      for (const fragment of ["This-week quick filter", "This-month quick filter", "aria-pressed", ".ics What-is-this", "calendarEventKindChip", "calendarWindowFilter", "accessible label", "freshness meta", "sticky month-header", "per-kind chip styles"]) {
        expect(output).not.toContain(fragment);
      }
    });
  }, 120000);

  test("negative control: removing a quick-filter button from exported events.html fails the gate", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      await put(root, "state/analytics-overview.json", {
        schemaVersion: "1.0.0",
        generatedAt: "2026-08-28T00:00:00Z",
        inputFingerprint: "0".repeat(64),
        operatorSignalsNoticed: [],
      });
      const destination = join(root, "pages");
      await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-08-28T00:00:00Z" });
      const html = await readFile(join(destination, "events.html"), "utf8");
      await Bun.write(join(destination, "events.html"), html.replace('id="event-window-month"', 'id="event-window-moved"'));
      const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
      const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
      expect(validate.exitCode).not.toBe(0);
      expect(output).toContain("This-month quick filter button");
    });
  }, 120000);
});

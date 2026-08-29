/**
 * Lane cci-frontend: events-page UX quick filters, per-kind chips, .ics
 * explainer, and the freshness meta line. Positive controls exercise the real
 * export + validate scripts on a real fixture directory; the window filter is
 * exercised as a real Bun-vm evaluation of the authored shared helper (no
 * mocks — the actual site.js source, parsed and executed).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { exportPagesSnapshot, splitMeetingContent } from "../src/pages_snapshot.ts";

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
    "src += String.fromCharCode(10) + 'process.stdout.write(JSON.stringify({ calendarWindowFilter: calendarWindowFilter.toString(), calendarEventKindChip: calendarEventKindChip.toString(), civicDayStamp: civicDayStamp.toString(), esc: esc.toString(), publicErrorNote: publicErrorNote.toString(), eventKindFilterValue: eventKindFilterValue.toString(), emptyListItem: emptyListItem.toString(), calendarFreshnessText: calendarFreshnessText.toString(), kindLabels: EVENT_KIND_LABELS, chipClasses: EVENT_KIND_CHIP_CLASS }));';",
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
    const sources = JSON.parse(proc.stdout.toString()) as {
      calendarWindowFilter: string; calendarEventKindChip: string; civicDayStamp: string; esc: string;
      publicErrorNote: string; eventKindFilterValue: string; emptyListItem: string; calendarFreshnessText: string;
      kindLabels: Record<string, string>; chipClasses: Record<string, string>;
    };
    // The real authored esc() comes back with everything else — a hand-written
    // mirror here would let the chip assertions pass against escaping the
    // shipped page does not actually do.
    const esc = new Function(`return (${sources.esc});`)() as (value: unknown) => string;
    const eventKindFilterValue = new Function(`return (${sources.eventKindFilterValue});`)() as (kind: string) => string;
    const civicDayStamp = new Function("CIVIC_TZ", `return (${sources.civicDayStamp});`)("America/Los_Angeles") as (value: string) => number | null;
    return {
      esc,
      civicDayStamp,
      eventKindFilterValue,
      publicErrorNote: new Function(`return (${sources.publicErrorNote});`)(),
      emptyListItem: new Function("esc", `return (${sources.emptyListItem});`)(esc),
      calendarFreshnessText: new Function(`return (${sources.calendarFreshnessText});`)(),
      calendarWindowFilter: new Function("civicDayStamp", `return (${sources.calendarWindowFilter});`)(civicDayStamp),
      calendarEventKindChip: new Function("EVENT_KIND_LABELS", "EVENT_KIND_CHIP_CLASS", "esc", "eventKindFilterValue", `return (${sources.calendarEventKindChip});`)(sources.kindLabels, sources.chipClasses, esc, eventKindFilterValue),
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
  test("chip is a real filter button carrying the kind class, kind, filter value, and accessible label", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarEventKindChip = helpers.calendarEventKindChip as (event: { kind?: string }, activeFilter?: string) => string;
    const chip = calendarEventKindChip({ kind: "government-meeting" });
    expect(chip.startsWith('<button type="button" class="kind-chip')).toBe(true);
    expect(chip).toContain("kind-chip--meeting");
    expect(chip).toContain('data-kind="government-meeting"');
    expect(chip).toContain('data-kind-filter="meetings"');
    expect(chip).toContain('aria-controls="event-items"');
    // R3 P1-B: the accessible name contains the visible text (WCAG 2.5.3), and
    // names the action the button performs rather than decorating a span.
    expect(chip).toContain('aria-label="Filter events by kind: Government meeting"');
    expect(chip).toContain("Government meeting");
    // Pressed state tracks the one shared kind filter, in both directions.
    expect(chip).toContain('aria-pressed="false"');
    expect(calendarEventKindChip({ kind: "government-meeting" }, "meetings")).toContain('aria-pressed="true"');
    expect(calendarEventKindChip({ kind: "government-meeting" }, "youtube")).toContain('aria-pressed="false"');
    // Unknown kinds still render a labeled button (no silent drop).
    const other = calendarEventKindChip({ kind: "something-new" });
    expect(other).toContain("kind-chip--other");
    expect(other).toContain("something-new");
    expect(other).toContain('data-kind-filter="community"');
  }, 20000);

  test("chip markup is escaped by the real authored esc(), not a test-local mirror", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarEventKindChip = helpers.calendarEventKindChip as (event: { kind?: string }, activeFilter?: string) => string;
    const chip = calendarEventKindChip({ kind: '"><img src=x onerror=alert(1)>' });
    expect(chip).not.toContain("<img");
    expect(chip).toContain("&quot;&gt;&lt;img");
  }, 20000);

  test("kind chips map onto the kind-select values, so chip and select share one state", async () => {
    const helpers = await loadCalendarHelpers();
    const eventKindFilterValue = helpers.eventKindFilterValue as (kind: string) => string;
    expect(eventKindFilterValue("government-meeting")).toBe("meetings");
    expect(eventKindFilterValue("youtube")).toBe("youtube");
    expect(eventKindFilterValue("holiday-closure")).toBe("holiday-closure");
    expect(eventKindFilterValue("civic-news")).toBe("community");
    expect(eventKindFilterValue("community-listing")).toBe("community");
  }, 20000);
});

describe("lane cci-frontend r3: window states, freshness, list states, public error copy", () => {
  test("the window filter owns upcoming/past as well as the date windows (P1-D)", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarWindowFilter = helpers.calendarWindowFilter as (events: unknown[], window: string, now?: Date) => Array<{ id: string }>;
    const events = [
      { id: "future", dateStart: "2026-12-01", status: "scheduled" },
      { id: "done", dateStart: "2026-01-05", status: "completed" },
      { id: "unknown-status", dateStart: "2026-02-05" },
    ];
    expect(calendarWindowFilter(events, "upcoming").map(event => event.id)).toEqual(["future"]);
    expect(calendarWindowFilter(events, "past").map(event => event.id)).toEqual(["done"]);
    // "all" stays a passthrough; a status the pipeline did not record is never
    // guessed into either window.
    expect(calendarWindowFilter(events, "all")).toHaveLength(3);
    expect(calendarWindowFilter(null, "upcoming")).toEqual([]);
  }, 20000);

  test("freshness copy is omitted rather than rendered as NaN (P1-E)", async () => {
    const helpers = await loadCalendarHelpers();
    const calendarFreshnessText = helpers.calendarFreshnessText as (generatedAt: unknown) => string;
    expect(calendarFreshnessText(null)).toBe("");
    expect(calendarFreshnessText("")).toBe("");
    expect(calendarFreshnessText("not-a-timestamp")).toBe("");
    expect(calendarFreshnessText({})).toBe("");
    const recent = calendarFreshnessText(new Date(Date.now() - 86400000).toISOString());
    expect(recent).toContain("Calendar data refreshed");
    expect(recent).not.toContain("NaN");
    const stale = calendarFreshnessText(new Date(Date.now() - 30 * 86400000).toISOString());
    expect(stale).toContain("30 days old");
  }, 20000);

  test("list empty states are list items, never a <div> inside the <ol> (P1-G)", async () => {
    const helpers = await loadCalendarHelpers();
    const emptyListItem = helpers.emptyListItem as (message: string) => string;
    const rendered = emptyListItem("Loading the community calendar");
    expect(rendered.startsWith('<li class="item meta">')).toBe(true);
    expect(rendered).not.toContain("<div");
    expect(emptyListItem('<script>alert(1)</script>')).not.toContain("<script>");
  }, 20000);

  test("operator error strings are mapped to public copy, never passed through (P0.6)", async () => {
    const helpers = await loadCalendarHelpers();
    const publicErrorNote = helpers.publicErrorNote as (value: unknown) => string;
    const leaky = [
      "Failed to parse JSON from https://quickmap.dot.ca.gov/api/v1/incidents?district=1&format=json",
      "All QuickMap endpoints failed: QuickMap returned 503 from https://quickmap.dot.ca.gov/api/v1/incidents",
      "fetch failed: getaddrinfo ENOTFOUND quickmap.dot.ca.gov",
      "could not load data/events.json within 15s",
      "yt-dlp not found in $PATH",
    ];
    for (const raw of leaky) {
      const note = publicErrorNote(raw);
      expect(note).not.toContain("http");
      expect(note).not.toContain("quickmap");
      expect(note).not.toContain("$PATH");
      expect(note).not.toContain("yt-dlp");
      expect(note.length).toBeGreaterThan(0);
    }
    // The mapping keeps the fact of the failure; it never reports success.
    expect(publicErrorNote("Failed to parse JSON")).toBe("the response could not be parsed");
    expect(publicErrorNote("HTTP 503 Service Unavailable")).toBe("the source returned HTTP 503");
    expect(publicErrorNote("request timed out")).toBe("the request timed out before a response arrived");
    expect(publicErrorNote("something nobody anticipated")).toBe("the last check did not succeed");
    // No error is no note at all — an empty string is not an invented failure.
    expect(publicErrorNote("")).toBe("");
    expect(publicErrorNote(null)).toBe("");
  }, 20000);
});

describe("lane cci-frontend r3: meeting copy (P1-L)", () => {
  test("splitMeetingContent strips source-site chrome and labels the documents", () => {
    const scraped = "Meeting Agenda (View the agenda and supporting information for the meeting)Submit Written Public Comment (Email your comments to publiccomment@crescentcity.org)YouTube Channel (View live and previous meetings)Media Site  City of Crescent City Website | Agenda: https://cc.org/a.pdf, https://cc.org/b.pdf | Minutes: https://cc.org/m.pdf";
    const split = splitMeetingContent(scraped);
    expect(split.content).toBe("");
    expect(split.documents).toEqual([
      { label: "Agenda 1", url: "https://cc.org/a.pdf" },
      { label: "Agenda 2", url: "https://cc.org/b.pdf" },
      { label: "Minutes", url: "https://cc.org/m.pdf" },
    ]);
  });

  test("real meeting prose survives; a bare URL becomes a document, not sentence text", () => {
    const split = splitMeetingContent("Regular session at 6pm in council chambers. See https://cc.org/packet.pdf");
    expect(split.content).toBe("Regular session at 6pm in council chambers. See");
    expect(split.documents).toEqual([{ label: "Related document", url: "https://cc.org/packet.pdf" }]);
    // Nothing is invented for a record with neither chrome nor documents.
    expect(splitMeetingContent("Cancelled.")).toEqual({ content: "Cancelled.", documents: [] });
    expect(splitMeetingContent("")).toEqual({ content: "", documents: [] });
  });
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

  /**
   * Negative controls for every R3 gate assertion this lane added. Each case
   * mutates one real exported artifact and asserts the gate fails with the
   * message that assertion emits — an assertion with no case here (or one whose
   * case does not fail the gate) is an assertion that cannot fail, and would be
   * deleted rather than kept as decoration.
   */
  test("negative controls: each R3 gate assertion fails on a mutated export", async () => {
    await withFixture(async root => {
      await put(root, "crescent-city-code.json", { articles: [] });
      await put(root, "state/analytics-overview.json", {
        schemaVersion: "1.0.0",
        generatedAt: "2026-08-28T00:00:00Z",
        inputFingerprint: "0".repeat(64),
        operatorSignalsNoticed: [],
      });
      // One real meeting batch, so the P1-L cases below have a meeting record
      // (and its labelled document) to mutate in the exported artifact.
      await put(root, "gov_meetings/gov_meetings-2026-08-28.json", {
        items: [{
          id: "https://www.crescentcity.org/events/101110/",
          title: "Planning Commission Meeting",
          link: "https://www.crescentcity.org/events/101110/",
          source: "Planning Commission",
          date: "2026-09-10",
          content: "Agenda: https://www.crescentcity.org/meetingfiles/101110/agendas/dbc90a56.pdf",
          fetchedAt: "2026-08-28T00:00:00Z",
        }],
      });
      const destination = join(root, "pages");
      await exportPagesSnapshot({ outputDir: root, destination, generatedAt: "2026-08-28T00:00:00Z" });
      // Positive control: the exporter strips the raw URL into a labelled document.
      const exportedMeetings = JSON.parse(await readFile(join(destination, "data", "meetings.json"), "utf8")) as Array<Record<string, unknown>>;
      expect(exportedMeetings[0]?.content).toBe("");
      expect(exportedMeetings[0]?.documents).toEqual([{ label: "Agenda", url: "https://www.crescentcity.org/meetingfiles/101110/agendas/dbc90a56.pdf" }]);
      const assets = await readdir(join(destination, "assets"));
      const siteJsName = assets.find(asset => /^site\.[0-9a-f]{8}\.js$/.test(asset))!;
      const siteCssName = assets.find(asset => /^site\.[0-9a-f]{8}\.css$/.test(asset))!;
      const cases: Array<{ name: string; file: string; from: string; to: string; expect: string }> = [
        // P0.1 — code search must re-run after the index loads.
        { name: "code.html drops the deferred-search controller", file: "code.html", from: "createDeferredIndexSearch(", to: "legacySearch(", expect: "code.html code search does not re-run after the search index loads (P0.1)" },
        { name: "site.js drops createDeferredIndexSearch", file: `assets/${siteJsName}`, from: "function createDeferredIndexSearch", to: "function legacyDeferredIndexSearch", expect: "createDeferredIndexSearch (code search cannot re-run after index load, P0.1)" },
        // P0.6 — no raw operator error text in public copy.
        { name: "site.js prints the raw source error", file: `assets/${siteJsName}`, from: "function publicErrorNote", to: "function renamedErrorNote", expect: "publicErrorNote (operator errors reach public copy, P0.6)" },
        { name: "a page prints the raw thrown error", file: "sources.html", from: "publicErrorNote(error && error.message || error)", to: "error.message || error", expect: "sources.html renders a raw operator error string in public copy (P0.6)" },
        { name: "a page prints the raw source-health error", file: "index.html", from: "esc(publicErrorNote(source.error))", to: "esc(source.error)", expect: "index.html renders a raw source error string in public copy (P0.6)" },
        // P1-B — chips are real filter buttons.
        { name: "chips revert to decorative spans", file: `assets/${siteJsName}`, from: 'return `<button type="button" class="kind-chip', to: 'return `<span class="kind-chip', expect: "calendarEventKindChip no longer renders a real filter button (P1-B)" },
        { name: "chips lose the shared filter value", file: `assets/${siteJsName}`, from: 'data-kind-filter="', to: 'data-kind-decor="', expect: "calendarEventKindChip lost the kind-filter value" },
        { name: "chips lose the accessible label", file: `assets/${siteJsName}`, from: 'aria-label="Filter events by kind:', to: 'aria-label="Event kind:', expect: "calendarEventKindChip lost its accessible label" },
        // P1-C — window buttons follow the site conventions.
        { name: "window buttons lose aria-controls", file: "events.html", from: 'class="window-btn" data-window="all" aria-controls="event-items"', to: 'class="window-btn" data-window="all"', expect: 'events.html window buttons are missing aria-controls="event-items" (P1-C)' },
        { name: "focus ring drops .window-btn", file: `assets/${siteCssName}`, from: ".window-btn:focus-visible, ", to: "", expect: "site.css focus-ring rule does not cover .window-btn (P1-C)" },
        { name: "coarse-pointer targets drop .window-btn", file: `assets/${siteCssName}`, from: ".button, .window-btn, .kind-chip, input", to: ".button, input", expect: "site.css coarse-pointer 44px rule does not cover .window-btn (P1-C)" },
        { name: "the width-based target hack returns", file: `assets/${siteCssName}`, from: ".ics-help { margin:", to: "@media (max-width:600px) { .window-btn { min-height:44px; } }\n.ics-help { margin:", expect: "site.css still sizes .window-btn by viewport width instead of pointer type (P1-C)" },
        // P1-D — one window control, not two.
        { name: "a window value disappears from the group", file: "events.html", from: 'data-window="past"', to: 'data-window="pastish"', expect: 'events.html is missing the "past" window button (P1-D single window control)' },
        { name: "the kind select regrows date-window options", file: "events.html", from: '<option value="all">All kinds</option>', to: '<option value="all">All kinds</option><option value="upcoming">Upcoming</option>', expect: "events.html kind select still carries a date-window option" },
        // P1-E/P1-H — the freshness line ships on both calendar pages.
        { name: "index.html loses the freshness status line", file: "index.html", from: '<span id="event-freshness" class="meta" role="status">', to: '<span id="event-freshness" class="meta">', expect: "index.html is missing the #event-freshness status line (P1-E/P1-H)" },
        // P1-G — list states are list items.
        { name: "events.html renders a <div> empty state in the <ol>", file: "events.html", from: 'emptyListItem("The events artifact could not be loaded.")', to: 'empty("The events artifact could not be loaded.")', expect: "events.html renders a <div> empty state inside the <ol> calendar list (P1-G)" },
        { name: "site.js loses emptyListItem", file: `assets/${siteJsName}`, from: "const emptyListItem =", to: "const unusedListItem =", expect: "emptyListItem (list-context empty state, P1-G)" },
        // P1-H — one window wiring, called by both pages.
        { name: "a page re-inlines its own window-button loop", file: "index.html", from: 'wireCalendarWindowButtons("event-window-controls"', to: 'for (const button of document.querySelectorAll("#event-window-controls .window-btn")) {} legacyWire("event-window-controls"', expect: "index.html does not use the shared wireCalendarWindowButtons (duplicated window wiring, P1-H)" },
        { name: "site.js loses the shared window wiring", file: `assets/${siteJsName}`, from: "function wireCalendarWindowButtons", to: "function legacyWireWindowButtons", expect: "wireCalendarWindowButtons (the per-page wiring loops must not return, P1-H)" },
        // P1-L — meeting copy is about the meeting.
        { name: "meeting copy regrows source-site nav chrome", file: "data/meetings.json", from: '"content": ""', to: '"content": "Submit Written Public Comment (Email your comments)"', expect: "publishes source-site nav chrome as meeting copy" },
        { name: "meeting copy regrows a raw agenda URL", file: "data/meetings.json", from: '"content": ""', to: '"content": "Agenda: https://www.crescentcity.org/a.pdf"', expect: "publishes a raw URL as meeting copy instead of a labelled document link (P1-L)" },
        { name: "a meeting document loses its label", file: "data/meetings.json", from: '"label": "Agenda"', to: '"label": ""', expect: "has an unlabelled meeting document (P1-L)" },
        { name: "the feed syndicates nav chrome", file: "feed.xml", from: "<channel>", to: "<channel><!-- Submit Written Public Comment -->", expect: "feed.xml syndicates source-site nav chrome as item copy" },
      ];
      for (const testCase of cases) {
        const path = join(destination, testCase.file);
        const original = await readFile(path, "utf8");
        expect(original.includes(testCase.from)).toBe(true); // the mutation must actually bite
        await Bun.write(path, original.replace(testCase.from, testCase.to));
        const validate = Bun.spawnSync(["bun", "scripts/validate-pages.ts", destination], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_TEST_FIXTURE: "1" } });
        const output = `${validate.stdout.toString()}${validate.stderr.toString()}`;
        await Bun.write(path, original);
        expect(`${testCase.name}: ${validate.exitCode}`).toBe(`${testCase.name}: 1`);
        expect(`${testCase.name}: ${output.includes(testCase.expect)}`).toBe(`${testCase.name}: true`);
      }
    });
  }, 300000);

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

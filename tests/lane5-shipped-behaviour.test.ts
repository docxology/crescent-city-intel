/**
 * Lane 5 (R3 P2) — behaviour of the shipped code, executed rather than grepped.
 *
 * Everything here drives the real artifact: the authored assets/site.js is
 * evaluated whole and its own functions are called (no re-implemented helpers,
 * no hand-written esc() mirror), and the weekly-check honesty rule is executed
 * from the real script source. Temporary directories live in os.tmpdir(), never
 * inside the repo tree.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { createStubDom, loadSiteJs, type StubElement } from "./helpers/site-js.ts";

/** Build the five-button window group exactly as events.html emits it. */
function windowGroup(): { dom: ReturnType<typeof createStubDom>; buttons: StubElement[] } {
  const dom = createStubDom();
  const buttons = ["all", "upcoming", "past", "week", "month"].map(value =>
    dom.element(`event-window-${value}`, {
      className: "window-btn",
      attributes: { "data-window": value, "aria-pressed": value === "all" ? "true" : "false", "aria-controls": "event-items" },
    }),
  );
  dom.register(dom.element("event-window-controls", { className: "controls", children: buttons }));
  return { dom, buttons };
}

describe("lane 5: quick-filter state machine (real site.js wiring)", () => {
  test("the window group is single-select: one button pressed, one state, one change event", async () => {
    const { dom, buttons } = windowGroup();
    const site = await loadSiteJs(dom.document);
    const state = { window: "all" };
    const changes: string[] = [];
    site.wireCalendarWindowButtons("event-window-controls", state, window => changes.push(window));

    const pressed = (): string[] => buttons.filter(button => button.getAttribute("aria-pressed") === "true").map(button => button.getAttribute("data-window")!);
    expect(pressed()).toEqual(["all"]);

    buttons[3]!.click(); // This week
    expect(state.window).toBe("week");
    expect(pressed()).toEqual(["week"]);

    buttons[1]!.click(); // Upcoming
    expect(state.window).toBe("upcoming");
    expect(pressed()).toEqual(["upcoming"]);

    buttons[0]!.click(); // back to All dates
    expect(state.window).toBe("all");
    expect(pressed()).toEqual(["all"]);

    expect(changes).toEqual(["week", "upcoming", "all"]);
  });

  test("re-clicking the pressed button keeps that window rather than toggling to a second hidden state", async () => {
    const { dom, buttons } = windowGroup();
    const site = await loadSiteJs(dom.document);
    const state = { window: "all" };
    site.wireCalendarWindowButtons("event-window-controls", state, () => {});
    buttons[4]!.click();
    buttons[4]!.click();
    expect(state.window).toBe("month");
    expect(buttons.filter(button => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  test("chip clicks drive the same kind select, and clicking the pressed chip clears it", async () => {
    const dom = createStubDom();
    const chip = dom.element("", { className: "kind-chip", attributes: { "data-kind-filter": "meetings", "aria-pressed": "false" } });
    // site.js delegates from the list, so the handler is captured and invoked
    // with the chip as the event target — the real browser path.
    const handlers: Array<(event: unknown) => void> = [];
    const list = dom.element("event-items", { className: "items", children: [chip] });
    list.addEventListener = (type, handler) => { if (type === "click") handlers.push(handler); };
    dom.register(list);
    const select = dom.register(dom.element("event-filter"));
    select.value = "all";

    const site = await loadSiteJs(dom.document);
    const changes: string[] = [];
    site.wireCalendarKindChips("event-items", "event-filter", value => changes.push(value));

    handlers[0]!({ target: chip });
    expect(select.value).toBe("meetings");
    expect(changes).toEqual(["meetings"]);

    chip.attributes["aria-pressed"] = "true";
    handlers[0]!({ target: chip });
    expect(select.value).toBe("all");
    expect(changes).toEqual(["meetings", "all"]);

    // A click that lands on the list background changes nothing.
    handlers[0]!({ target: list });
    expect(changes).toEqual(["meetings", "all"]);
  });
});

describe("lane 5: calendarWindowFilter across the year boundary (real site.js)", () => {
  test("a December week window does not leak January, and a January one does not leak December", async () => {
    const site = await loadSiteJs();
    const events = [
      { id: "dec-28", dateStart: "2026-12-28" }, // Monday
      { id: "dec-31", dateStart: "2026-12-31" },
      { id: "jan-01", dateStart: "2027-01-01" },
      { id: "jan-03", dateStart: "2027-01-03" }, // Sunday of the same week
      { id: "jan-04", dateStart: "2027-01-04" }, // next Monday
    ];
    // Wednesday 2026-12-30, civic time: the Monday-Sunday window spans the year.
    const week = site.calendarWindowFilter(events, "week", new Date("2026-12-30T20:00:00Z"));
    expect(week.map(event => event.id)).toEqual(["dec-28", "dec-31", "jan-01", "jan-03"]);

    // The month windows stop at the boundary in both directions.
    expect(site.calendarWindowFilter(events, "month", new Date("2026-12-15T20:00:00Z")).map(event => event.id)).toEqual(["dec-28", "dec-31"]);
    expect(site.calendarWindowFilter(events, "month", new Date("2027-01-15T20:00:00Z")).map(event => event.id)).toEqual(["jan-01", "jan-03", "jan-04"]);
  });

  test("undated and unparseable events are excluded from date windows, never guessed in", async () => {
    const site = await loadSiteJs();
    const events = [{ id: "dated", dateStart: "2026-12-31" }, { id: "undated" }, { id: "garbage", dateStart: "soon" }];
    expect(site.calendarWindowFilter(events, "week", new Date("2026-12-30T20:00:00Z")).map(event => event.id)).toEqual(["dated"]);
    expect(site.calendarWindowFilter(events, "month", new Date("2026-12-30T20:00:00Z")).map(event => event.id)).toEqual(["dated"]);
    // The status windows read status, so an undated scheduled event stays.
    const byStatus = [{ id: "scheduled" as string, status: "scheduled" }, { id: "completed", status: "completed" }];
    expect(site.calendarWindowFilter(byStatus, "upcoming").map(event => event.id)).toEqual(["scheduled"]);
    expect(site.calendarWindowFilter(byStatus, "past").map(event => event.id)).toEqual(["completed"]);
  });
});

describe("lane 5: freshness, escaping and public copy (real site.js)", () => {
  test("freshness renders nothing for an unusable timestamp and never the string NaN", async () => {
    const site = await loadSiteJs();
    for (const unusable of [null, undefined, "", "not-a-date", {}, [], Number.NaN, "2026-13-45T99:99:99Z"]) {
      expect(site.calendarFreshnessText(unusable)).toBe("");
    }
    const fresh = site.calendarFreshnessText(new Date(Date.now() - 2 * 86400000).toISOString());
    expect(fresh).toContain("Calendar data refreshed");
    expect(fresh).not.toContain("NaN");
    expect(site.calendarFreshnessText(new Date(Date.now() - 40 * 86400000).toISOString())).toContain("40 days old");
  });

  test("the chip escapes with the shipped esc(), and a hostile kind cannot open a tag", async () => {
    const site = await loadSiteJs();
    const chip = site.calendarEventKindChip({ kind: '"><img src=x onerror=alert(1)>' });
    expect(chip).not.toContain("<img");
    expect(chip).toContain(site.esc('"><img src=x onerror=alert(1)>'));
    // The whole card is built from the same escaping, including the title.
    const card = site.calendarEventCard({ title: "<script>alert(1)</script>", kind: "civic-news", dateStart: "2026-12-31" });
    expect(card).not.toContain("<script>alert");
    expect(card.startsWith("<li")).toBe(true);
  });

  test("itemCard renders meeting documents as labelled links and drops unusable URLs", async () => {
    const site = await loadSiteJs();
    const card = site.itemCard({
      title: "Planning Commission",
      link: "https://example.org/m/1",
      content: "Regular session.",
      documents: [
        { label: "Agenda", url: "https://example.org/agenda.pdf" },
        { label: "Bad", url: "javascript:alert(1)" },
        { label: "Missing" },
      ],
    }, "public record");
    expect(card).toContain('href="https://example.org/agenda.pdf"');
    expect(card).toContain(">Agenda<");
    expect(card).not.toContain("javascript:");
    expect(card).not.toContain(">Bad<");
    expect(card).not.toContain(">Missing<");
  });

  test("publicErrorNote keeps the failure and drops every operator internal", async () => {
    const site = await loadSiteJs();
    const raw = [
      "Failed to parse JSON from https://quickmap.dot.ca.gov/api/v1/incidents?district=1",
      "All QuickMap endpoints failed: QuickMap returned 503 from https://quickmap.dot.ca.gov",
      "getaddrinfo ENOTFOUND quickmap.dot.ca.gov",
      "yt-dlp not found in $PATH",
      "could not load data/events.json within 15s",
    ];
    for (const value of raw) {
      const note = site.publicErrorNote(value);
      expect(note.length).toBeGreaterThan(0);
      expect(note).not.toMatch(/https?:|quickmap|yt-dlp|\$PATH|ENOTFOUND/i);
    }
    expect(site.publicErrorNote("")).toBe("");
  });

  test("the deferred index search answers the first query once the index arrives", async () => {
    const site = await loadSiteJs();
    const renders: Array<{ needle: string; state: string; matches: number }> = [];
    let resolveIndex: ((value: unknown) => void) | null = null;
    const controller = site.createDeferredIndexSearch(
      () => new Promise(resolve => { resolveIndex = resolve; }),
      (needle, index, state) => renders.push({ needle, state, matches: index ? site.searchIndexMatches(index, needle).length : 0 }),
    );
    controller.search("harbor");
    expect(renders).toEqual([{ needle: "harbor", state: "pending", matches: 0 }]);
    await new Promise(resolve => setTimeout(resolve, 0)); // the controller requests the index on a microtask
    resolveIndex!({ shards: { t: [{ id: "1", t: "17.61.231 harbor-related", n: "17.61.231" }], x: [{ id: "1", x: "harbor district uses" }] } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(renders).toHaveLength(2);
    expect(renders[1]).toEqual({ needle: "harbor", state: "ready", matches: 1 });
  });

  test("an index that never loads reports unavailable, and never a zero-match answer", async () => {
    const site = await loadSiteJs();
    const renders: Array<{ needle: string; state: string }> = [];
    const controller = site.createDeferredIndexSearch(
      async () => { throw new Error("404 not found"); },
      (needle, _index, state) => renders.push({ needle, state }),
    );
    controller.search("harbor");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(renders.map(render => render.state)).toEqual(["pending", "unavailable"]);
  });
});

describe("lane 5: weekly-check calendar honesty (executed from the real script)", () => {
  /**
   * The classifier is read out of scripts/weekly-check.ts and executed. The
   * script itself cannot be imported — its module body runs the whole weekly
   * pipeline — so the function's real source is transpiled and evaluated here.
   * A re-hardcoded `classify: () => "ok"` deletes this function and fails the
   * extraction, which is the regression this test exists to catch.
   */
  async function loadClassifier(): Promise<(result: { artifactRead: boolean; eventCount: number; inputItems: number }) => string> {
    const source = await readFile(join(process.cwd(), "scripts", "weekly-check.ts"), "utf8");
    const match = /export function classifyCalendarRefresh[\s\S]*?\n}/.exec(source);
    if (!match) throw new Error("scripts/weekly-check.ts no longer exports classifyCalendarRefresh");
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`${match[0].replace(/^export /, "")}\nglobalThis.__classify = classifyCalendarRefresh;`);
    new Function(js)();
    return (globalThis as unknown as { __classify: (result: { artifactRead: boolean; eventCount: number; inputItems: number }) => string }).__classify;
  }

  test("zero events out of real inputs is a failure, not a quiet week", async () => {
    const classify = await loadClassifier();
    expect(classify({ artifactRead: true, eventCount: 0, inputItems: 42 })).toBe("failed");
    expect(classify({ artifactRead: false, eventCount: 0, inputItems: 0 })).toBe("failed");
    expect(classify({ artifactRead: false, eventCount: 12, inputItems: 42 })).toBe("failed");
  });

  test("zero events out of zero inputs is honest, and events are ok", async () => {
    const classify = await loadClassifier();
    expect(classify({ artifactRead: true, eventCount: 0, inputItems: 0 })).toBe("degraded");
    expect(classify({ artifactRead: true, eventCount: 1, inputItems: 1 })).toBe("ok");
    expect(classify({ artifactRead: true, eventCount: 73, inputItems: 120 })).toBe("ok");
  });

  test("the weekly-check pipeline steps no longer hardcode a green classification", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "weekly-check.ts"), "utf8");
    // Comments quote the retired pattern on purpose, so scan the code only.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    // Negative control for the lane's own work: any re-introduced constant
    // classifier fails here, whichever step it is on.
    const constantClassifiers = [...code.matchAll(/classify:\s*(?:\(?[\w_]*\)?)\s*=>\s*"(ok|degraded)"/g)];
    expect(constantClassifiers.map(match => match[0])).toEqual([]);
    const constantCounts = [...code.matchAll(/itemCount:\s*(?:\(?[\w_]*\)?)\s*=>\s*\d+/g)];
    expect(constantCounts.map(match => match[0])).toEqual([]);
  });
});

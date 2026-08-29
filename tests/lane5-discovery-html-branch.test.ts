/**
 * Lane 5 (R3 P2 / P0-A) — the HTML branch of discoverFromSource.
 *
 * The branch had no test that executed it: every discovery test drove
 * parseHtmlListing directly, so the code that turns rows into events (markup
 * date wins; date-like-but-unparseable goes to the LLM; neither means the row is
 * dropped and counted) ran only in production. These tests call the real
 * function with the real fetch path stubbed at the global boundary, so the
 * branch executes end to end and the drop counters are observed, not asserted
 * from a copy of the logic.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { discoverFromSource, type DropCounters, type EventSourceRecord } from "../src/event_discovery.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Serve one HTML body to the source's URL and refuse every other request. */
function serveHtml(body: string): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://calendar.example.org/")) throw new Error(`unexpected request to ${url}`);
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

const htmlSource: EventSourceRecord = {
  name: "Example Community Calendar",
  url: "https://calendar.example.org/events",
  type: "html",
  notes: "test fixture",
};

const listing = (rows: string): string => `<html><body>${rows}</body></html>`;
const row = (title: string, date: string, href: string, location?: string): string =>
  `<article class="event"><h3><a href="${href}">${title}</a></h3><time>${date}</time>${location ? `<span class="location">${location}</span>` : ""}</article>`;

describe("lane 5: discoverFromSource HTML branch (real function, stubbed transport)", () => {
  test("a row whose markup carries a parseable date becomes a markup event, with no LLM call", async () => {
    serveHtml(listing(row("Harbor District Meeting", "October 6, 2026", "https://calendar.example.org/e/1", "Harbor Office")));
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    let llmCalls = 0;
    const result = await discoverFromSource(htmlSource, counters, {
      resolveLlm: async () => { llmCalls += 1; return { date: "2099-01-01", timeNote: "invented", location: "invented" }; },
    });

    expect(result.status).toBe("ok");
    expect(result.httpStatus).toBe(200);
    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.title).toBe("Harbor District Meeting");
    expect(event.dateStart).toBe("2026-10-06");
    expect(event.extractionMethod).toBe("markup");
    expect(event.confidence).toBe(0.85);
    expect(event.sourceName).toBe("Example Community Calendar");
    // The invariant that matters: a markup-parsed date is never replaced by an
    // LLM date, and the row that already parsed does not spend an LLM call.
    expect(llmCalls).toBe(0);
    expect(counters).toEqual({ droppedAmbiguous: 0, droppedUndated: 0 });
  });

  test("a date-like but unparseable row is resolved by the LLM and marked as such", async () => {
    serveHtml(listing(row("Second Saturday Market", "6:30 p.m.", "https://calendar.example.org/e/2")));
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    const prompts: string[] = [];
    const result = await discoverFromSource(htmlSource, counters, {
      resolveLlm: async prompt => { prompts.push(prompt); return { date: "2026-10-10", timeNote: "9 a.m.", location: "Front Street" }; },
    });

    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.dateStart).toBe("2026-10-10");
    expect(event.extractionMethod).toBe("llm");
    expect(event.confidence).toBe(0.55);
    expect(event.timeNote).toBe("9 a.m.");
    expect(event.location).toBe("Front Street");
    // The LLM is grounded in the row's own text, never in a fabricated prompt.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Second Saturday Market");
    expect(counters.droppedAmbiguous).toBe(0);
  });

  test("a date-like row the LLM cannot resolve is dropped and counted, never guessed", async () => {
    serveHtml(listing(row("Ongoing Exhibit", "7:00 p.m., dates vary", "https://calendar.example.org/e/3")));
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    const result = await discoverFromSource(htmlSource, counters, { resolveLlm: async () => null });

    expect(result.status).toBe("ok");
    expect(result.events).toEqual([]);
    expect(counters.droppedAmbiguous).toBe(1);
    expect(counters.droppedUndated).toBe(0);
  });

  test("a row with no date context at all is counted as undated and never sent to the LLM", async () => {
    serveHtml(listing(`<article class="event"><h3><a href="https://calendar.example.org/e/4">Volunteer Sign-Up</a></h3></article>`));
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    let llmCalls = 0;
    const result = await discoverFromSource(htmlSource, counters, { resolveLlm: async () => { llmCalls += 1; return null; } });

    expect(result.events).toEqual([]);
    expect(llmCalls).toBe(0);
    expect(counters.droppedUndated).toBe(1);
  });

  test("a transport failure is reported as an error result, not as an empty success", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    const result = await discoverFromSource(htmlSource, counters, { resolveLlm: async () => null });
    expect(result.status).toBe("error");
    expect(result.error).toContain("503");
    expect(result.events).toEqual([]);
  });
});

describe("lane 5b: completeness assist inside the reachable markup branch", () => {
  test("a markup-dated row with no location gets LLM time/location assist and is labelled llm at 0.75", async () => {
    serveHtml(listing(row("Harbor District Meeting", "October 6, 2026", "https://calendar.example.org/e/1")));
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    let llmCalls = 0;
    const result = await discoverFromSource(htmlSource, counters, {
      resolveLlm: async () => { llmCalls += 1; return { date: "2099-01-01", timeNote: "6:30 PM", location: "Harbor Office" }; },
    });

    expect(result.status).toBe("ok");
    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    // The markup date survives; only the missing fields are filled. The LLM
    // date ("2099-01-01") must NOT win.
    expect(event.dateStart).toBe("2026-10-06");
    expect(event.timeNote).toBe("6:30 PM");
    expect(event.location).toBe("Harbor Office");
    expect(event.extractionMethod).toBe("llm");
    expect(event.confidence).toBe(0.75);
    expect(llmCalls).toBe(1);
  });

  test("a markup-dated row WITH a location never spends an LLM call", async () => {
    serveHtml(listing(row("Harbor District Meeting", "October 6, 2026", "https://calendar.example.org/e/1", "Harbor Office")));
    const counters: DropCounters = { droppedAmbiguous: 0, droppedUndated: 0 };
    let llmCalls = 0;
    const result = await discoverFromSource(htmlSource, counters, {
      resolveLlm: async () => { llmCalls += 1; return { date: "2099-01-01", timeNote: "invented", location: "invented" }; },
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.extractionMethod).toBe("markup");
    expect(llmCalls).toBe(0);
  });
});

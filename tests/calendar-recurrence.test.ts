import { test, expect } from "bun:test";
import { expandCalendar, type CalendarRecord } from "../src/calendar_recurrence.ts";
import { parseIcsEvents, discoverFromSource } from "../src/event_discovery.ts";
const window = { startDay: "2026-03-01", endDay: "2026-04-30" };
const base: CalendarRecord = { uid: "meeting", summary: "Council meeting", dtstart: "20260301T100000", tzid: "America/Los_Angeles", recurrence: "FREQ=WEEKLY;COUNT=4" };
test("wall-clock recurrence crosses DST and exact cancellations survive revision replay", () => {
  const rows = [base, { uid: base.uid, summary: "Cancelled", dtstart: "20260308T100000", recurrenceId: "20260308T100000", status: "CANCELLED", sequence: 1 }];
  const a = expandCalendar(rows, window), b = expandCalendar(rows, window);
  expect(a).toEqual(b); expect(a.events.map(row => row.dtstart)).toEqual(["20260301T100000", "20260315T100000", "20260322T100000"]); expect(a.cancelled).toBe(1);
  const parsed = parseIcsEvents("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:meeting\r\nRECURRENCE-ID:20260308T100000\r\nSTATUS:CANCELLED\r\nSEQUENCE:1\r\nEND:VEVENT\r\nEND:VCALENDAR");
  expect(parsed[0]!.recurrenceId).toBe("20260308T100000"); expect(expandCalendar([base, ...parsed], window)).toEqual(a);
});
test("leap-day yearly and month-end recurrences skip invalid civil dates", () => {
  expect(expandCalendar([{ ...base, dtstart: "20240229", recurrence: "FREQ=YEARLY" }], { startDay: "2028-01-01", endDay: "2028-12-31" }).events.map(row => row.dtstart)).toEqual(["20280229"]);
  expect(expandCalendar([{ ...base, dtstart: "20260131", recurrence: "FREQ=MONTHLY;COUNT=3" }], { startDay: "2026-01-01", endDay: "2026-05-31" }).events.map(row => row.dtstart)).toEqual(["20260131", "20260331", "20260531"]);
});
test("EXDATE/RDATE and sequence overrides preserve occurrence identity and limits", () => {
  const result = expandCalendar([{ ...base, recurrence: "FREQ=DAILY;COUNT=3", exdates: ["20260302T100000"], rdates: ["20260306T100000"] }, { ...base, recurrence: undefined, recurrenceId: "20260303T100000", dtstart: "20260304T110000", sequence: 2 }], window);
  expect(result.events.map(row => row.dtstart)).toEqual(["20260301T100000", "20260304T110000", "20260306T100000"]);
  expect(result.events[1]!.recurrenceId).toBe("20260303T100000");
  for (const recurrence of ["FREQ=HOURLY", "FREQ=WEEKLY;BYDAY=2MO", "FREQ=DAILY;COUNT=3;UNTIL=20260310", "FREQ=DAILY;COUNT=999999", "FREQ=MONTHLY;BYMONTHDAY=-1"]) expect(expandCalendar([{ ...base, recurrence }], window).diagnostics.length).toBe(1);
  expect(expandCalendar([{ ...base, recurrence: "FREQ=DAILY" }], { ...window, maxOccurrences: 2 }).diagnostics[0]!.reason).toContain("cap");
});
test("real ICS feed retains floating-time provenance and reports unknown zones explicitly", async () => {
  const server = Bun.serve({ port: 0, fetch() { return new Response("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:floating\nDTSTART:20260301T100000\nSUMMARY:Library program\nEND:VEVENT\nBEGIN:VEVENT\nUID:unknown\nDTSTART;TZID=Missing/Zone:20260301T100000\nSUMMARY:Unknown program\nEND:VEVENT\nEND:VCALENDAR"); } });
  const origin = `http://127.0.0.1:${server.port}`;
  try { const result = await discoverFromSource({ name: "Explicit local acceptance", url: origin, type: "ics", notes: "fixture" }, { droppedAmbiguous: 0, droppedUndated: 0 }, { fixtureOrigin: origin, calendarWindow: window });
    expect(result.events[0]!.calendarEvidence!.timeBasis).toBe("floating"); expect(result.events[0]!.timeNote).toContain("timezone unspecified"); expect(result.calendarDiagnostics![0]!.reason).toContain("Unknown timezone");
  } finally { server.stop(true); }
});

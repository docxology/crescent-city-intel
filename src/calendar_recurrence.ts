/** Bounded RFC 5545 recurrence subset; unsupported rules produce named diagnostics. */
export interface CalendarRecord {
  uid?: string; summary: string; dtstart: string; tzid?: string; recurrence?: string; status?: string;
  recurrenceId?: string; sequence?: number; exdates?: string[]; rdates?: string[];
  recurrenceIssues?: string[];
  location?: string; description?: string; url?: string;
}
export interface CalendarExpansion { events: CalendarRecord[]; diagnostics: Array<{ uid: string | null; reason: string }>; cancelled: number }
const DAY = 86_400_000, WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function stamp(value: string): { day: Date; suffix: string } | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/); if (!m) return null;
  const day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10).replaceAll("-", "") !== value.slice(0, 8)) return null;
  if (m[4] && (+m[4].slice(1, 3) > 23 || +m[4].slice(3, 5) > 59 || +m[4].slice(5, 7) > 59)) return null;
  return { day, suffix: m[4] ?? "" };
}
/** Preserve local wall time through DST; only the reader's timezone converter assigns an instant. */
export function expandCalendar(records: CalendarRecord[], options: { startDay: string; endDay: string; maxOccurrences?: number }): CalendarExpansion {
  const start = stamp(options.startDay.replaceAll("-", "")), end = stamp(options.endDay.replaceAll("-", ""));
  const cap = options.maxOccurrences ?? 500;
  if (!start || !end || end.day < start.day || +end.day - +start.day > 366 * DAY || !Number.isSafeInteger(cap) || cap < 1 || cap > 5000 || records.length > 5000) throw new Error("Invalid bounded calendar window");
  const result: CalendarExpansion = { events: [], diagnostics: [], cancelled: 0 };
  const groups = new Map<string, CalendarRecord[]>();
  records.forEach((row, index) => { const key = row.uid ?? `unidentified-${index}`; groups.set(key, [...groups.get(key) ?? [], row]); });
  for (const [uid, rows] of groups) {
    const masters = rows.filter(row => !row.recurrenceId).sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0));
    const master = masters[0]; if (!master) { result.diagnostics.push({ uid, reason: "recurrence override has no master" }); continue; }
    if (masters.length > 1 && (masters[0]!.sequence ?? 0) === (masters[1]!.sequence ?? 0)) { result.diagnostics.push({ uid, reason: "conflicting calendar revisions" }); continue; }
    if (master.status === "CANCELLED") { result.cancelled++; continue; }
    const base = stamp(master.dtstart); if (!base || rows.some(row => row.sequence !== undefined && (!Number.isSafeInteger(row.sequence) || row.sequence < 0))) { result.diagnostics.push({ uid, reason: "invalid DTSTART or SEQUENCE" }); continue; }
    if (rows.some(row => row.recurrenceIssues?.length) || [...master.exdates ?? [], ...master.rdates ?? []].some(value => { const parsed = stamp(value); return !parsed || !!parsed.suffix !== !!base.suffix || /Z$/.test(value) !== /Z$/.test(master.dtstart); })) { result.diagnostics.push({ uid, reason: "unsupported recurrence timezone or value type" }); continue; }
    const overrides = new Map<string, CalendarRecord>(); let conflict = false;
    for (const row of rows.filter(item => item.recurrenceId)) {
      if (!stamp(row.recurrenceId!)) { conflict = true; break; }
      const previous = overrides.get(row.recurrenceId!);
      if (previous && (previous.sequence ?? 0) === (row.sequence ?? 0)) { conflict = true; break; }
      if (!previous || (row.sequence ?? 0) > (previous.sequence ?? 0)) overrides.set(row.recurrenceId!, row);
    }
    if (conflict) { result.diagnostics.push({ uid, reason: "invalid or conflicting recurrence override" }); continue; }
    let occurrences = [master.dtstart];
    if (master.recurrence) {
      const entries = master.recurrence.toUpperCase().split(";").map(item => item.split("="));
      const rule: Record<string, string | undefined> = Object.fromEntries(entries); const freq = rule.FREQ;
      const interval = Number(rule.INTERVAL ?? 1), count = rule.COUNT === undefined ? Infinity : Number(rule.COUNT);
      const until = rule.UNTIL ? stamp(rule.UNTIL) : null;
      const invalidUntil = rule.UNTIL !== undefined && (!until || rule.UNTIL < master.dtstart || !!until.suffix !== !!base.suffix || /Z$/.test(rule.UNTIL) !== /Z$/.test(master.dtstart) || !!master.tzid);
      const days = rule.BYDAY?.split(","), monthDays = rule.BYMONTHDAY?.split(",").map(Number);
      const unsupported = entries.some(([key, value]) => !value || !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"].includes(key!)) || new Set(entries.map(([key]) => key)).size !== entries.length || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq!) || !Number.isInteger(interval) || interval < 1 || interval > 366 || count !== Infinity && (!Number.isInteger(count) || count < 1 || count > 5000) || rule.COUNT !== undefined && rule.UNTIL !== undefined || invalidUntil || days && (freq !== "WEEKLY" || days.some(day => !WEEKDAYS.includes(day))) || monthDays && (freq !== "MONTHLY" || monthDays.some(day => !Number.isInteger(day) || day < 1 || day > 31)) || rule.WKST && rule.WKST !== "MO";
      if (unsupported) { result.diagnostics.push({ uid, reason: `unsupported RRULE: ${master.recurrence}` }); continue; }
      // Bounded look-back counts prior occurrences without unbounded recurrence expansion.
      if (+start.day - +base.day > 10 * 366 * DAY) { result.diagnostics.push({ uid, reason: "recurrence exceeds ten-year replay bound" }); continue; }
      occurrences = []; let emitted = 0;
      const firstWeek = +base.day - ((base.day.getUTCDay() + 6) % 7) * DAY;
      for (let at = +base.day; at <= +end.day && emitted < count; at += DAY) {
        const day = new Date(at), elapsed = Math.floor((at - +base.day) / DAY), months = (day.getUTCFullYear() - base.day.getUTCFullYear()) * 12 + day.getUTCMonth() - base.day.getUTCMonth();
        const match = freq === "DAILY" ? elapsed % interval === 0 : freq === "WEEKLY" ? Math.floor((at - firstWeek) / (7 * DAY)) % interval === 0 && (days ?? [WEEKDAYS[base.day.getUTCDay()]!]).includes(WEEKDAYS[day.getUTCDay()]!) : freq === "MONTHLY" ? months % interval === 0 && (monthDays ?? [base.day.getUTCDate()]).includes(day.getUTCDate()) : (day.getUTCFullYear() - base.day.getUTCFullYear()) % interval === 0 && day.getUTCMonth() === base.day.getUTCMonth() && day.getUTCDate() === base.day.getUTCDate();
        if (!match) continue;
        const value = day.toISOString().slice(0, 10).replaceAll("-", "") + base.suffix;
        if (rule.UNTIL && value > rule.UNTIL) break;
        emitted++; if (at >= +start.day) occurrences.push(value);
      }
    }
    for (const value of [...new Set([...occurrences, ...master.rdates ?? []])].sort()) {
      if (master.exdates?.includes(value)) { result.cancelled++; continue; }
      const override = overrides.get(value);
      if (override?.status === "CANCELLED") { result.cancelled++; continue; }
      const item = override ? { ...master, ...override } : { ...master, dtstart: value };
      const date = stamp(item.dtstart); if (!date) { result.diagnostics.push({ uid, reason: "invalid RDATE or override DTSTART" }); continue; }
      if (+date.day < +start.day || +date.day > +end.day) continue;
      if (result.events.length >= cap) { result.diagnostics.push({ uid, reason: "calendar occurrence cap reached" }); return result; }
      result.events.push({ ...item, recurrenceId: value });
    }
  }
  result.events.sort((a, b) => a.dtstart.localeCompare(b.dtstart) || (a.uid ?? "").localeCompare(b.uid ?? ""));
  return result;
}

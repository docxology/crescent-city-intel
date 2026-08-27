# Events Module (`src/events.ts`)

Structured community calendar for Crescent City Intel — schema
`crescent-city-events/v1`. It normalizes news, government-meeting, and YouTube
monitor output into one calendar feed plus an iCalendar export.

## Data flow

1. Each source monitor writes its own JSON artifacts under `output/`
   (`gov_meetings/`, `news/`, `youtube/`). The events module never fetches;
   it only reads those artifacts.
2. `collectEvents()` maps each raw item onto a `StructuredEvent` candidate,
   dedupes by normalized title + date (unioning source links), classifies by
   date (`scheduled` / `completed` / `unknown`), sorts ascending with undated
   last, and caps at `MAX_EVENTS` (200).
3. `bun run events` writes `output/events/events.json` and, since this pass,
   also `output/events/events.ics`.
4. The Pages exporter (`src/pages_snapshot.ts`) prefers the persisted artifact
   and emits both `data/events.json` and `data/events.ics` into the snapshot.

## Date discipline

- `parseEventDate()` never guesses: ISO dates pass through; "Mar 18, 2026"
  style names map to ISO; placeholders (TBD/TBA/N/A/unknown) and unparseable
  values return null. Undated news/listings are excluded from the calendar;
  undated meetings and YouTube entries are kept as `status: unknown`.

## iCalendar export

- `buildEventsIcs(events, { stamp })` is a pure builder producing RFC 5545
  text: VCALENDAR 2.0, all-day VEVENTs (`DTSTART;VALUE=DATE`,
  exclusive `DTEND` next day), escaped text fields, folded lines (75 octets),
  and a status mapping (scheduled/completed → CONFIRMED, unknown → TENTATIVE).
- Determinism: UIDs are `<event-id>@crescent-city-intel`; DTSTAMP comes from
  the explicit stamp or the fixed default `19700101T000000Z` — the clock is
  never read inside the builder. Undated events are skipped rather than given
  fabricated dates.
- Linked from the Pages Events section header ("Subscribe / download .ics").

## Pages rendering (Events tab)

- Events render as a semantic ordered list (`<ol id="event-items">`) of `<li>`
  cards; dated entries carry `<time datetime="yyyy-mm-dd">` elements.
- Month grouping with dateline header rows; a trailing "Date not recorded"
  group holds undated items.
- Status chips: SCHEDULED (accent border), COMPLETED (dimmed), UNKNOWN.
- Relative hints for scheduled items: "today", "tomorrow", or "in N days"
  (up to 30).
- Filters keep prior behavior (all/upcoming/past/meetings/community) and add
  YouTube and Holiday-closure kind filters derived from `event.kind`. Empty
  states render a friendly single-item message instead of a blank panel.

## Tests

`tests/events.test.ts` covers parsing, classification, dedupe, artifact
determinism, fixture-driven collection, escaping (`escapeIcsText`),
line folding, next-day edge cases (month/year/leap), ICS UID stability and
DTSTAMP determinism, status mapping, order preservation, and undated-skip
behavior. All tests are offline and deterministic (no clocks, no network).

## Boundaries

- LLM summaries are advisory previews grounded only in provided event fields;
  verify against linked sources.
- No live fetching happens in this module — artifacts come from prior monitor
  runs.

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

## Event discovery (`src/event_discovery.ts`, round 2)

`src/event_discovery.ts` adds bounded-timeout **live discovery** of community
events from configured public feeds in `pages-data/event_sources.json`
(schema `crescent-city-event-sources/v1`) — each entry records `{name, url,
type: 'html'|'rss'|'ics', notes, probe}` with a real HTTP probe status. The
round-2 roster covers the Crescent City calendar, Del Norte County community
events, the library district, the Chamber/visit site, DNACA, and DNUSD.

### Pipeline

1. `fetchFeed(url, timeoutMs)` — hard-bounded fetch (default 10s); failures
   degrade to an errored source record, never a thrown run failure.
2. Parsers produce candidates per source type:
   - `ics`: RFC 5545 VEVENT blocks (line unfolding, escapes, DATE/DATE-TIME).
   - `rss`: RSS `<item>` + Atom `<entry>` via cheerio XML mode.
   - `html`: generic event/listing selectors; rows are date-context flagged.
   - strategy `"evogov-json"` (EvoGov platform sites): read calendar ids off
     the listing page, query the public `meetings/get_list` JSON endpoint.
3. **Grounding:** dates come only from feed data. Date-like but unparseable
   markup may go through an optional local-LLM resolver
   (`extractionMethod: 'llm'`, confidence 0.55); everything else stays
   `'markup'`. Anything without a resolvable date is dropped and counted
   (`droppedUndated` / `droppedAmbiguous`) — never guessed.
4. Every event carries `sourceUrl`, `sourceName`, `sourceLinks`,
   `extractionMethod` ('markup' | 'llm'), and a 0..1 `confidence`.
5. **Reconciliation** vs `output/events/events.json`: same normalized title
   within +/-1 day marks the copy reconciled; conflicting dates prefer the
   markup-derived record, keep both URLs, and flag `needsReview`.

### Public API

`GET /api/events/discover` returns the discovery artifact
(`crescent-city-events-discovery/v1`); pass `?live=false` to skip network
fetching. The CLI writes `output/events/event_discovery.json`
(`bun src/event_discovery.ts`). Rendering on the public page belongs to the
pages lane this round.

### Tests

`tests/event-discovery.test.ts` runs offline against fixtures trimmed from
real probed feeds (`tests/fixtures/event-discovery/`, provenance recorded in
file headers): ICS/RSS/HTML parsing, EvoGov id extraction, LLM-response
strict-parsing, reconciliation merge/conflict logic, registry loading, and
no-network determinism of `buildDiscoveryArtifact`.

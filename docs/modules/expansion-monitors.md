# Expansion Monitors (#16–#20) — permits, dredging, fuel, PacFIN, AIS

These monitors observe the public permit catalog, harbor construction posts,
California gasoline prices, the PacFIN report catalog, and configured AIS
positions. Connectors bound requests by timeout, retries, and body size. Parsers
are tested offline against captures in `tests/fixtures/` with negative controls;
invalid source formats produce explicit unavailable states.

Source dates below identify the recorded live captures used as parser evidence.
Current availability comes from each bounded run's source-health receipt;
access to a public catalog does not establish access to its underlying records.

The roster authority remains `MONITOR_KEYS` in `alerts/composite.ts`; these
five are appended there and flow through every derived roster
(`EXTENDED_MONITOR_SPECS`, `ALERT_TYPES`, `CORRELATION_SOURCES`,
`EXPECTED_SOURCE_HEALTH`, the SPA's hand-written maps) via
`tests/alert-source-roster.test.ts` and `tests/new-monitors.test.ts`.

## `src/alerts/permits.ts` — Crescent City Permits Portal (`permits`)

- **Source (verified live 2026-09-28):** the City of Crescent City's MyGov
  public portal Permits module
  (`https://public.mygov.us/crescent_city_ca/module?module=pi`), linked from
  the City Building Department page. Server-rendered; no key.
- **What it reads:** the PUBLIC permit catalog — the five published permit
  application types (id, name, department, description, apply link). A
  content-hash diff against the shared `IdempotencyStore` turns newly
  published or edited permit types into events.
- **What it does NOT read, stated honestly:** the portal's issued-permit
  register requires a collaborator login; no public issued-permit list
  exists. Apply buttons are login popups (`applyRequiresLogin: true`).
- **Level:** CALM (catalog unchanged) / ADVISORY (catalog changed). The
  first-ever observation is a baseline, never an alarm.

## `src/alerts/dredging.ts` — Crescent City Harbor District (`dredging`)

- **Source (verified live 2026-09-28):** the Harbor District's sitemap
  (`https://www.ccharbor.com/sitemap.xml`, ~525 URLs). The site publishes no
  RSS (`wp-json` and `/feed/` are disabled), so the sitemap is the news
  surface. USACE SPN's dredging schedule page was probed (403 from a
  datacenter network) and is documented as a future source, not wired.
- **What it reads:** post slugs (which are the titles) filtered by
  dredging-first keywords (`dredge`, `channel`, `jetty`) and adjacent
  marine-construction keywords (`seawall`, `breakwater`, `dock`, `pier`,
  `boat ramp`, `berth`, `marina`), gated to a 90-day window on `lastmod`.
- **What it does NOT read:** there is no real-time dredge-position feed;
  this is change detection over the harbor's public news surface and will
  never fabricate a dredge location.
- **Level:** CALM (no in-window posts) / ADVISORY (marine-work posts).

## `src/alerts/fuel.ts` — EIA California Fuel (`fuel`)

- **Source (verified live 2026-09-28):** the U.S. EIA weekly California
  all-grades all-formulations retail gasoline price (series
  `EMM_EPM0_PTE_SCA_DPG`), a server-rendered HTML table; keyless.
- **What it reads:** the full weekly observed series (1,300+ weeks in the
  recorded capture); the report carries the latest OBSERVED week, the
  trailing 8 observed weeks, and their median.
- **What it does NOT read:** this feed supplies observed prices, not a
  forecast. The connector does not manufacture predictions or present a
  forecast maximum as a current reading. It is a STATEWIDE observed average,
  not a Crescent City street price — `scopeNote` says so. Station-level
  sources require separate access assessment under TODO L05.
- **Level:** ADVISORY when the latest observed price exceeds the trailing
  8-week median by more than `FUEL_SPIKE_THRESHOLD` (15%), else CALM.
  Every observed week is appended to `history.jsonl` (deduped by week), so
  analytics carries a continuous price series.

## `src/alerts/pacfin.ts` — PacFIN Reports Dashboard (`pacfin`)

- **Source (verified live 2026-09-28):** the PSMFC PacFIN APEX Reports
  Dashboard (`https://reports.psmfc.org/pacfin/`), publicly reachable and
  server-rendering the full report catalog as an embedded JSON tree
  (`gTree<session-id>Data = {…}`) — 76 public reports in the recorded capture.
- **What it reads:** the public report catalog (report ids like `ALL001`,
  labels, category paths, methodology tooltips), watched for new or edited
  reports via the shared `IdempotencyStore`.
- **What it does NOT read, stated honestly:** the landing FIGURES (pounds
  and dollars by port and species) require a PacFIN account — every
  uncredentialed probe lands on the Public Login wall — so
  `landingDataAvailable` is `false`, the summary says the figures are NOT
  read, and no catch total is ever fabricated. `PACFIN_SESSION_COOKIE` can
  supply a cookie, but the current connector still extracts catalog metadata;
  access to landing figures requires separate integration and acceptance.
- **Level:** CALM (catalog unchanged) / ADVISORY (catalog changed).

## `src/alerts/ais.ts` — AIS Vessel Traffic (`ais`)

- **Source:** an open-AIS FeatureCollection feed selected by `AIS_FEED_URL`
  (env). The default is the keyless Finnish digitraffic feed
  (`https://meri.digitraffic.fi/api/ais/v1/locations`), which speaks the
  exact open-AIS GeoJSON shape and is the fixture's capture (50 real vessel
  positions, 2026-09-28).
- **What it reads:** vessel positions (MMSI, lat/lon, SOG/COG/heading,
  position stamp) filtered to the Del Norte watch box
  (lat 41.6–42.1, lon −124.45–−123.9). Zero vessels in the box is a
  legitimate explicit empty state (`vesselsInWatchArea: []`, CALM), not an
  outage.
- **What it does NOT read, stated honestly:** real-time US-coast AIS is not
  publicly keyless (USCG NAVCEN restricted; AISHub/MarineTraffic need
  membership). Until `AIS_FEED_URL` points at a US-waters provider the
  monitor reports `coversDelNorteWaters: false` and an empty local box over
  the real upstream data — never a fabricated vessel.
- **Level:** CALM (empty watch box) / ADVISORY (vessel(s) in the box).

## Wiring

- `scripts/run-alerts.ts` batch: keys `permits`, `dredging`, `fuel`,
  `pacfin`, `ais` (all `null`-on-failure members — a dead source is an
  `unavailable` health record, not an empty success).
- `buildExtendedCompositeInput` shapes all five into
  `computeAlertSeverity` params 15–19; `MONITOR_PRIORITY` places them after
  `uscg` because they are advisory-class and must never take the headline
  slot from a monitor that can reach WARNING.
- npm aliases: `alerts:permits`, `alerts:dredging`, `alerts:fuel`,
  `alerts:pacfin`, `alerts:ais`.
- Source registry: `alert-city-permits`, `alert-harbor-dredging`,
  `alert-eia-fuel`, `alert-pacfin-reports`, `alert-ais-vessels`.

## Tests

`tests/new-monitors.test.ts`: real-fixture parsing for all five (5 permit
entries; 525 sitemap URLs; 1,300+ EIA weeks; 76 PacFIN reports; 50 AIS
positions), the honesty contracts (login-gated applies, credential-gated
landings, non-US feed scope, observed-not-forecast fuel), and one negative
control per monitor (empty / garbage / wrong-format bodies throw).
`tests/extended-monitor-definitions.test.ts` asserts the twelve extended
specs against the real report interfaces.

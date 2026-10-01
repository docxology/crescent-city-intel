# Alert Monitors Module

Real-time natural hazard and environmental monitoring for Crescent City, CA.
20 independent monitors (8 core + 12 extended) feed a composite severity scoring system and
unified alert analytics timeline. Each run also writes the typed
`output/alerts/source-health.json` artifact so unavailable feeds cannot be
mistaken for calm readings.

## Monitor Inventory

| # | Monitor | Source | Output Dir | Module |
|---|---------|--------|------------|--------|
| 1 | NOAA Tsunami | `api.weather.gov` | `output/alerts/tsunami/` | `alerts/noaa_tsunami.ts` |
| 2 | USGS Earthquake | `earthquake.usgs.gov` | `output/alerts/earthquake/` | `alerts/usgs_earthquake.ts` |
| 3 | NWS Weather | `api.weather.gov` | `output/alerts/weather/` | `alerts/nws_weather.ts` |
| 4 | NOAA Tides | `tidesandcurrents.noaa.gov` | `output/tides/` | `alerts/noaa_tides.ts` |
| 5 | CDFW Fishing | `wildlife.ca.gov` | `output/fishing/` | `alerts/cdfw_fishing.ts` |
| 6 | EPA Air Quality | Optional AirNow ZIP API + public PM2.5 KML | `output/alerts/airquality/` | `alerts/epa_airnow.ts` |
| 7 | CAL FIRE Wildfire | `fire.ca.gov` | `output/alerts/wildfire/` | `alerts/calfire_wildfire.ts` |
| 8 | NDBC Marine Buoy | `ndbc.noaa.gov` | `output/alerts/marine/` | `alerts/ndbc_marine.ts` |
| 9 | NWS Marine Forecast | NWS KEKA CWF text product (PZZ450) | `output/alerts/marinezone/` | `alerts/nws_marine.ts` |
| 10 | USCG Broadcasts | USCG NAVCEN District 11 BNM listing | `output/alerts/uscg/` | `alerts/uscg_broadcasts.ts` |
| 11 | USDM Drought | `usdmdataservices.unl.edu` categorical county area percentages | `output/alerts/drought/` | `alerts/usdm_drought.ts` |
| 12 | PG&E PSPS | Official PG&E browser-rendered event page | `output/alerts/psps/` | `alerts/pge_psps.ts` |
| 13 | HRRR Smoke | NOAA HMS smoke plumes | `output/alerts/smoke/` | `alerts/hrrr_smoke.ts` |
| 14 | Caltrans Roads | Caltrans road conditions | `output/alerts/roads/` | `alerts/caltrans_roads.ts` |
| 15 | DUSD Schools | Del Norte USD closures | `output/alerts/schools/` | `alerts/dusd_schools.ts` |
| 16 | Crescent City Permits Portal | City MyGov public permit catalog | `output/alerts/permits/` | `alerts/permits.ts` |
| 17 | Crescent City Harbor District | Harbor sitemap dredging/marine-construction filter | `output/alerts/dredging/` | `alerts/dredging.ts` |
| 18 | EIA California Fuel | EIA weekly CA all-formulations retail gasoline | `output/alerts/fuel/` | `alerts/fuel.ts` |
| 19 | PacFIN Reports Dashboard | PSMFC PacFIN public report catalog | `output/alerts/pacfin/` | `alerts/pacfin.ts` |
| 20 | AIS Vessel Traffic | Open-AIS FeatureCollection feed (Del Norte watch box) | `output/alerts/ais/` | `alerts/ais.ts` |

PG&E checks the official rendered event page, smoke checks NOAA HMS polygon
products, and Caltrans checks every configured route on its Highway Conditions
text service. If these sources cannot be read, the monitor returns `null` and
source health records `unavailable`. An unreadable source cannot establish
that conditions are clear.

---

## `src/alerts/noaa_tsunami.ts` — NOAA Tsunami Alerts

Polls the NOAA Weather API for active tsunami warnings affecting the California coast, filters for Crescent City relevance, and saves to disk.

### Data Source

`GET https://api.weather.gov/alerts/active?area=CA`

Built via `URLSearchParams` so event names such as `Tsunami Warning` are
URL-encoded. The geographic query parameter is `area=CA`.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `monitorNOAATsunamiAlerts` | `() → Promise<void>` | Fetch, filter, log, and save tsunami alerts |

### Output

`output/alerts/tsunami/alert-<id>-<timestamp>.json` + `history.jsonl`

---

## `src/alerts/usgs_earthquake.ts` — USGS Earthquake Alerts

Polls the USGS GeoJSON significant hour feed for earthquakes within 200 km of Crescent City with magnitude >= 4.0.

### Data Source

`GET https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson`

### Key Functions

- `haversineDistance(lat1, lon1, lat2, lon2)` — distance between coordinates
- `isCascadiaEvent(lat, lng)` — checks if epicenter is in Cascadia Subduction Zone
- `monitorUSGSEarthquakeAlerts()` — main monitor entry point

### Constants

| Parameter | Value |
| :--- | :--- |
| Crescent City coordinates | 41.7485 deg N, 124.2028 deg W |
| Search radius | 200 km (Haversine distance) |
| Minimum magnitude | M4.0 |
| Cascadia zone | 38-50 deg N, -128.5 to -121 deg W |

### Output

`output/alerts/earthquake/earthquake-<id>-<timestamp>.json` + `history.jsonl`

---

## `src/alerts/nws_weather.ts` — NWS Weather Alerts

Monitors National Weather Service alerts for the Coastal Del Norte public forecast zone (CAZ101).

### Data Source

`GET https://api.weather.gov/alerts/active?zone=CAZ101`

`zone` and `region` are mutually exclusive on `api.weather.gov`; this monitor
uses `zone=CAZ101` alone for the Coastal Del Norte public forecast zone, as
declared in the [official NWS zone inventory](https://www.weather.gov/eka/Public_Zone_Change_2026).
The declared endpoint and local fixtures do not establish a successful current
live alerts response; a failed JSON response remains unavailable.

### Severity Categorization

| Category | Criteria |
| :--- | :--- |
| `warning` | Severe severity, or Moderate + Likely + Immediate |
| `watch` | Moderate + Possible/Likely + Future |
| `advisory` | All other active alerts |

### Output

`output/alerts/weather/{advisory,watch,warning}/alert-<id>-<timestamp>.json` + `history.jsonl`

---

## `src/alerts/noaa_tides.ts` — NOAA CO-OPS Tides

Fetches 48-hour tide predictions for Crescent City Harbor (station 9419750).

### Data Source

`GET https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`

Both observations and predictions request `time_zone=gmt`. New reports mark
NOAA civil timestamps as UTC; unmarked legacy timestamps remain ambiguous.
Only a valid decimal sensor reading within two hours can enter current water
level scoring. Prediction maxima remain forecasts, and a fresh retrieval does
not freshen an old or missing sensor reading. See the [NOAA API contract](https://api.tidesandcurrents.noaa.gov/api/prod/).

### Output

`output/tides/tides-<timestamp>.json` + `history.jsonl`

---

## `src/alerts/cdfw_fishing.ts` — CDFW Dungeness Crab Season

Combines an estimated annual Dungeness crab season calendar with fetched CDFW
North Coast marine bulletins. The calendar estimate is not a verified current
opening order; follow the cited CDFW source for regulatory decisions. A failed
bulletin check returns unavailable rather than an empty successful report.

### Output

`output/fishing/fishing-<timestamp>.json` + `output/fishing/history.jsonl`

---

## `src/alerts/epa_airnow.ts` — EPA AirNow Air Quality

Reads preliminary AirNow AQI observations for the Crescent City area. With a
key, the monitor first tries the ZIP 95531 endpoint; without a key or usable
fresh API readings, it reads the public PM2.5 KML product.

### Data Source

`GET https://www.airnowapi.org/aq/observation/zipCode/current` (optional keyed API)

`GET https://files.airnowtech.org/airnow/today/airnowlatest_pm25aqi.kml`
(keyless fallback). The fallback selects the nearest valid station within
80 km and retains its declared observation time. Both paths require primary
observations no more than two hours old. A reachable product with no usable
nearby reading remains unavailable for composite scoring; it cannot establish
good air. PM2.5 fallback data do not imply ozone or PM10 measurements.

### Prerequisites

`AIRNOW_API_KEY` enables the keyed ZIP API. It is optional for the public KML path.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `classifyAqi(aqi)` | `(number) → AirQualityLevel` | Classify AQI into 6 severity levels |
| `getAdvisory(level)` | `(AirQualityLevel) → string\|null` | Health advisory message |
| `fetchAirQuality(key?)` | `(string?) → Promise<AirQualityReport>` | Try the keyed API, then the public product; retain transport identity and primary clocks |
| `fetchPublicAirNowKml()` | `() → Promise<AirQualityReport>` | Read keyless nearby PM2.5 observations |
| `runAirQualityMonitor()` | `() → Promise<AirQualityReport\|null>` | Main monitor entry point |

### AQI Classification

| AQI Range | Level | Advisory |
| :--- | :--- | :--- |
| 0-50 | GOOD | None |
| 51-100 | MODERATE | Sensitive groups caution |
| 101-150 | UNHEALTHY_SENSITIVE | Limit outdoor activity |
| 151-200 | UNHEALTHY | All affected |
| 201-300 | VERY_UNHEALTHY | Stay indoors |
| 301+ | HAZARDOUS | Emergency |

### Output

`output/alerts/airquality/current.json` + `history.jsonl`

---

## `src/alerts/calfire_wildfire.ts` — CAL FIRE Wildfire

Fetches active wildfire incidents from CAL FIRE for Del Norte County and surrounding areas (Siskiyou, Humboldt, Trinity).

### Data Source

`GET https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false`

The monitor reads the official incident JSON endpoint and reports a successful
no-match regional result as `empty`; fetch failure is `unavailable`.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `classifyWildfireSeverity(incidents)` | `(WildfireIncident[]) → WildfireSeverity` | Classify composite severity |
| `fetchWildfireIncidents()` | `() → Promise<WildfireIncident[]>` | Fetch from CAL FIRE API |
| `runWildfireMonitor()` | `() → Promise<WildfireReport\|null>` | Main monitor entry point |

### Severity Classification

| Condition | Level |
| :--- | :--- |
| Evacuation orders active | EMERGENCY |
| Large fire (>1000 ac, <50% contained) within 50 km | WARNING |
| Any active incident | ADVISORY |
| No incidents | NONE |

### Output

`output/alerts/wildfire/current.json` + `history.jsonl`

---

## `src/alerts/ndbc_marine.ts` — NDBC Marine Buoy

Fetches real-time marine observations from 3 NDBC buoy stations nearest to Crescent City.

### Data Source

`GET https://www.ndbc.noaa.gov/data/realtime2/<station_id>.txt`

### Monitored Stations

| Station | Name | Distance | Coordinates |
| :--- | :--- | :--- | :--- |
| 46027 | St Georges CA | 27 NM NW | 41.85, -124.38 |
| 46022 | Eel River CA | 120 NM S | 40.72, -124.53 |
| 46214 | Humboldt Bay CA | 60 NM S | 40.88, -124.36 |

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `classifyMarineSeverity(observations)` | `(BuoyObservation[]) → {level, advisory}` | Classify marine conditions |
| `fetchBuoyObservation(station)` | `(Station) → Promise<BuoyObservation\|null>` | Fetch from NDBC |
| `runMarineMonitor()` | `() → Promise<MarineReport\|null>` | Main monitor entry point |

### Severity Thresholds

| Condition | Level |
| :--- | :--- |
| Wave >= 15 ft or wind >= 34 kt (gale) | WARNING |
| Wave >= 10 ft or wind >= 22 kt | WATCH |
| Long-period swell >= 15 s | WATCH |
| Normal | CALM |

### Output

`output/alerts/marine/current.json` + `history.jsonl`

---

## `src/alerts/usdm_drought.ts` — County drought area

The Del Norte FIPS 06015 producer reads
`GetDroughtSeverityStatisticsByAreaPercent` with `statisticsType=2`. These are
categorical county area percentages for None and D0–D4, not DSCI scores or
cumulative D0-or-worse percentages. The latest valid `MapDate` becomes
`productDate`; `severeDroughtPercent` sums D2–D4. The source-clock policy admits
this weekly product for at most ten days, subject to an earlier supplied
`ValidEnd`. A fresh retrieval cannot change its map date. Reports are retained
in `output/alerts/drought/current.json` and deduplicated product history in
`output/alerts/drought/history.jsonl`.

## `src/alerts/severity.ts` — Composite alert severity

Aggregates all 20 alert monitors (8 core + 12 extended: drought, PSPS, smoke, roads, schools, NWS marine forecast, USCG broadcasts, permits, dredging, fuel, PacFIN reports, AIS vessel traffic) into a single composite severity level.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `computeAlertSeverity(...)` | `(20 monitor inputs) → AlertSeverityReport` | Composite severity assessment; an absent monitor is `available: false`, never a calm reading |

### Priority Order

`EMERGENCY > WARNING > WATCH > CALM`

The composite takes the highest severity across all monitors. Each monitor
contributes a `MonitorStatus` with level, summary, and count.

### API Endpoint

`GET /api/alerts/composite`

---

## `src/alerts/composite.ts` — Composite Input Shaping + Source Health

Pure helpers that keep `scripts/run-alerts.ts` thin: they shape the eight
per-monitor reports into the composite scorer's input and classify each
source's health after a run.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `buildCompositeInput({tsunami, earthquake, weather, airquality, wildfire, marine, tidesReport, fishingReport})` | `(object) → CompositeInput` | Normalize per-monitor reports (including the tides + fishing history-path reports) into `computeAlertSeverity` inputs |
| `buildTidesInput(report)` / `buildFishingInput(report)` | `(report) → MonitorStatus` | Shape the two report-only monitors into scorer inputs; import directly from `src/alerts/composite.ts` |
| `classifySourceHealth(definition, settledResult, errors, checkedAt)` | `(...) → SourceHealth` | Map a settled monitor result to `ok` / `empty` / `unavailable` / `stale` with reason + item count |
| `isFreshReport(report, now?, key?)` | `(report, number?, SourceClockKey?) → boolean` | Keyed source-clock policy; unkeyed callers use the generic compatibility window |

### Source-health classification

`ok` and `empty` count as **present**; `unavailable` and `stale` count as
**missing** — so source gaps surface as coverage metadata (GUI, Pages,
analytics, and pipeline envelopes all expose present/missing counts) instead
of failing the run.

---

## `src/alert_analytics.ts` — Alert Analytics

Aggregates all alert history JSONL files across all monitor types into
a unified chronological timeline with per-type statistics.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `buildAlertAnalytics()` | `() → AlertAnalyticsReport` | Full analytics report |
| `getRecentAlerts(limit)` | `(number) → TimelineEntry[]` | Most recent events |
| `getAlertsByType(type, from, to)` | `(AlertType, string?, string?) → TimelineEntry[]` | Filtered by type |

### API Endpoints

- `GET /api/alerts/timeline` — unified chronological timeline
- `GET /api/alerts/recent?limit=N` — recent alerts

---

## Common Patterns

- **Typed degradation**: Source failures produce explicit unavailable outcomes; admission, cancellation and persistence failures may reject and remain visible to the runner
- **Persistent JSONL history**: All monitors append to `history.jsonl` for analytics
- **Persisted deduplication**: Producers load retained IDs within their root-owned invocation; process restart does not create an empty seen baseline
- **import.meta.main**: Each file can be run directly via `bun run src/alerts/<file>.ts`
- **Composite severity**: `run-alerts.ts` runs all 20 monitors and computes the composite from all 20. The 12 extended civic and marine inputs feed it through `buildExtendedCompositeInput`.

## Running

```bash
bun run alerts:tsunami      # NOAA tsunami
bun run alerts:earthquake   # USGS earthquake
bun run alerts:weather      # NWS weather
bun run alerts:tides        # NOAA tides
bun run alerts:fishing      # CDFW fishing
bun run alerts:airquality   # EPA AirNow
bun run alerts:wildfire     # CAL FIRE wildfire
bun run alerts:marine       # NDBC marine buoy
bun run alerts:marinezone  # NWS CWF marine forecast (PZZ450)
bun run alerts              # all 20 concurrently + composite severity
```

See [scripts/README.md](../../scripts/README.md) for cron setup.

Analytics, correlation and GUI trend rosters cover every monitor in
`MONITOR_KEYS`, including the extended civic and marine inputs.

`tests/alert-source-roster.test.ts` derives every roster from `MONITOR_KEYS`
rather than restating it, and asserts the SPA's hand-written monitor and icon
maps in `gui/static/assets/modules/110-feeds.js` against it too. `ANALYTICS_GAP_TYPES` is
retained as an explicit asserted-empty constant so "every history-keeping
monitor is analysed" stays a checkable property.

## Alert Analytics & History

- The unified alert timeline (`src/alert_analytics.ts`) reads each monitor's
  `history.jsonl` — including tides (`output/tides/history.jsonl`) and fishing
  (`output/fishing/history.jsonl`), plus `output/alerts/<type>/history.jsonl` for
  the other monitors — so every monitor type appears in `/api/alerts/timeline`,
  `/api/alerts/recent`, and the monthly report.
- `GET /api/alerts/{type}/history` returns paginated history for one type
  (`?limit=&offset=`); unknown types return 400.
- History files are **bounded** (`shared/source_health.ts appendBoundedJsonl*`):
  each monitor appends through a capped appender that trims to the most-recent
  tail (default 10 000 lines), so JSONL history no longer grows without bound.

### Webhook notifier & fire weather

- **Webhook** (`src/alerts/notify.ts`): when `ALERT_WEBHOOK_URL` is set and the
  run-alerts composite reaches **WARNING** or **EMERGENCY**, a JSON POST
  (`{severity, reason, assessedAt, source}`) is fired at that URL with a bounded
  timeout (`ALERT_WEBHOOK_TIMEOUT_MS`, default 5000). Fire-and-forget — a
  webhook failure never fails an alert run. Notification is a composite-level
  concern. Bounded retry/protocol receipts describe local acceptance; actual
  opted-in destination receipt/display remains in TODO.md (M07).
- **Fire weather (Red Flag)**: returned weather alerts are classified with
  `isRedFlag` and counted in `current.json`. This public forecast-zone request
  does not establish complete coverage of separate fire-weather zones or a
  successful current upstream check.

## Current-cycle execution and primary clocks

The real batch runner accepts canonical singleton/mixed subsets, rejects unknown
or empty selections, records a cycle UUID and current per-monitor attempts, and
preserves omitted producers' observation ages. A crashed producer or old current
file cannot contribute current severity. Fixture-backed singleton coverage uses
all canonical monitor keys rather than a second count ledger. Healer retry state
is durable through restart/backoff and distinguishes eligible retry from producer
execution and actual notification delivery.

`src/source_clocks.ts` declares each monitor's retrieval, observation or product
basis and maximum age. For observation/product families, missing, future or
expired primary evidence yields unknown/stale availability even after a fresh
fetch. AirNow and buoy observations, marine/smoke/drought/fuel products and AIS
positions retain their actual clocks and units. These policies do not prove
provider completeness, uncollected local geography or correctness of a model's
interpretation; source outages remain coverage facts.

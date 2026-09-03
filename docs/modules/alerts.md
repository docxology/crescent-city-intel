# Alert Monitors Module

Real-time natural hazard and environmental monitoring for Crescent City, CA.
8 independent monitors feed a composite severity scoring system and
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
| 6 | EPA Air Quality | `airnowapi.org` | `output/alerts/airquality/` | `alerts/epa_airnow.ts` |
| 7 | CAL FIRE Wildfire | `fire.ca.gov` | `output/alerts/wildfire/` | `alerts/calfire_wildfire.ts` |
| 8 | NDBC Marine Buoy | `ndbc.noaa.gov` | `output/alerts/marine/` | `alerts/ndbc_marine.ts` |

---

## `src/alerts/noaa_tsunami.ts` — NOAA Tsunami Alerts

Polls the NOAA Weather API for active tsunami warnings affecting the California coast, filters for Crescent City relevance, and saves to disk.

### Data Source

`GET https://api.weather.gov/alerts/active?area=CA`

Built via `URLSearchParams` so the `event` value is always properly
URL-encoded. **Fixed 2026-07-23**: the endpoint requires the query param to be
named `area` (not `region`), and an unencoded space in `Tsunami Warning`
previously caused `api.weather.gov` to return HTTP 400 on every run, silently
breaking the monitor.

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

Monitors National Weather Service alerts for the Northwest CA coastal zone (CAZ006).

### Data Source

`GET https://api.weather.gov/alerts/active?zone=CAZ006`

**Fixed 2026-07-23**: `zone` and `region` are mutually exclusive on
`api.weather.gov` — combining them (as this monitor previously did) returns
HTTP 400 on every run. `zone=CAZ006` alone (the Northwest CA coastal zone) is
correct and sufficient.

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

`GET https://api.tidesandcurrents.noaa.gov/api/v1/tide/...`

### Output

`output/tides/tides-<timestamp>.json` + `history.jsonl`

---

## `src/alerts/cdfw_fishing.ts` — CDFW Dungeness Crab Season

Tracks California's annual Dungeness crab season calendar and CDFW North Coast marine bulletins.

### Output

`output/fishing/fishing-status.json` + `history.jsonl`

---

## `src/alerts/epa_airnow.ts` — EPA AirNow Air Quality (v2.0)

Fetches real-time Air Quality Index (AQI) data from the EPA AirNow API for Crescent City (ZIP 95531).

### Data Source

`GET https://www.airnowapi.org/aq/observation/zipCode/current/`

### Prerequisites

`AIRNOW_API_KEY` env var (free at [airnowapi.org](https://airnowapi.org))

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `classifyAqi(aqi)` | `(number) → AirQualityLevel` | Classify AQI into 6 severity levels |
| `getAdvisory(level)` | `(AirQualityLevel) → string\|null` | Health advisory message |
| `fetchAirQuality(key?)` | `(string?) → Promise<AirQualityReport>` | Fetch from API |
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

## `src/alerts/calfire_wildfire.ts` — CAL FIRE Wildfire (v2.0)

Fetches active wildfire incidents from CAL FIRE for Del Norte County and surrounding areas (Siskiyou, Humboldt, Trinity).

### Data Source

`GET https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false`

The retired `fire.ca.gov/imap/imapdata/all` endpoint was blocked. The monitor
now uses the current official incident JSON endpoint and reports a valid
no-match regional result as `empty`.

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

## `src/alerts/ndbc_marine.ts` — NDBC Marine Buoy (v2.0)

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

## `src/alerts/severity.ts` — Composite alert severity

Aggregates all 14 alert monitors (8 core + 6 extended: drought, PSPS, smoke, roads, schools, NWS marine forecast) into a single composite severity level.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `computeAlertSeverity(...)` | `(14 monitor inputs) → AlertSeverityReport` | Composite severity assessment; an absent monitor is `available: false`, never a calm reading |

### Priority Order

`EMERGENCY > WARNING > WATCH > CALM`

The composite takes the highest severity across all monitors. Each monitor
contributes a `MonitorStatus` with level, summary, and count.

### API Endpoint

`GET /api/alerts/composite`

---

## `src/alerts/composite.ts` — Composite Input Shaping + Source Health (v2.0)

Pure helpers that keep `scripts/run-alerts.ts` thin: they shape the eight
per-monitor reports into the composite scorer's input and classify each
source's health after a run.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `buildCompositeInput({tsunami, earthquake, weather, airquality, wildfire, marine, tidesReport, fishingReport})` | `(object) → CompositeInput` | Normalize per-monitor reports (including the tides + fishing history-path reports) into `computeAlertSeverity` inputs |
| `buildTidesInput(report)` / `buildFishingInput(report)` | `(report) → MonitorStatus` | Shape the two report-only monitors into scorer inputs (re-exported by `scripts/run-alerts.ts` for backward-compatible test imports) |
| `classifySourceHealth(definition, settledResult, errors, checkedAt)` | `(...) → SourceHealth` | Map a settled monitor result to `ok` / `empty` / `unavailable` / `stale` with reason + item count |
| `isFreshReport(report, windowMs?)` | `(report, number?) → boolean` | Freshness gate (matches air/wildfire/marine): stale reports count as unavailable |

### Source-health classification

`ok` and `empty` count as **present**; `unavailable` and `stale` count as
**missing** — so source gaps surface as coverage metadata (GUI, Pages,
analytics, and pipeline envelopes all expose present/missing counts) instead
of failing the run.

---

## `src/alert_analytics.ts` — Alert Analytics (v2.0)

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

- **Non-throwing**: All public functions return gracefully on error
- **Persistent JSONL history**: All monitors append to `history.jsonl` for analytics
- **In-process deduplication**: Module-level `Set<string>` tracks processed IDs
- **import.meta.main**: Each file can be run directly via `bun run src/alerts/<file>.ts`
- **Composite severity**: `run-alerts.ts` runs all 14 monitors and computes the composite from all 14 — the five Phase-12 monitors (drought, PSPS, smoke, roads, schools) plus the NWS marine forecast (CWF PZZ450) feed it through `buildExtendedCompositeInput`

## Running

```bash
bun run alerts:tsunami      # NOAA tsunami
bun run alerts:earthquake   # USGS earthquake
bun run alerts:weather      # NWS weather
bun run alerts:tides        # NOAA tides
bun run alerts:fishing      # CDFW fishing
bun run alerts:airquality   # EPA AirNow (v2.0)
bun run alerts:wildfire     # CAL FIRE wildfire (v2.0)
bun run alerts:marine       # NDBC marine buoy (v2.0)
bun run alerts:marinezone  # NWS CWF marine forecast (PZZ450)
bun run alerts              # all 14 concurrently + composite severity
```

See [scripts/README.md](../../scripts/README.md) for cron setup.

Three layers count differently, by design: the runner / composite / health
layer covers all 14 monitors; `alert_analytics` `ALERT_TYPES` covers the 8
hazard-core families that keep `history.jsonl` in the analytics shape; and
`src/alert_correlation.ts` scans 13 sources (every monitor except
`marinezone`, which has no directional pair specs yet).

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
  webhook failure never fails an alert run. Per-monitor TODOs about "triggering
  notifications" are intentionally not wired: notification is a composite-level
  concern.
- **Fire weather (Red Flag)** is already covered by the `CAZ006` zone fetch; the
  NWS weather monitor now flags each alert with `isRedFlag` and reports
  `redFlagCount` in `current.json`, so Del Norte red-flag/warning conditions are
  surfaced without a separate monitor.

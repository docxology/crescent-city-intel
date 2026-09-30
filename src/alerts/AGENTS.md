# Agents Guide — `src/alerts/`

## Overview

Real-time alert monitors for natural hazards and environmental conditions
relevant to Crescent City, CA. **20** independent monitors (8 core + 12
extended) feed a composite severity scoring system and a unified alert
analytics timeline.

`MONITOR_KEYS` in `composite.ts` is the canonical roster. Every other list —
`CORE_MONITOR_SOURCE_NAMES`, `EXTENDED_MONITOR_SPECS`,
`ALERT_MONITOR_SOURCE_NAMES`, `CORRELATION_SOURCES`, `ALERT_TYPES`,
`EXPECTED_SOURCE_HEALTH`'s alert entries, `MONITOR_PRIORITY` — must derive from
it or be asserted against it. `tests/alert-source-roster.test.ts` enforces that,
including the hand-written monitor and icon maps in
`gui/static/index.html` (which cannot import it), because count/roster drift is
this repo's most recurrent defect class: it has produced an 8-of-14 analytics
list, a 13-of-14 correlation list, an 8-of-14 coverage contract, and two spec
rows naming fields that do not exist on the monitors they describe. The release
gate only checks supersets in either direction, so an omission cannot fail CI on
its own.

## Convention

- All modules **export** their primary monitoring function so `scripts/` can import them.
- All modules support `import.meta.main` for direct `bun run` invocation.
- Alert data is persisted to `output/alerts/<type>/` as JSON (except tides → `output/tides/`, fishing → `output/fishing/`).
- All functions return gracefully (no throws) — errors are logged and an empty result returned.
- **A monitor that could not check must return `null`, not an empty report.** For every key in `NULL_ON_FAILURE_MONITORS` the runner reads `null` as "unavailable source". Returning an empty-but-successful report makes an outage indistinguishable from a clear day, and `empty` counts as *present* coverage, so the failure is invisible on every surface. Total NDBC outage, a failed CDFW fetch, and partial Caltrans route coverage all return `null` for exactly this reason.
- **Every report interface carries a `timestamp` (or `fetchedAt`), and every `current.json` carries a `level` and a `summary`.** `isFreshReport` reads `fetchedAt ?? timestamp` and treats a report with neither as **stale forever** — a monitor missing its timestamp reads as missing coverage and lands in the healer's permanent retry roster even on a fully successful run. The GUI's per-monitor tile renders `summary ?? level ?? 'Data available'`, so a report missing both shows a permanent clean bill of health; derive both from the same inputs the composite uses, so the tile and the headline cannot disagree.
- Use `computeSha256` from `../utils.ts` for deduplication hashing.
- Use `createLogger('module_name')` from `../logger.ts` for all logging.
- Persistent JSONL history at `output/alerts/<type>/history.jsonl` for analytics.

## Modules

| File | Export | Output dir | Data source |
| :--- | :--- | :--- | :--- |
| `noaa_tsunami.ts` | `monitorNOAATsunamiAlerts()` | `output/alerts/tsunami/` | `api.weather.gov` REST JSON |
| `usgs_earthquake.ts` | `monitorUSGSEarthquakeAlerts()` | `output/alerts/earthquake/` | `earthquake.usgs.gov` GeoJSON feed |
| `nws_weather.ts` | `monitorNWSWeatherAlerts()` | `output/alerts/weather/{advisory,watch,warning}/` | `api.weather.gov` REST JSON |
| `noaa_tides.ts` | `monitorTides()` | `output/tides/` | NOAA CO-OPS station 9419750 |
| `cdfw_fishing.ts` | `monitorFishing()`, `estimateCrabSeasonStatus()` | `output/fishing/` | CDFW marine bulletins |
| `epa_airnow.ts` | `runAirQualityMonitor()` | `output/alerts/airquality/` | EPA AirNow API (requires `AIRNOW_API_KEY`) |
| `calfire_wildfire.ts` | `runWildfireMonitor()` | `output/alerts/wildfire/` | CAL FIRE incident API |
| `ndbc_marine.ts` | `runMarineMonitor()` | `output/alerts/marine/` | NDBC buoy realtime data |
| `nws_marine.ts` | `runMarineZoneMonitor()` | `output/alerts/marinezone/` | NWS CWF text product (KEKA), zone PZZ450 |
| `usdm_drought.ts` | `runDroughtMonitor()` | `output/alerts/drought/` | US Drought Monitor (Del Norte FIPS 06015) |
| `pge_psps.ts` | `runPSPSMonitor()` | `output/alerts/psps/` | Official browser-rendered PG&E PSPS events page |
| `hrrr_smoke.ts` | `runSmokeMonitor()` | `output/alerts/smoke/` | NOAA HMS smoke polygons |
| `caltrans_roads.ts` | `runRoadClosureMonitor()` | `output/alerts/roads/` | `roads.dot.ca.gov` per-route text; all configured routes must be checked |
| `dusd_schools.ts` | `runSchoolClosureMonitor()` | `output/alerts/schools/` | Del Norte USD news/announcements |
| `uscg_broadcasts.ts` | `runUscgBroadcastMonitor()` | `output/alerts/uscg/` | USCG NAVCEN District 11 Broadcast Notice to Mariners listing |
| `permits.ts` | `runPermitsMonitor()` | `output/alerts/permits/` | City of Crescent City MyGov public portal permit catalog (issued-permit register is login-gated and is NOT read) |
| `dredging.ts` | `runDredgingMonitor()` | `output/alerts/dredging/` | Crescent City Harbor District sitemap.xml with a dredging / marine-construction keyword filter |
| `fuel.ts` | `runFuelMonitor()` | `output/alerts/fuel/` | EIA weekly California all-formulations retail gasoline price (statewide observed average) |
| `pacfin.ts` | `runPacfinMonitor()` | `output/alerts/pacfin/` | PacFIN (PSMFC) public report catalog (embedded APEX tree JSON; landing figures are credential-gated and are NOT read) |
| `ais.ts` | `runAisMonitor()` | `output/alerts/ais/` | Open-AIS FeatureCollection feed (`AIS_FEED_URL` env; default keyless digitraffic), Del Norte watch-box filter |
| `severity.ts` | `computeAlertSeverity()` | (computed) | Aggregates all 20 monitors (8 core + 12 extended) |
| `composite.ts` | `buildCompositeInput()`, `buildExtendedCompositeInput()`, `classifySourceHealth()`, `isFreshReport()` | (computed) | Pure composite-input shaping + source-health classification for `scripts/run-alerts.ts` |
| `healer.ts` | `runHealingCycle()` | `output/state/healer-state.json` | Per-monitor failure tracking + backoff scheduling |
| `notify.ts` | `maybeSendSeverityWebhook()` | (webhook) | Optional `ALERT_WEBHOOK_URL` POST on a tier **transition** into WARNING/EMERGENCY |

## Key Patterns

- **In-process deduplication**: a module-level `Set<string>` tracks processed IDs; restart clears it (intentional — always re-checks on startup).
- **Persistent JSONL history**: all monitors append to `history.jsonl` for alert analytics.
- **Crescent City relevance filter**: each module filters alerts by `areaDesc` keyword matching and/or bounding-box / point-in-polygon geometry checks.
- **Severity categorization**: NWS categorizes alerts into `advisory`, `watch`, `warning`; USGS uses magnitude + tsunami flag; AQI uses 6-level classification; wildfire uses evac orders + fire size; marine uses wave/wind thresholds.
- **Composite severity**: `severity.ts` aggregates all 20 monitors (8 core + 12 extended) into CALM → EMERGENCY; `composite.ts` shapes the per-monitor inputs + classifies source health so the runner stays thin. Ties at the same tier break on `MONITOR_PRIORITY` (tsunami → earthquake → wildfire → weather → marinezone → roads → schools → psps → marine → tides → smoke → fishing → airQuality → drought → uscg → permits/dredging/fuel/pacfin/ais), not on the `monitors` literal's declaration order — a chronic drought must not take the headline slot ahead of a school closure.
- **Freshness**: one window for all monitors, `ALERT_FRESHNESS_WINDOW_MS` (default 1 hour). It used to be a hardcoded constant the env could not reach, while the non-alert families had a separate 24-hour one, so a report could be `ok` under one policy and `stale` under the other and the stricter was untunable. The extended monitors were not gated at all, so a day-old drought snapshot scored as current.
- **High-severity webhook**: `notify.ts` fires `ALERT_WEBHOOK_URL` when the composite *transitions into* WARNING/EMERGENCY (bounded by `ALERT_WEBHOOK_TIMEOUT_MS`); fire-and-forget so a failure never fails an alert run. The last-notified level is persisted at `output/state/alert-webhook-level.json`, so a persistently-WARNING composite notifies **once**, not on every run — a notifier that always fires trains the operator to ignore it. A drop below the threshold clears the memory, so a later rise notifies again.
- **Healer scope**: `healer.ts` identifies and schedules; `scripts/run-alerts.ts` owns the batch. A monitor in `monitorsRetried` is *eligible for retry* on its backoff window, not already re-run by the healer.
- **GeoJSON output**: USGS saves both raw properties and a `Feature` GeoJSON object for GIS tooling.

## Running Individually

```bash
bun run alerts:tsunami      # noaa_tsunami.ts
bun run alerts:earthquake   # usgs_earthquake.ts
bun run alerts:weather      # nws_weather.ts
bun run alerts:tides        # noaa_tides.ts
bun run alerts:fishing      # cdfw_fishing.ts
bun run alerts:airquality   # epa_airnow.ts
bun run alerts:wildfire     # calfire_wildfire.ts
bun run alerts:marine       # ndbc_marine.ts
bun run alerts:marinezone   # nws_marine.ts (CWF PZZ450)
bun run alerts:uscg         # uscg_broadcasts.ts
bun run alerts:permits      # permits.ts (MyGov public portal)
bun run alerts:dredging     # dredging.ts (harbor sitemap)
bun run alerts:fuel         # fuel.ts (EIA weekly CA retail gasoline)
bun run alerts:pacfin       # pacfin.ts (PacFIN public report catalog)
bun run alerts:ais          # ais.ts (open-AIS feed, watch-box filter)
bun run alerts:all          # all 20 concurrently + composite severity (scripts/run-alerts.ts)
```

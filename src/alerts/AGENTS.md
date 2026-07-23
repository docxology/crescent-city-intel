# Agents Guide — `src/alerts/`

## Overview

Real-time alert monitors for natural hazards and environmental conditions
relevant to Crescent City, CA. 8 independent monitors feed a composite
severity scoring system and unified alert analytics timeline.

## Convention

- All modules **export** their primary monitoring function so `scripts/` can import them.
- All modules support `import.meta.main` for direct `bun run` invocation.
- Alert data is persisted to `output/alerts/<type>/` as JSON (except tides → `output/tides/`, fishing → `output/fishing/`).
- All functions return gracefully (no throws) — errors are logged and an empty result returned.
- Use `computeSha256` from `../utils.ts` for deduplication hashing.
- Use `createLogger('module_name')` from `../logger.ts` for all logging.
- Persistent JSONL history at `output/alerts/<type>/history.jsonl` for analytics.

## Modules

| File | Export | Output dir | Data source |
| :--- | :--- | :--- | :--- |
| `noaa_tsunami.ts` | `monitorNOAATsunamiAlerts()` | `output/alerts/tsunami/` | `api.weather.gov` REST JSON |
| `usgs_earthquake.ts` | `monitorUSGSEarthquakeAlerts()` | `output/alerts/earthquake/` | `earthquake.usgs.gov` GeoJSON feed |
| `nws_weather.ts` | `monitorNWSWeatherAlerts()` | `output/alerts/weather/{advisory,watch,warning}/` | `api.weather.gov` REST JSON |
| `noaa_tides.ts` | (runs on import) | `output/tides/` | NOAA CO-OPS station 9419750 |
| `cdfw_fishing.ts` | `monitorFishing()`, `estimateCrabSeasonStatus()` | `output/fishing/` | CDFW marine bulletins |
| `epa_airnow.ts` | `runAirQualityMonitor()` | `output/alerts/airquality/` | EPA AirNow API (requires `AIRNOW_API_KEY`) |
| `calfire_wildfire.ts` | `runWildfireMonitor()` | `output/alerts/wildfire/` | CAL FIRE incident API |
| `ndbc_marine.ts` | `runMarineMonitor()` | `output/alerts/marine/` | NDBC buoy realtime data |
| `severity.ts` | `computeAlertSeverity()` | (computed) | Aggregates all 8 monitors |

## Key Patterns

- **In-process deduplication**: a module-level `Set<string>` tracks processed IDs; restart clears it (intentional — always re-checks on startup).
- **Persistent JSONL history**: all monitors append to `history.jsonl` for alert analytics.
- **Crescent City relevance filter**: each module filters alerts by `areaDesc` keyword matching and/or bounding-box / point-in-polygon geometry checks.
- **Severity categorization**: NWS categorizes alerts into `advisory`, `watch`, `warning`; USGS uses magnitude + tsunami flag; AQI uses 6-level classification; wildfire uses evac orders + fire size; marine uses wave/wind thresholds.
- **Composite severity**: `severity.ts` aggregates all 8 monitors into CALM → EMERGENCY.
- **GeoJSON output**: USGS saves both raw properties and a `Feature` GeoJSON object for GIS tooling.

## Running Individually

```bash
bun run alerts:tsunami      # noaa_tsunami.ts
bun run alerts:earthquake   # usgs_earthquake.ts
bun run alerts:weather      # nws_weather.ts
bun run alerts:tides        # noaa_tides.ts
bun run alerts:fishing      # cdfw_fishing.ts
bun run alerts:airquality   # epa_airnow.ts (v2.0)
bun run alerts:wildfire     # calfire_wildfire.ts (v2.0)
bun run alerts:marine       # ndbc_marine.ts (v2.0)
bun run alerts              # all 8 concurrently + composite severity (scripts/run-alerts.ts)
```

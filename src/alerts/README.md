# Alert Monitors — `src/alerts/`

Real-time hazard monitoring for Crescent City, CA.

## Monitors

| Monitor | Source | Filters |
| :--- | :--- | :--- |
| **NOAA Tsunami** (`noaa_tsunami.ts`) | [api.weather.gov](https://api.weather.gov/alerts/active?event=Tsunami%20Warning&area=CA) | `Actual` + `Alert` msgType, Crescent City / Del Norte area |
| **USGS Earthquake** (`usgs_earthquake.ts`) | [earthquake.usgs.gov](https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson) | Within 200 km of 41.7485°N, 124.2028°W; ≥ M4.0 |
| **NWS Weather** (`nws_weather.ts`) | [api.weather.gov CAZ006](https://api.weather.gov/alerts/active?zone=CAZ006) | Northwest CA coastal zone; advisory / watch / warning categorized |

> **Fixed 2026-07-23**: the tsunami URL previously used an unencoded space in
> `Tsunami Warning` and the wrong query param name (`region` instead of
> `area`); the weather URL previously combined `region=CA` and `zone=CAZ006`,
> which `api.weather.gov` rejects. Both returned HTTP 400 on every run until
> fixed. This table also only lists the original 3 monitors — see
> [`docs/modules/alerts.md`](../../docs/modules/alerts.md) for the current
> 8-monitor inventory (adds NOAA Tides, CDFW Fishing, EPA AirNow, CAL FIRE
> Wildfire, NDBC Marine).

## Output

```text
output/
  alerts/
    tsunami/          # one JSON per NOAA alert batch
    earthquake/       # one JSON + GeoJSON feature per earthquake
    weather/
      advisory/       # categorized by severity
      watch/
      warning/
```

## Usage

```bash
bun run alerts:tsunami
bun run alerts:earthquake
bun run alerts:weather
bun run alerts             # all three concurrently
```

See [scripts/README.md](../../scripts/README.md) for cron setup.

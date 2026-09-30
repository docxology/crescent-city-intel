# Alert Monitors — `src/alerts/`

Hazard and civic monitoring for Crescent City, CA. The canonical roster is
`MONITOR_KEYS` in `composite.ts`: 20 monitors (8 core + 12 extended).

## Monitors

| Monitor | Source | Filters |
| :--- | :--- | :--- |
| **NOAA Tsunami** (`noaa_tsunami.ts`) | [api.weather.gov](https://api.weather.gov/alerts/active?area=CA) | `Actual` + `Alert` msgType, tsunami Warning/Watch/Advisory, Crescent City / Del Norte area |
| **USGS Earthquake** (`usgs_earthquake.ts`) | [earthquake.usgs.gov](https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson) | Within 200 km of 41.7485°N, 124.2028°W; ≥ M4.0 |
| **NWS Weather** (`nws_weather.ts`) | [api.weather.gov CAZ006](https://api.weather.gov/alerts/active?zone=CAZ006) | Northwest CA coastal zone; advisory / watch / warning categorized |

This table introduces three alert sources. See
[`AGENTS.md`](AGENTS.md) and
[`docs/modules/alerts.md`](../../docs/modules/alerts.md) for the full roster,
source boundaries, freshness policy, and composite severity contract.

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
bun run alerts             # all 20 monitors concurrently + composite severity
```

See [scripts/README.md](../../scripts/README.md) for cron setup.
